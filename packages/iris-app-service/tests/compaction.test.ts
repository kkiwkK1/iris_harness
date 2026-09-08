/**
 * Compaction: the span selection, the durable record, and the one thing the
 * whole feature is for — the compacted floors stop reaching the model while
 * staying in the conversation.
 *
 * @module @iris/app-service/tests/compaction
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { HistoryEntry } from '@iris/pipeline'
import type { SillyTavernChatHeader } from '@iris/persistence'
import type { ChatCompaction, IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import {
  applyCompaction,
  compactionSpec,
  COMPACTION_FIELD,
  DEFAULT_RETAIN_RATIO,
  DEFAULT_THRESHOLD_RATIO,
  frameSummary,
  historyTokens,
  rawCoverage,
  readCompaction,
  selectCompactableSpan,
  SummaryNotSmallerError,
  writeCompaction,
} from '../src/compaction.ts'
import { COMPACTION_INSTRUCTION, SUMMARY_OPEN_TAG } from '../src/compaction-prompt.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import type { ChatStore } from '../src/chats.ts'

/** One character per token, so a fixture's costs are its lengths. */
const count = (text: string): number => text.length

/**
 * History entries whose token cost is their text length.
 * @param costs - one cost per floor, oldest first.
 * @returns the entries.
 */
function floors(...costs: readonly number[]): HistoryEntry[] {
  return costs.map((cost, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: 'x'.repeat(cost),
    ...index === 0 ? { pinned: true as const } : {},
  }))
}

/**
 * A stored record.
 * @param over - fields to override.
 * @returns the record.
 */
function record(over: Partial<ChatCompaction> = {}): ChatCompaction {
  return {
    count: 4,
    summary: 'the scene so far',
    spanTokens: 400,
    summaryTokens: 40,
    at: 1_700_000_000_000,
    model: 'test-model',
    ...over,
  }
}

// --------------------------------------------------------------- the policy

test('the two ratios are the harness’s, and scale onto the available budget', () => {
  // Transcribed values, asserted because they are the transcription: the
  // harness's `DEFAULT_THRESHOLD_RATIO` and `DEFAULT_RETAIN_RATIO`.
  assert.equal(DEFAULT_THRESHOLD_RATIO, 0.8)
  assert.equal(DEFAULT_RETAIN_RATIO, 0.16)
  // Against `context - reserve`, which is the caller's job to pass — and the
  // deliberate departure from the harness, whose threshold is against the
  // whole window. `compaction.ts` says why: the assembler's reserve means a
  // threshold on the window can sit above the point the trimmer starts
  // dropping floors, and dropping a floor is what this replaces.
  assert.deepEqual(compactionSpec(10_000), { thresholdTokens: 8000, retainTokens: 1600 })
})

test('a budget too small for the policy to be satisfiable says so', () => {
  // Flooring collapses the two together long before this, and a spec whose
  // retention is at or above its threshold asks for a compaction that fires
  // and then has nothing to keep. The harness rejects the same condition at
  // plugin load (`validateRatioRetention`).
  assert.equal(compactionSpec(0), null)
  assert.equal(compactionSpec(-1), null)
  assert.equal(compactionSpec(Number.NaN), null)
  const tiny = compactionSpec(1)
  assert.equal(tiny, null, 'floor(0.8) and floor(0.16) are both 0 here')
})

// ------------------------------------------------------- selecting the span

test('the span is everything before the retained tail is paid for', () => {
  // Costs, oldest first: 100 100 100 100 50 50. Walking from the newest end,
  // 50 + 50 + 100 = 200 pays a 200-token tail at index 3, so floors 0..2 are
  // the span.
  const history = floors(100, 100, 100, 100, 50, 50)
  assert.equal(selectCompactableSpan(history, 200, count), 3)
  // A larger tail keeps more verbatim and compacts less.
  assert.equal(selectCompactableSpan(history, 400, count), 1)
})

test('retention zero keeps exactly the newest floor — the manual case', () => {
  const history = floors(100, 100, 100, 100)
  assert.equal(
    selectCompactableSpan(history, 0, count),
    3,
    'the loop pays for the newest entry on its first pass and stops, as the harness’s does',
  )
})

