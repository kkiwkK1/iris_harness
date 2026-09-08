import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'
import { DEFAULT_THRESHOLD_RATIO, compactionSpec, frameSummary, summaryEntry } from '../src/compaction.ts'

/**
 * The conversation part of the request must not change behind the newest
 * exchange — whichever generation asked for it.
 *
 * `assembly-determinism.test.ts` pins "one state, assembled twice, same bytes".
 * This file pins the other half: **different generation paths reading the same
 * stored conversation must project it to the same bytes.** A send, a reroll, a
 * swipe, a continue, an impersonation and a card's own `script.generate` all
 * build a request out of the same floors, and any one of them that renders a
 * floor differently — a name prefix, a role, a separator, a squash that merged
 * on one path and not the other — costs a prefix miss on the *next* request as
 * well, because the cached copy and the new one then disagree about text
 * neither of them changed.
 *
 * Everything here reads the request at the seam that sees what is sent (the
 * `stream` the service is constructed with) and compares the **message list**
 * rather than the whole body: the system prompt is a separate investigation,
 * and folding it in would let a system-side difference mask a
 * conversation-side one or the other way round.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A retired cartographer of {{user}}\'s acquaintance.',
    personality: 'Dry.',
    scenario: 'A map room.',
    first_mes: 'Hello.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: 'Stay in character.',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1',
    // A character's note at depth 0. With the book's own depth-0 bucket and
    // `post_history_instructions`, the request's tail carries three system
    // messages from three different contributors side by side — which is the
    // only shape the squash has anything to merge.
    extensions: { depth_prompt: { prompt: 'Aria remembers the map room.', depth: 0, role: 'system' } },
  },
})

/**
 * One system section and one depth-0 injection.
 *
 * **Depth 0 on purpose.** The first draft of this fixture injected at depth 2,
 * which in a two-floor conversation resolves to index 0 — ahead of the greeting
 * — and then migrates backwards through the request as the conversation grows.
 * Every comparison here was measuring that migration instead of the thing under
 * test. Depth 0 is the placement genuinely anchored to the end (`injectAtDepth`:
 * depth 0 lands after the last message), so everything ahead of it is
 * conversation and the comparisons are about the conversation.
 *
 * Two book entries at one depth and role would not have produced two adjacent
 * messages either: world info joins each depth-and-role bucket into a single
 * contribution, upstream's `joined` (`script.js:4612`,
 * `setExtensionPrompt(CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joined, …)`).
 */
const BOOK = {
  entries: {
    0: {
      uid: 0, key: [], keysecondary: [], comment: 'always, before the card',
      content: 'The city is built on a drained lake.', constant: true, disable: false,
      order: 100, position: 0, depth: 4, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 0, depth: 4, role: 0 },
    },
    1: {
      uid: 1, key: [], keysecondary: [], comment: 'always, at depth zero',
      content: 'Answer in the present tense.', constant: true, disable: false,
      order: 100, position: 4, depth: 0, role: 0, selective: false,
      addMemo: true, excludeRecursion: false, preventRecursion: false,
      probability: 100, useProbability: true, extensions: { position: 4, depth: 0, role: 0 },
    },
  },
}

/** The three depth-0 injections that close every request this fixture builds. */
const TAIL = [
  'user Answer in the present tense.',
  'user Aria remembers the map room.',
  'user Stay in character.',
]

/** The same three, as the squash leaves them: one message, single-newline joined. */
const MERGED_TAIL = TAIL
  .map((row, index) => index === 0 ? row : row.slice('user '.length))
  .join('\n')

interface Fixture {
  handlers: Handlers
  chatId: string
  captured: GenerateOptions[]
  /** Wait for `count` more generations to settle. */
  settled: (count?: number) => Promise<void>
}

