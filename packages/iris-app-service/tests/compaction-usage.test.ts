/**
 * The compaction summarizer's own bill, and its own trace.
 *
 * `./compaction.test.ts` covers what a compaction *does* to a conversation —
 * the span, the summary, the shrink guard, the trigger. This covers the thing
 * that request was not doing for its whole existence: being recorded. It was
 * billed by the provider and stored nowhere, so a profile that had compacted
 * had a usage page short by one summary per compaction with no figure anywhere
 * naming the gap (`notes/packages/iris-app-service/DEVIATIONS.md` §55, written
 * up in §51's own "still not recorded" paragraph before it was fixed).
 *
 * **The premise every test here rests on is asserted, not assumed**: the fake
 * provider reports usage on every request, so "nothing was recorded" and "there
 * was nothing to record" cannot be confused — and each test states the counts
 * it is discriminating between, because the plausible wrong implementation
 * files the summary as a card's generation and every figure still adds up.
 *
 * @module @iris/app-service/tests/compaction-usage
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { CacheTraceStore } from '../../iris-ext-cache-trace/src/cache-trace.ts'
import { localNamespace } from '../src/extensions.ts'
import type { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { compactionUsage, readSideUsage, scriptUsage, SIDE_USAGE_FIELD } from '../src/side-usage.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/** A plain card: nothing here is about world info. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'An archivist.',
    first_mes: 'The shelves are quiet tonight.',
    personality: '', scenario: '', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '', extensions: {},
  },
})

/** Short enough to pass the shrink guard against the fixture's history. */
const SUMMARY = 'They met in the archive. She is guarded; he is looking for one book.'

/**
 * What a turn's request is answered with, and what a summary's is.
 *
 * **Different numbers on purpose**, so a share read off the wrong population
 * shows as a wrong figure rather than as a coincidence — the same reason
 * `side-generate.test.ts` gives its three buckets three values.
 */
const TURN_USAGE = { inputTokens: 320, outputTokens: 48, cacheReadTokens: 90 }
const SUMMARY_USAGE = { inputTokens: 2_140, outputTokens: 96, cacheReadTokens: 768 }

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  traces: CacheTraceStore
  /** Every request the provider was handed, in order. */
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

/**
 * A service whose provider reports usage on every request and keeps traces.
 * @param t - the test context, for cleanup.
 * @returns the fixture.
 */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-compaction-usage-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const traces = new CacheTraceStore(localNamespace(join(dir, 'cache-trace')), { keep: 8 })
  const seen: GenerateOptions[] = []
  let ends = 0
  let waited = 0

  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    // A summarization call is the one whose last message is the instruction —
    // the same discriminator `compaction.test.ts` uses, so the two fixtures
    // agree about which request is which.
    const isSummary = JSON.stringify(options.messages.at(-1)?.content ?? '').includes('compaction engine')
    const text = isSummary ? SUMMARY : 'The archivist says something.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: isSummary ? { ...SUMMARY_USAGE } : { ...TURN_USAGE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const handlers = new IrisAppService({
    stream, library, chats, settings,
    cacheTrace: traces,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  return {
    handlers,
    chats,
    traces,
    seen,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

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

test('a compaction’s summary request is recorded on the header, as a compaction', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)

  const before = readSideUsage((await f.chats.open(chatId)).header)
  assert.equal(before.length, 0, 'the conversation carried a side record before it was ever compacted')

  const answer = await f.handlers['chat.compact']({ chatId })
  assert.ok(answer.compacted !== null, 'there was history to compact')

  const records = readSideUsage((await f.chats.open(chatId)).header)
  assert.equal(records.length, 1, 'the summary request left no record on the header')
  const record = records[0]
  assert.ok(record !== undefined)
  /*
   * The source is the whole point: filed as `'script'` this record would move
   * the host's own spend into the column labelled "how much of this was the
   * card", which is a wrong attribution that adds up correctly.
   */
  assert.equal(record.usage.source, 'compaction', 'the summary was filed under the wrong asker')
  assert.equal(record.caller, 'host.compaction')
  // The provider's own figures, not the turn's — the request that was billed is
  // the summary's, and the two answers differ in every bucket.
  assert.equal(record.usage.inputTokens, SUMMARY_USAGE.inputTokens)
  assert.equal(record.usage.outputTokens, SUMMARY_USAGE.outputTokens)
  assert.equal(record.usage.cacheReadTokens, SUMMARY_USAGE.cacheReadTokens)
  // The route and the moment, so the record can be placed on a chart at all.
  assert.equal(record.usage.model, 'test-model')
  assert.equal(record.usage.provider, 'test')
  assert.ok((record.usage.at ?? 0) > 0, 'the record carries no moment')
  // And the fingerprint, which is what makes the request explicable rather
  // than merely counted.
  assert.ok(record.fingerprint !== undefined, 'the summary request stored no fingerprint')
})