test('nothing is compactable when the tail budget covers the whole conversation', () => {
  const history = floors(100, 100)
  assert.equal(selectCompactableSpan(history, 1000, count), null)
  assert.equal(selectCompactableSpan(floors(100), 0, count), null, 'one floor is not a span plus a tail')
  assert.equal(selectCompactableSpan([], 0, count), null)
})

test('a span chosen over an existing summary converts back to raw floors', () => {
  // The selection runs over what the model currently sees, whose first entry
  // stands for `previous.count` real floors. Getting this wrong is invisible —
  // the conversation still reads correctly and the record just claims the
  // wrong span, which the next compaction then compounds.
  assert.equal(rawCoverage(3, undefined), 3)
  assert.equal(rawCoverage(3, record({ count: 10 })), 12, '10 already folded, plus 2 more of the 3 chosen')
  assert.equal(rawCoverage(1, record({ count: 10 })), 10, 'only the summary itself: nothing new folds in')
})

test('history costs are summed with the caller’s counter', () => {
  assert.equal(historyTokens(floors(3, 4, 5), count), 12)
  assert.equal(historyTokens([], count), 0)
})

// --------------------------------------------------- substituting the summary

test('the summary replaces the span and nothing else', () => {
  const history = floors(10, 20, 30, 40, 50)
  const applied = applyCompaction(history, record({ count: 3, summary: 'SO FAR' }))
  assert.equal(applied.length, 3, 'one summary plus the two floors it did not cover')
  assert.equal(applied[0]?.role, 'system')
  assert.equal(applied[0]?.pinned, true, 'the trimmer drops from the oldest end, and this IS the oldest end')
  assert.match(applied[0]?.text ?? '', /SO FAR/)
  assert.match(applied[0]?.text ?? '', new RegExp(SUMMARY_OPEN_TAG))
  assert.deepEqual(applied.slice(1), history.slice(3), 'the retained floors are untouched, pins included')
})

test('no record leaves the conversation exactly as it was', () => {
  const history = floors(10, 20, 30)
  assert.deepEqual(applyCompaction(history, undefined), history)
  assert.deepEqual(applyCompaction([], record()), [])
})

test('a stale count is clamped so at least one floor stays verbatim', () => {
  // A reader who deletes a covered floor leaves the count one too large. The
  // clamp costs them one over-compacted turn; an unclamped slice would hand
  // the model a conversation with no present in it.
  const history = floors(10, 20)
  const applied = applyCompaction(history, record({ count: 9 }))
  assert.equal(applied.length, 2)
  assert.equal(applied[0]?.role, 'system')
  assert.deepEqual(applied[1], history[1])
})

test('the framing carries the tags a later compaction recognises', () => {
  const framed = frameSummary('  the scene  ')
  assert.match(framed, /<compacted-summary>\nthe scene\n<\/compacted-summary>$/)
  // Without this the next compaction quotes the previous checkpoint inside
  // itself and the summary grows monotonically — the one failure that defeats
  // the whole feature.
  assert.match(COMPACTION_INSTRUCTION, new RegExp(SUMMARY_OPEN_TAG))
  assert.match(COMPACTION_INSTRUCTION, /PRIOR checkpoint/)
})

test('the shrink guard names both figures', () => {
  const error = new SummaryNotSmallerError(500, 400)
  assert.match(error.message, /500/)
  assert.match(error.message, /400/)
  assert.equal(error.summaryTokens, 500)
  assert.equal(error.spanTokens, 400)
})

// --------------------------------------------------------------- the record

test('the record round-trips through a chat header, top level', () => {
  const header = { user_name: 'u', character_name: 'c', create_date: 'd', chat_metadata: {} } as SillyTavernChatHeader
  writeCompaction(header, record({ count: 7 }))
  // The home, asserted because the two obvious alternatives lose it silently:
  // `extra` is swapped wholesale by a swipe in SillyTavern, and
  // `chat_metadata` is replaced wholesale by any card that saves metadata.
  assert.ok(COMPACTION_FIELD in header)
  assert.deepEqual(header.chat_metadata, {}, 'the record must not be inside chat_metadata')
  assert.deepEqual(readCompaction(header)?.count, 7)
})