/** The visible text of one harness message. */
function textOf(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * One request's conversation as `role text` rows.
 *
 * The role is part of the row because it is part of the bytes: the same text
 * under a different role is a different request, and a path that coerced a
 * system injection to user on one route and not another would otherwise
 * compare equal.
 */
function rows(options: GenerateOptions): string[] {
  return options.messages.map(message => `${message.role} ${textOf(message)}`)
}

/** How many leading rows two requests agree on, byte for byte. */
function sharedRows(left: GenerateOptions, right: GenerateOptions): number {
  const a = rows(left)
  const b = rows(right)
  let index = 0
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index += 1
  return index
}

async function fixture(t: TestContext, options: { squash?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-history-stability-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'worlds', 'atlas.json'), JSON.stringify(BOOK), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const chats = new ChatStore(
    join(dir, 'chats'), library, undefined, undefined, worldbooks, () => settings.globalSelect())

  const captured: GenerateOptions[] = []
  let replies = 0
  const stream: StreamFn = async function* (request) {
    captured.push(request)
    // Numbered replies, so a path that fed the model its own previous answer
    // shows up as that answer's text rather than as a coincidence.
    replies += 1
    const text = `Reply ${String(replies)}.`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  let ends = 0
  let waited = 0
  const handlers = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    worldbooks,
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ends += 1
    },
    userName: 'Traveller',
  }).handlers()

  // Selected BEFORE the chat is created: the store reads the selection through
  // a closure when a chat opens, so a book chosen afterwards would reach this
  // conversation only on the next open and the fixture would assemble no world
  // info at all.
  await handlers['worldbook.setGlobalSelect']({ names: ['atlas'] })
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  if (options.squash === true) {
    await handlers['settings.set']({ chatId, settings: { squashSystemMessages: true } })
  }

  return {
    handlers,
    chatId,
    captured,
    settled: async (count = 1) => {
      waited += count
      for (let tick = 0; tick < 8_000 && ends < waited; tick += 1) {
        await new Promise(done => { setTimeout(done, 1) })
      }
      assert.equal(ends >= waited, true, 'a generation never settled')
    },
  }
}

test('a reroll sends the same conversation bytes as the send that produced the reply', async (t) => {
  const fix = await fixture(t)
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Tell me about the lake.' })
  await fix.settled()
  const send = fix.captured[0] as GenerateOptions

  await fix.handlers['chat.regenerate']({ chatId: fix.chatId })
  await fix.settled()
  const reroll = fix.captured[1] as GenerateOptions

  // The state a reroll assembles from IS the state the send assembled from —
  // the reply being replaced is dropped (`historyFromSession`'s
  // `dropTrailingReply`, upstream's `chat.length - 1` / `coreChat.pop()`), so
  // the two requests carry the same conversation. A difference here is a
  // full-prefix miss on every swipe of every turn.
  assert.deepEqual(rows(reroll), rows(send))

  // And the fixture is exercising a conversation rather than an empty one.
  // Written out in full because an assembly with no history and no injections
  // would satisfy the comparison above while proving nothing.
  assert.deepEqual(rows(send), [
    'assistant Hello.',
    'user Tell me about the lake.',
    // The three depth-0 injections ride as user-role content: the system slot
    // is already spoken for (`toMessage`), which is itself part of the bytes.
    ...TAIL,
  ])
  // A reroll must not be shown the answer it is replacing.
  assert.equal(rows(reroll).some(row => row.includes('Reply 1.')), false)
})

test('two swipes of one reply are byte-identical, conversation and system alike', async (t) => {
  const fix = await fixture(t)
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Tell me about the lake.' })
  await fix.settled()
  await fix.handlers['chat.regenerate']({ chatId: fix.chatId })
  await fix.settled()
  await fix.handlers['chat.regenerate']({ chatId: fix.chatId })
  await fix.settled()

  const first = fix.captured[1] as GenerateOptions
  const second = fix.captured[2] as GenerateOptions

  // A swipe in Iris IS another generation for the same turn, so two swipes are
  // two assemblies of one unchanged state. Measured the same way on the
  // operator's own conversation (`scripts/cache-history-probe.mjs`, 2026-09-08,
  // 爱衣 at 27 floors): identical conversation bytes and identical whole bodies,
  // 56 494 B each. So a `prefixHash` that differs between two swipes in the
  // field did not come from this side.
  assert.deepEqual(rows(second), rows(first))
  assert.equal(first.system, second.system)
  assert.equal(rows(first).length, 5, 'the fixture assembled a request with nothing in it')
})