test('the record reaches disk, on the header and never on a message line', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)
  const lines = JSON.stringify((await f.chats.open(chatId)).toFile().messages)

  await f.handlers['chat.compact']({ chatId })

  /*
   * Re-read through the store rather than off the open entry: the record is
   * written to the in-memory header and only a save puts it on disk, and "the
   * bill survives a restart" is the claim.
   */
  const file = (await f.chats.open(chatId)).toFile()
  const stored = file.header[SIDE_USAGE_FIELD]
  assert.ok(Array.isArray(stored) && stored.length === 1, 'the record did not reach the saved header')
  assert.equal((stored[0] as { source?: string }).source, 'compaction',
    'the stored record does not say what it holds to a reader that is not this code')
  /*
   * The per-message array is parallel to `swipes`, so a cost entry with no
   * candidate behind it shifts every real record after it (`side-usage.ts`).
   * The compaction rewrites the header, so this compares only the message
   * lines — which must be exactly what they were plus nothing.
   */
  assert.equal(JSON.stringify(file.messages), lines, 'the summary request wrote onto a message line')
})

test('the two side shares are separate: a card’s spend and the host’s do not merge', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 2)

  // One card generation and one compaction, so the counts differ from each
  // other and from their sum: 1, 1, and a merged reading of 2.
  await f.handlers['script.generateRaw']({ chatId, prompt: 'Name one book.' })
  await f.handlers['chat.compact']({ chatId })

  const records = readSideUsage((await f.chats.open(chatId)).header)
  assert.equal(records.length, 2, 'the header does not carry both side populations')

  const card = scriptUsage(records)
  const host = compactionUsage(records)
  assert.ok(card !== undefined, 'the card share is missing')
  assert.ok(host !== undefined, 'the compaction share is missing')
  assert.equal(card.turns, 1, 'the card share counted the compaction as well')
  assert.equal(host.turns, 1, 'the compaction share counted the card generation as well')
  /*
   * The buckets, which is where a merge hides: two counts of 1 are also what a
   * correct reading gives when both filters are wrong in opposite directions,
   * and the figures are what tell those apart.
   */
  assert.equal(card.usage.inputTokens, TURN_USAGE.inputTokens, 'the card share is not the card’s request')
  assert.equal(host.usage.inputTokens, SUMMARY_USAGE.inputTokens, 'the compaction share is not the summary’s')

  // And the conversation's own running total holds both, because both were
  // billed to it — `ChatView.usage` states the ruling.
  const view = (await f.chats.open(chatId)).toView()
  assert.equal(view.scriptUsage?.turns, 1)
  assert.equal(view.compactionUsage?.turns, 1)
  assert.ok(view.usage !== undefined, 'the conversation reports no total')
  assert.equal(
    view.usage.inputTokens,
    TURN_USAGE.inputTokens * 3 + SUMMARY_USAGE.inputTokens,
    'the conversation total is not its two turns plus its card generation plus its compaction summary',
  )
})

test('the summary request leaves a cache trace of its own, under its own kind', async (t) => {
  const f = await fixture(t)
  const chatId = await played(f, 3)
  const beforeTraces = await f.traces.list(chatId)
  assert.equal(beforeTraces.length, 3, 'the three turns did not each leave a trace')

  await f.handlers['chat.compact']({ chatId })

  const seqs = await f.traces.list(chatId)
  assert.equal(seqs.length, 4, 'the summary request left no trace beside the turns it explains')
  const newest = seqs.at(-1)
  assert.ok(newest !== undefined)
  const trace = await f.traces.read(chatId, newest)
  assert.ok(trace !== undefined, 'the newest trace could not be read back')
  /*
   * `kind: 'compaction'` and not `'send'` or `'side'`. A summary lands at the
   * *front* of the next request's history, so this is the one body that
   * explains why every later turn's prefix changed — a reader comparing two
   * turns across a compaction has no other way to see it, and a trace filed
   * under a turn's own kind would read as a fourth turn.
   */
  assert.equal(trace.kind, 'compaction', 'the summary request’s trace is not filed as a compaction')
  assert.equal(trace.caller, 'host.compaction')
  /*
   * `turn: -1`, like a card's. The request is billed and it is not a turn, and
   * folding it onto whichever turn happened to be pending would file the host's
   * own summary against the user's reply.
   */
  assert.equal(trace.turn, -1, 'the summary request’s trace claims a turn')
  assert.equal(trace.inputTokens, SUMMARY_USAGE.inputTokens, 'the trace records the wrong request’s cost')
})

test('a summary the provider fails still leaves nothing to a conversation that was not compacted', async (t) => {
  /*
   * The failure path, which is the one the `finally` in `#stream` exists for on
   * the recording side: a request that reported its usage and then failed was
   * still charged. Here the provider fails *before* reporting anything, which
   * is the other half of the rule — no usage reported means no record at all,
   * rather than a zero-filled one that claims a generation nobody measured.
   */
  const dir = await mkdtemp(join(tmpdir(), 'iris-compaction-usage-fail-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  let ends = 0
  let waited = 0
  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const isSummary = JSON.stringify(options.messages.at(-1)?.content ?? '').includes('compaction engine')
    if (isSummary) throw new Error('the endpoint refused the summary')
    const text = 'The archivist says something.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { ...TURN_USAGE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
  }).handlers()

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  for (let at = 0; at < 2; at += 1) {
    await handlers['chat.send']({ chatId: view.chatId, kind: 'send', text: `Line ${String(at)}: something.` })
    waited += 1
    while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
  }

  await assert.rejects(async () => handlers['chat.compact']({ chatId: view.chatId }))
  const records = readSideUsage((await chats.open(view.chatId)).header)
  assert.deepEqual(records, [], 'a summary that reported no usage was recorded as costing nothing')
  assert.equal(
    (await chats.open(view.chatId)).toView().compaction,
    undefined,
    'a failed compaction wrote a record of a summary it never got',
  )
})