test('a malformed record degrades to no compaction rather than poisoning the arithmetic', () => {
  const base = { user_name: 'u', character_name: 'c', create_date: 'd', chat_metadata: {} }
  const cases: readonly [string, unknown][] = [
    ['absent', undefined],
    ['not an object', 'yes'],
    ['count as text', { ...record(), count: '4' }],
    ['count fractional', { ...record(), count: 1.5 }],
    ['count zero', { ...record(), count: 0 }],
    ['empty summary', { ...record(), summary: '   ' }],
    ['no model', { ...record(), model: undefined }],
    ['costs as text', { ...record(), spanTokens: '400' }],
  ]
  for (const [why, value] of cases) {
    const header = { ...base, [COMPACTION_FIELD]: value } as unknown as SillyTavernChatHeader
    assert.equal(readCompaction(header), undefined, `a record that is ${why} must read as absent`)
  }
})

// ----------------------------------------------------- through the service

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A archivist.',
    first_mes: 'The shelves are quiet tonight.',
    personality: '',
    scenario: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  /** Every request the fake provider was handed, in order. */
  seen: GenerateOptions[]
  /** Resolve after the next `stream.end`. */
  settled: () => Promise<void>
  dir: string
}

/**
 * A service whose provider answers with a fixed reply and records its requests.
 * @param t - the test context, for cleanup.
 * @param summary - what the provider answers a summarization call with.
 * @returns the fixture.
 */
async function fixture(t: TestContext, summary = SHORT_SUMMARY): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-compaction-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const seen: GenerateOptions[] = []
  let ends = 0
  let waited = 0

  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    // A summarization call is the one whose last message is the instruction.
    const last = options.messages.at(-1)
    const isSummary = JSON.stringify(last?.content ?? '').includes('compaction engine')
    const text = isSummary ? summary : 'The archivist says something.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const handlers = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    handlers,
    chats,
    seen,
    dir,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** Short enough to pass the shrink guard against the fixture's history. */
const SHORT_SUMMARY = 'They met in the archive. She is guarded; he is looking for one book.'

/**
 * Open a chat and play a few exchanges into it.
 * @param f - the fixture.
 * @param turns - how many user lines to send.
 * @returns the chat id.
 */
async function played(f: Fixture, turns: number): Promise<string> {
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  for (let at = 0; at < turns; at += 1) {
    await f.handlers['chat.send']({
      chatId: view.chatId,
      kind: 'send',
      text: `Line ${String(at)}: ${'the reader says something at length. '.repeat(6)}`,
    })
    await f.settled()
  }
  return view.chatId
}

test('a manual compaction folds every floor but the newest, and keeps them all in the file', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)
  const before = (await f.chats.open(chatId)).toView().messages.length

  const answer = await f.handlers['chat.compact']({ chatId })
  assert.ok(answer.compacted !== null, 'there was history to compact')
  assert.ok(answer.compacted.floors > 0)
  assert.ok(
    answer.compacted.summaryTokens < answer.compacted.spanTokens,
    'a summary that is not smaller would lower nothing',
  )

  // The point of the whole feature, stated as two assertions that must both
  // hold: the conversation is unchanged, and the request is not.
  assert.equal(
    answer.view.messages.length,
    before,
    'no message may be deleted — this is what makes a compacted chat still a chat in SillyTavern',
  )
  assert.equal(answer.view.compaction?.count, before - 1)

  const file = await readFile(join(f.dir, 'chats', `${chatId}.jsonl`), 'utf8')
  const header = JSON.parse(file.split('\n')[0] as string) as Record<string, unknown>
  assert.ok(COMPACTION_FIELD in header, 'the record must be on disk, or a reopen re-sends the span')
  assert.equal(file.trim().split('\n').length, before + 1, 'header plus every floor')
})

test('after a compaction the model is sent the summary instead of the span', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)
  await f.handlers['chat.compact']({ chatId })
  const beforeCount = f.seen.length

  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'And then?' })
  await f.settled()
  const request = f.seen[beforeCount]
  assert.ok(request !== undefined, 'the turn should have reached the provider')
  const wire = JSON.stringify(request.messages)

  assert.match(wire, new RegExp(SUMMARY_OPEN_TAG), 'the summary must be in the request')
  assert.ok(
    !wire.includes('Line 0'),
    'the first floor was compacted, so its text must not reach the model any more',
  )
  assert.ok(wire.includes('And then?'), 'the newest floor still goes verbatim')
})