test('an impersonation extends the conversation a reroll sends rather than rewriting it', async (t) => {
  const fix = await fixture(t)
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Tell me about the lake.' })
  await fix.settled()
  await fix.handlers['chat.regenerate']({ chatId: fix.chatId })
  await fix.settled()
  const reroll = fix.captured[1] as GenerateOptions

  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'impersonate' })
  await fix.settled()
  const impersonation = fix.captured[2] as GenerateOptions

  // The floors the two share — everything up to the reply the reroll dropped —
  // are identical. A name prefix or a role coercion that differed per path
  // would cut this to zero.
  assert.deepEqual(rows(impersonation).slice(0, 2), rows(reroll).slice(0, 2))
  assert.ok(sharedRows(reroll, impersonation) >= 2,
    `a reroll and an impersonation agreed on only ${String(sharedRows(reroll, impersonation))} leading messages`)
  // The impersonation is shown the reply, because it is writing the line that
  // comes after it.
  assert.equal(rows(impersonation).includes('assistant Reply 2.'), true)
  // Its instruction closes the request as a **system** message, upstream's own
  // delivery (`openai.js:1373` role system, `:1215-1216` appended after the
  // whole history). Named here because the role is part of the bytes.
  assert.equal(impersonation.messages.at(-1)?.role, 'system')
})

test('a continue keeps the floors it is continuing byte-identical and only extends the last one', async (t) => {
  const fix = await fixture(t)
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Tell me about the lake.' })
  await fix.settled()
  const send = fix.captured[0] as GenerateOptions

  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'continue' })
  await fix.settled()
  const continued = fix.captured[1] as GenerateOptions

  // Everything before the floor being continued is untouched, byte for byte as
  // the send sent it.
  assert.deepEqual(rows(continued).slice(0, 2), rows(send).slice(0, 2))
  // The continued floor carries the separator, and only the separator, on top
  // of the reply that is showing. This is a **departure** from upstream, which
  // postfixes only its recorded output: `cyclePrompt` reaches the request just
  // through the nudge's `{{lastChatMessage}}`, where `String(cyclePrompt).trim()`
  // takes the separator straight back off (`openai.js:902`), and the request's
  // own copy comes from `coreChat[…].mes` unpostfixed. Pinned rather than left
  // implicit, because it is the one place a generation path writes into the
  // conversation it was handed — DEVIATIONS.md §42.
  assert.equal(rows(continued)[2], 'assistant Reply 1. ')
  assert.equal(rows(continued).filter(row => row.startsWith('assistant Reply 1.')).length, 1)
  // The depth-0 injections keep their places, and the nudge closes the request
  // after them. `post_history_instructions` is **not** among them: the preset's
  // generation-type filter drops it on a continue (`generation-kinds.test.ts`
  // owns that rule), so a continue's tail is legitimately one message shorter
  // than a send's. It is named here because the difference is real and lands
  // past the conversation — behind the newest floor, where a prefix cache has
  // already stopped matching either way.
  assert.deepEqual(rows(continued).slice(3, 5), TAIL.slice(0, 2))
  assert.equal(rows(continued).at(-1)?.startsWith('user [Continue'), true)
  assert.equal(continued.messages.length, 6)
})

test('a card\'s own generate projects the conversation the way a turn does', async (t) => {
  const fix = await fixture(t)
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Tell me about the lake.' })
  await fix.settled()
  const send = fix.captured[0] as GenerateOptions

  await fix.handlers['script.generate']({ chatId: fix.chatId, userInput: 'Summarise so far.' })
  const side = fix.captured[1] as GenerateOptions

  // `script.generate` appends its prompt as the last **history** entry, so the
  // depth-0 injections still close the request — the same shape a turn has,
  // which is the point: a card's side call has to be a prefix of the chat it
  // belongs to or it pays full price for the whole history every time.
  assert.deepEqual(rows(side), [
    'assistant Hello.',
    'user Tell me about the lake.',
    'assistant Reply 1.',
    'user Summarise so far.',
    ...TAIL,
  ])
  // What the two requests share, they share byte for byte.
  assert.deepEqual(rows(side).slice(0, 2), rows(send).slice(0, 2))
  assert.ok(sharedRows(send, side) >= 2,
    `a side generation shares only ${String(sharedRows(send, side))} leading messages with the turn beside it`)
})