test('the preview and the real request agree about the compaction', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)
  await f.handlers['chat.compact']({ chatId })
  // Both go through the one substitution point (`#history`), which is what
  // stops the capacity meter reporting a fullness the next request will not
  // have. The itemization's history row is the figure that moves.
  const { itemization } = await f.handlers['prompt.itemize']({ chatId })
  const history = itemization.entries.find(entry => entry.kind === 'history')
  assert.ok(history !== undefined)
  const entry = await f.chats.open(chatId)
  const summary = entry.toView().compaction
  assert.ok(summary !== undefined)
  assert.ok(
    history.tokens < summary.spanTokens + 100,
    `the history row (${String(history.tokens)}) should reflect the summary, not the span it replaced`,
  )
})

test('a second compaction merges the first rather than nesting it', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)
  const first = await f.handlers['chat.compact']({ chatId })
  assert.ok(first.compacted !== null)
  const firstCount = first.view.compaction?.count ?? 0

  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'One more exchange, at some length.' })
  await f.settled()
  const before = f.seen.length
  const second = await f.handlers['chat.compact']({ chatId })

  assert.ok(second.compacted !== null, 'there are new floors, so there is something to compact')
  assert.ok((second.view.compaction?.count ?? 0) > firstCount, 'the span grows, head-anchored')
  // The summarizer is shown the previous checkpoint, so the instruction's
  // merge rule has something to act on — and the span is replayed rather than
  // a fresh system prompt being invented for it.
  const call = f.seen[before]
  assert.ok(call !== undefined)
  const wire = JSON.stringify(call.messages)
  assert.match(wire, new RegExp(SUMMARY_OPEN_TAG), 'the prior checkpoint must be in the replay')
  assert.ok(wire.includes('compaction engine'), 'the instruction is the final user message')
})

test('a summary that is not smaller is refused, and nothing is written', async (t) => {
  // Longer than the history it would replace, which is the one thing a
  // replacement may not be: it would lower nothing and the next turn would ask
  // again. The harness fails closed here too.
  const f = await fixture(t, 'x'.repeat(20_000))
  const chatId = await played(f, 3)
  await assert.rejects(
    f.handlers['chat.compact']({ chatId }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /not smaller/)
      return true
    },
  )
  const entry = await f.chats.open(chatId)
  assert.equal(entry.toView().compaction, undefined, 'a failed compaction leaves the conversation alone')
})

test('a conversation with nothing to compact answers rather than refusing', async (t) => {
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  // One floor: the greeting. There is no span plus a tail here.
  const answer = await f.handlers['chat.compact']({ chatId: view.chatId })
  assert.equal(answer.compacted, null)
  assert.equal(answer.view.compaction, undefined)
})

test('a request over the threshold compacts itself before it is sent', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)

  // The trigger reads the itemization this host already records for every real
  // turn, so the way to reach it is to shrink the budget under the request
  // that was just recorded rather than to send a hundred more floors. That is
  // the same arithmetic a reader meets when they switch to a preset tuned for
  // a 4095-token window (a real one, measured on this machine's install).
  const { itemization } = await f.handlers['prompt.itemize']({ chatId, turn: 2 })
  assert.equal(itemization.preview, false, 'the trigger needs a record, not a preview')
  const context = Math.floor(itemization.tokens / DEFAULT_THRESHOLD_RATIO) + itemization.budget.reserve - 200
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: context } })

  const before = f.seen.length
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Carry on.' })
  await f.settled()

  const entry = await f.chats.open(chatId)
  assert.ok(entry.toView().compaction !== undefined, 'the turn should have compacted on its way out')
  // First the compaction, then the turn — 「先做再发」. The order is what makes
  // the summary reach the request that triggered it rather than the one after.
  const summarize = f.seen[before]
  const turn = f.seen[before + 1]
  assert.ok(summarize !== undefined && turn !== undefined)
  assert.ok(
    JSON.stringify(summarize.messages).includes('compaction engine'),
    'the first call out must be the summarization',
  )
  assert.match(JSON.stringify(turn.messages), new RegExp(SUMMARY_OPEN_TAG))
})