test('a card\'s generate squashes when the chat does, so the two agree past the injections', async (t) => {
  const fix = await fixture(t, { squash: true })
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Tell me about the lake.' })
  await fix.settled()
  const turn = fix.captured[0] as GenerateOptions

  await fix.handlers['script.generate']({ chatId: fix.chatId, userInput: 'Summarise so far.' })
  const side = fix.captured[1] as GenerateOptions

  // The squash is a per-chat setting, and upstream applies it at the end of
  // `prepareOpenAIMessages` (`openai.js:1599`) — which every generation type
  // passes through. It reached the driver but not `#sideGenerate`, so a chat
  // with the setting on sent its injections in one shape on a turn and another
  // shape on a card's call, and the two requests stopped sharing a prefix at
  // the first injection for a setting neither of them had changed.
  assert.equal(rows(turn).at(-1), MERGED_TAIL, 'the turn did not squash, so this test compares nothing')
  assert.equal(rows(side).at(-1), MERGED_TAIL, 'a card\'s generate ignored the chat\'s squash setting')
})

test('a card\'s generate trims against the chat\'s own window, not the composition\'s', async (t) => {
  const fix = await fixture(t)
  // Long floors and a narrow per-chat window, so the trimmer actually fires and
  // the two paths have something to disagree about. A window left at the host
  // default would trim nothing and this test would pass either way.
  const long = (label: string): string =>
    `${label} ${'the lake was drained in the year of the long winter. '.repeat(30)}`
  await fix.handlers['settings.set']({ chatId: fix.chatId, settings: { contextWindow: 1_400 } })
  for (const label of ['One.', 'Two.', 'Three.', 'Four.']) {
    await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: long(label) })
    await fix.settled()
  }
  const turn = fix.captured.at(-1) as GenerateOptions
  const { itemization } = await fix.handlers['prompt.itemize']({ chatId: fix.chatId })
  assert.ok(itemization.droppedHistory > 0,
    'the narrowed window trimmed nothing, so this test cannot tell the two budgets apart')

  await fix.handlers['script.generate']({ chatId: fix.chatId, userInput: 'Summarise so far.' })
  const side = fix.captured.at(-1) as GenerateOptions

  // `#sideGenerate` used to build its budget from the **composition's** window
  // rather than the chat's, so a chat with an override trimmed at one floor on
  // a turn and at another on a card's call. The floor each one *starts* at is
  // the whole question: if they differ, the card's request is not a prefix of
  // the conversation and re-pays for all of it.
  //
  // Compared at row **1**, not row 0. The greeting is pinned, so it survives
  // every trim and row 0 is identical whether or not the two budgets agree —
  // the first version of this assertion compared row 0, stayed green with the
  // fix reverted, and was measuring the pin instead of the trim.
  // Counted, not compared row by row. The greeting is pinned, so it survives
  // every trim and row 0 is identical whether or not the two budgets agree —
  // the first version of this assertion compared row 0, stayed green with the
  // fix reverted, and was measuring the pin instead of the trim. What the two
  // budgets cannot agree on is *how much conversation* comes back: a side
  // generation assembled against the composition's wider window carries every
  // floor the turn had to drop, and this window drops all of them.
  assert.ok(rows(side).length <= rows(turn).length + 1,
    `the card's generate carried ${String(rows(side).length)} messages against the turn's `
    + `${String(rows(turn).length)}, so it assembled under a different budget`)
  // The card's own prompt is the one message it adds.
  assert.ok(rows(side).includes('user Summarise so far.'))
})