test('a request under the threshold is sent untouched', async (t) => {
  /*
   * The control for the test above, and it took a teeth check to get right.
   *
   * The first version left the budget at its default, where the conversation
   * is so far under the retained tail that `selectCompactableSpan` finds
   * nothing — so deleting the threshold check entirely still produced no
   * compaction and the control stayed green while asserting nothing about the
   * threshold. **A healthy sample cannot show the bug.** The budget here is
   * sized so the request sits at about half the available budget: comfortably
   * over the 16% tail, so a span exists and the threshold is the only thing
   * that declines to compact it.
   */
  const f = await fixture(t)
  const chatId = await played(f, 3)
  const { itemization } = await f.handlers['prompt.itemize']({ chatId, turn: 2 })
  const spec = compactionSpec(itemization.tokens * 2)
  assert.ok(spec !== null)
  assert.ok(
    itemization.tokens > spec.retainTokens,
    `the request (${String(itemization.tokens)}) must exceed the tail budget `
    + `(${String(spec.retainTokens)}) or this control cannot see the threshold`,
  )
  assert.ok(itemization.tokens < spec.thresholdTokens)
  await f.handlers['settings.set']({
    chatId,
    settings: { contextWindow: itemization.tokens * 2 + itemization.budget.reserve },
  })

  const before = f.seen.length
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Carry on.' })
  await f.settled()
  assert.equal(f.seen.length, before + 1, 'one call: the turn, and no summarization')
  assert.equal((await f.chats.open(chatId)).toView().compaction, undefined)
})

test('the in-context floor number counts the floors the summary stands for', async (t) => {
  /*
   * `{{firstIncludedMessageId}}` — upstream's `chat_metadata.lastInContextMessageId`
   * — is macro-visible, so a card can read it. `droppedHistory` counts drops
   * from the conversation the assembler was handed, which after a compaction
   * starts with a summary standing for `count` real floors; without the offset
   * the macro names a floor that is in the request only as a sentence inside
   * the summary.
   *
   * Added after a teeth check: removing the offset left the whole suite green.
   */
  const f = await fixture(t)
  const chatId = await played(f, 3)
  const compacted = await f.handlers['chat.compact']({ chatId })
  assert.ok(compacted.compacted !== null)
  const covered = compacted.view.compaction?.count ?? 0
  assert.ok(covered > 0)

  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'And then?' })
  await f.settled()
  const entry = await f.chats.open(chatId)
  assert.equal(
    entry.firstIncludedMessageId,
    covered,
    'the first verbatim floor is the one after the compacted span, not floor 0',
  )
})

test('a conversation with no record yet is never compacted automatically', async (t) => {
  // The reading is the previous request's itemization, and a chat that has not
  // generated in this process has none. Refused rather than substituted with
  // the provider's reported prompt size: that is a different measurement of a
  // different assembly, and picking between them per call would make the
  // trigger fire at two different fullnesses.
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  await f.handlers['settings.set']({ chatId: view.chatId, settings: { contextWindow: 1100 } })
  const before = f.seen.length
  await f.handlers['chat.send']({ chatId: view.chatId, kind: 'send', text: 'Hello.' })
  await f.settled()
  assert.equal(f.seen.length, before + 1, 'no summarization call, because there was no reading')
})

test('the open view carries the budget the assembly runs under', async (t) => {
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const opened = await f.handlers['chat.open']({ chatId: view.chatId })
  // The composer's capacity capsule divides by these two, and they have to be
  // the ones the assembler used — the itemization is the other reading of the
  // same pair, and a surface dividing by two different denominators is the
  // failure this agreement prevents.
  const { itemization } = await f.handlers['prompt.itemize']({ chatId: view.chatId })
  // The two *numbers*, not the whole object: the view's budget also names where
  // its window came from and the itemization's does not, so a deep-equal here
  // fails the moment that provenance is added — a correct change, and never
  // what this test was about.
  assert.equal(opened.view.budget?.context, itemization.budget.context, 'the two windows disagree')
  assert.equal(opened.view.budget?.reserve, itemization.budget.reserve, 'the two reserves disagree')
  // And the provenance is on the view, with the answer this fixture's settings
  // make true: nothing has set a window, so the host composition's value is in
  // force.
  assert.equal(opened.view.budget?.source, 'host', 'the view does not say where its window came from')
})