test('the squash merges at a fixed distance from the end, so an already-sent floor never changes', async (t) => {
  const fix = await fixture(t, { squash: true })
  for (const text of ['One.', 'Two.', 'Three.']) {
    await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text })
    await fix.settled()
  }
  const [first, second, third] = fix.captured as [GenerateOptions, GenerateOptions, GenerateOptions]

  // The merge really happens, joining with upstream's single newline
  // (`openai.js:3846`). Without this the comparisons below would be measuring
  // an unsquashed request and would pass for the wrong reason.
  assert.equal(rows(third).at(-1), MERGED_TAIL,
    `the three adjacent depth-0 injections did not merge: ${JSON.stringify(rows(third))}`)

  // As the conversation grows, the merged message stays the same distance from
  // the end while every floor ahead of it is untouched: each request's floors
  // are a prefix of the next one's. A merge boundary that had crossed into
  // already-sent text would show up as a shorter shared run than the number of
  // floors the two requests have in common.
  assert.deepEqual(rows(second).slice(0, 2), rows(first).slice(0, 2))
  assert.deepEqual(rows(third).slice(0, 4), rows(second).slice(0, 4))
  assert.ok(sharedRows(second, third) >= 4,
    `growing the conversation by one exchange changed a floor at row ${String(sharedRows(second, third))}`)
  // And the merged run is the request's last message on every one of the three
  // turns, exactly once: the merge point is a distance from the end, not a
  // position in the request. Measured on the operator's own conversation
  // (`scripts/cache-history-probe.mjs`, 2026-09-08): six adjacent rounds of 爱衣
  // with the squash off and on gave the same common-prefix byte counts to the
  // byte (73 985 / 75 350 / 77 180 / 78 334 / 79 695 / 81 610), so the merge
  // never crossed into text a previous request had already sent.
  for (const request of [first, second, third]) {
    assert.equal(rows(request).at(-1), MERGED_TAIL)
    assert.equal(rows(request).filter(row => row === MERGED_TAIL).length, 1)
  }
})

test('the compaction summary floor is byte-stable while no compaction runs', async (t) => {
  const fix = await fixture(t)
  // Long floors, because the shrink guard refuses a summary that is not smaller
  // than the span it replaces and the framing alone costs ~84 estimated tokens.
  // Two one-word exchanges cannot be compacted at all, and a fixture that could
  // not compact would have made every assertion below vacuous.
  const long = (label: string): string =>
    `${label} ${'the lake was drained in the year of the long winter. '.repeat(20)}`
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: long('One.') })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: long('Two.') })
  await fix.settled()

  const { compacted } = await fix.handlers['chat.compact']({ chatId: fix.chatId })
  assert.ok(compacted !== undefined && compacted !== null, 'the manual compaction did not run')

  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: long('Three.') })
  await fix.settled()
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: long('Four.') })
  await fix.settled()
  const after = fix.captured.at(-2) as GenerateOptions
  const later = fix.captured.at(-1) as GenerateOptions

  // A compaction is one unavoidable full miss: the head of the conversation is
  // replaced. What must not happen is a *second* one — the summary floor rides
  // in the request byte-identically on every later turn, so the prefix is
  // re-established at once and then holds.
  const summaryRow = rows(after)[0] as string
  assert.ok(summaryRow.includes(frameSummary('x').split('\n')[0] as string),
    `the first message is not the summary floor: ${JSON.stringify(summaryRow)}`)
  assert.equal(rows(later)[0], summaryRow)

  // And the framing carries nothing that moves on its own — no clock, no
  // counter. Asserted on the framing function directly, because the record's
  // own `at` timestamp is stored beside the summary and must never reach the
  // prompt.
  const framed = summaryEntry({
    count: 2, summary: 'They discussed the lake.', spanTokens: 100, summaryTokens: 10,
    at: 1_725_000_000_000, model: 'test-model',
  })
  assert.equal(framed.text.includes('1725000000000'), false, 'the record timestamp reached the summary floor')
  assert.equal(framed.text, frameSummary('They discussed the lake.'))
  assert.equal(framed.pinned, true, 'an unpinned summary would be the first thing the trimmer dropped')
})

test('compaction fires before the trimmer does, so a block cut is the fallback and not the plan', () => {
  // The two mechanisms answer the same pressure and have to be ordered, or the
  // cheap one never runs: compaction replaces the head with a summary the model
  // can still use, the trim deletes it. Compaction's threshold is a fraction of
  // `context - reserve`; the trim's trigger is that same figure reached in full
  // (`assemble` spends `context - reserve - fixed` on history). So the ordering
  // is the ratio being under 1, and this is where that is written down.
  assert.ok(DEFAULT_THRESHOLD_RATIO < 1,
    'compaction would trigger at or after the point the trimmer starts deleting floors')

  const spec = compactionSpec(30_000)
  assert.ok(spec !== null)
  assert.ok(spec.thresholdTokens < 30_000,
    'the compaction threshold is not below the budget the trimmer starts cutting at')
  // The retained tail must be strictly under the threshold or the policy asks
  // for a compaction it can never satisfy. The harness validates this at plugin
  // load; here the ratios are constants, so this is the check.
  assert.ok(spec.retainTokens < spec.thresholdTokens)
})
