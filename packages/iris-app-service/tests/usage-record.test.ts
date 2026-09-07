import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { translate } from '@iris/llm-openai-compat/src/translate.ts'
import { importChat, parseChatFile, type SillyTavernMessage } from '@iris/persistence'
import type { ChatView, IrisEvent, TurnUsage } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ChatEntry } from '../src/entry.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { USAGE_FIELD } from '../src/usage.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/**
 * What a generation cost, from the provider's report to the file and back.
 *
 * The feature this holds up is one line under the composer: what this turn
 * cost and how much of the prompt the provider's cache served. Every part of
 * that is exact — it is the only exact number in the pipeline — so the failures
 * worth guarding against are the ones that produce a *plausible* number:
 *
 * - a cost filed against the wrong swipe, which shows the user a figure that
 *   belongs to a reply they swiped away from;
 * - a total that counts only the visible readings, understating a conversation
 *   by exactly the regenerations that made it expensive;
 * - an unreported bucket arriving as `0`, which turns "this provider says
 *   nothing about caching" into "the cache never helped";
 * - the whole record vanishing on a restart, or on the log rebuild that a
 *   sentence trim performs immediately after the record is written.
 *
 * SillyTavern's own `extra.token_count` is a different measurement by a
 * different measurer (its estimate of the message text), and it is asserted
 * here to be untouched: the two must not be confused for one another, and a
 * write that clobbered it would corrupt the number upstream's UI shows.
 */

/** A V2 card file, as the other fixtures here build one. */
function cardFile(): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: 'A retired cartographer.',
      personality: '',
      scenario: '',
      first_mes: 'Hello, {{user}}.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['maps'],
      creator: 'someone',
      character_version: '1',
      extensions: {},
    },
  })
}

/**
 * A stream that reports a different usage per call, or none at all.
 *
 * One script entry per generation, so a test can put a cache-reporting reply,
 * a silent one and a reasoning one in a single conversation — which is the
 * shape the summing rules are actually about. `undefined` means the provider
 * sent no usage chunk, which is most OpenAI-compatible endpoints.
 */
function usageStream(script: readonly (TurnUsage | undefined)[]): StreamFn {
  let call = 0
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const usage = script[Math.min(call, script.length - 1)]
    const text = `reply ${String(call)}`
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Collects pushed frames and lets a test wait for the **next** one of a kind.
 *
 * Next, not "any so far", and the difference is the whole reason this is not
 * the collector the other fixtures here use. A test that generates three times
 * asks for three `stream.end` frames; a waiter that is satisfied by a frame
 * already in the buffer resolves the second and third calls instantly with the
 * first turn's view — so the test then asserts against a conversation that has
 * one reply, and the failure reads as "the swipes were not recorded" rather
 * than "the test did not wait". Registered before the call that produces it, so
 * nothing is missed in between.
 */
function collector(): {
  events: IrisEvent[]
  broadcast: (event: IrisEvent) => void
  waitForNext: <T extends IrisEvent['type']>(type: T) => Promise<Extract<IrisEvent, { type: T }>>
} {
  const events: IrisEvent[] = []
  const waiters: { type: string, resolve: (event: IrisEvent) => void }[] = []
  return {
    events,
    broadcast(event) {
      events.push(event)
      for (const waiter of waiters.splice(0, waiters.length)) {
        if (waiter.type === event.type) waiter.resolve(event)
        else waiters.push(waiter)
      }
    },
    waitForNext<T extends IrisEvent['type']>(type: T) {
      return new Promise<Extract<IrisEvent, { type: T }>>((resolve) => {
        waiters.push({ type, resolve: event => { resolve(event as Extract<IrisEvent, { type: T }>) } })
      })
    },
  }
}

interface Fixture {
  dir: string
  chats: ChatStore
  service: IrisAppService
  handlers: Handlers
  sink: ReturnType<typeof collector>
}

/** A service over a fresh profile holding one card, with a scripted usage stream. */
async function fixture(
  t: TestContext,
  script: readonly (TurnUsage | undefined)[],
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-usage-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')
  return { dir, ...await open(dir, script) }
}

/** A service over an existing profile, as a restart builds one. */
async function open(
  dir: string,
  script: readonly (TurnUsage | undefined)[],
): Promise<Omit<Fixture, 'dir'>> {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const sink = collector()
  const service = new IrisAppService({
    stream: usageStream(script),
    library,
    chats,
    settings,
    broadcast: sink.broadcast,
    userName: 'Traveller',
  })
  return { chats, service, handlers: service.handlers(), sink }
}

/** Drive one send to completion and answer with the `stream.end` view. */
async function send(fixtureOf: Fixture, chatId: string, text = 'Hello?'): Promise<ChatView> {
  const waiting = fixtureOf.sink.waitForNext('stream.end')
  await fixtureOf.handlers['chat.send']({ chatId, text })
  const end = await waiting
  return end.view
}

/** Drive one regenerate to completion and answer with the `stream.end` view. */
async function regenerate(fixtureOf: Fixture, chatId: string): Promise<ChatView> {
  const waiting = fixtureOf.sink.waitForNext('stream.end')
  await fixtureOf.handlers['chat.regenerate']({ chatId })
  const end = await waiting
  return end.view
}

/** The last message of a view. */
function last(view: ChatView): ChatView['messages'][number] {
  const message = view.messages[view.messages.length - 1]
  assert.ok(message !== undefined, 'the view has no messages')
  return message
}

/** The stored chat file's message lines. */
async function lines(dir: string, chatId: string): Promise<SillyTavernMessage[]> {
  const text = await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')
  return parseChatFile(text).messages
}

/**
 * The route half of one record: asserted by shape, then taken out of the way.
 *
 * A stored entry is **one object holding three records** — what the provider
 * charged, which body it charged for (`../src/fingerprint.ts`), and which route
 * spent it and when (`model` / `provider` / `at`). The tests below are about
 * the costs and about the positional shape of the array, so the identity is
 * checked here once and removed; what is then compared is still an exact
 * `deepEqual`, so a stray field nobody meant to write still fails.
 *
 * Asserted rather than merely deleted, and that is the difference between this
 * helper and a `delete`: these three fields are what makes a cost answerable
 * across conversations at all, and a host that stopped writing them would leave
 * every bucket assertion below green.
 * @param usage - one usage object, from a file entry or from a view.
 * @param what - names the site, for the failure message.
 * @returns the same object without the three identity fields.
 */
function withoutRoute(usage: Record<string, unknown>, what: string): TurnUsage {
  const { model, provider, at, ...buckets } = usage
  assert.equal(typeof model, 'string', `${what}: no model was recorded`)
  assert.equal(typeof provider, 'string', `${what}: no provider was recorded`)
  assert.equal(typeof at, 'number', `${what}: no moment was recorded`)
  assert.ok(Number.isFinite(at) && (at as number) > 0, `${what}: the recorded moment is not a moment`)
  return buckets as unknown as TurnUsage
}

/** A view-side usage object, buckets only. */
function viewBuckets(usage: TurnUsage | undefined, what: string): TurnUsage {
  assert.ok(usage !== undefined, `${what}: the row carries no usage`)
  return withoutRoute(usage as unknown as Record<string, unknown>, what)
}

/**
 * The cost half of a line's stored entries, with the request fingerprint and
 * the route checked off and taken out of the way.
 *
 * See {@link withoutRoute}: each entry is one object holding three records, and
 * only the buckets are what these tests compare.
 * @param stored - the value the file's usage key holds.
 * @returns one usage object per swipe, `null` where that swipe reported nothing.
 */
function costs(stored: unknown): (TurnUsage | null)[] {
  assert.ok(Array.isArray(stored), 'the line carries no usage array')
  return stored.map((entry, at) => {
    if (entry === null || entry === undefined) return null
    const { promptHash, prefixHash, ...rest } = entry as Record<string, unknown>
    assert.match(String(promptHash), /^[0-9a-f]{16}$/, 'a recorded cost carries no prompt hash')
    assert.match(String(prefixHash), /^[0-9a-f]{16}$/, 'a recorded cost carries no prefix hash')
    return withoutRoute(rest, `stored entry ${String(at)}`)
  })
}

const CACHED: TurnUsage = {
  inputTokens: 232,
  outputTokens: 50,
  cacheReadTokens: 768,
  totalTokens: 1_050,
}

/**
 * The same generation as a **conversation** reports it: the four buckets, no
 * total.
 *
 * `ChatView.usage` never carries `totalTokens` — an aggregate one would cover
 * only the generations that reported a total and would therefore be smaller
 * than the buckets beside it, while reading as the total. So the row and the
 * conversation differ by exactly this field even when the conversation holds
 * one generation, and that is worth having spelled out in a constant rather
 * than deleted inline at four call sites.
 */
const CACHED_AGGREGATE: TurnUsage = {
  inputTokens: 232,
  outputTokens: 50,
  cacheReadTokens: 768,
}

test('one generation: the candidate carries the cost, and so does the view it settles with', async (t) => {
  const fix = await fixture(t, [CACHED])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const view = await send(fix, created.view.chatId)

  // The reply's own row, from `stream.end`'s view — no second event, no second
  // request: the number rides the view the shell already renders from.
  assert.deepEqual(viewBuckets(last(view).usage, 'the settled row'), CACHED)
  // Every bucket the provider reported, none it did not. `deepEqual` rather
  // than a field check, because the failure guarded against here is a
  // zero-filled `cacheWriteTokens` appearing beside the real numbers.
  assert.equal('cacheWriteTokens' in (last(view).usage ?? {}), false)
  // One generation, so the conversation is that generation — minus the exact
  // total, which an aggregate never carries.
  assert.deepEqual(view.usage, CACHED_AGGREGATE)
  assert.equal('totalTokens' in (view.usage ?? {}), false)
  // The greeting is turn 0 and was never generated through a provider, so it
  // carries nothing — an imported or authored line must not look billed.
  assert.equal(view.messages[0]?.usage, undefined)
})

test('the cost survives a restart, because the chat file carries it', async (t) => {
  const fix = await fixture(t, [CACHED])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await send(fix, chatId)

  // A second service over the same folder: nothing is shared but the files.
  const restarted = await open(fix.dir, [CACHED])
  const { view } = await restarted.handlers['chat.open']({ chatId })

  assert.deepEqual(viewBuckets(last(view).usage, 'the settled row'), CACHED)
  assert.deepEqual(view.usage, CACHED_AGGREGATE)
})

test('a generation whose provider reported nothing produces no field at all', async (t) => {
  const fix = await fixture(t, [undefined])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const view = await send(fix, created.view.chatId)

  assert.equal(last(view).usage, undefined, 'not a zero-filled record')
  assert.equal(view.usage, undefined, 'and no conversation total invented from it')
  // Nothing is written to the file either: a chat played through an endpoint
  // that reports no usage must look exactly as it did before this feature.
  const stored = await lines(fix.dir, created.view.chatId)
  assert.equal(USAGE_FIELD in (stored[1] ?? {}), false)
})

test('two regenerations: the total is all three, the row is the one selected', async (t) => {
  const first: TurnUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 }
  const second: TurnUsage = { inputTokens: 200, outputTokens: 20 }
  const third: TurnUsage = { inputTokens: 300, outputTokens: 30, cacheReadTokens: 40, reasoningTokens: 5 }
  const fix = await fixture(t, [first, second, third])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await send(fix, chatId)
  await regenerate(fix, chatId)
  const view = await regenerate(fix, chatId)

  assert.deepEqual(last(view).swipes, { count: 3, index: 2 }, 'three readings, the newest showing')
  // The row shows the selected candidate's own bill, not the turn's total —
  // this is the distinction the whole per-candidate storage exists for.
  assert.deepEqual(viewBuckets(last(view).usage, 'the third reading'), third)
  // The conversation total counts the two the user swiped away from: they were
  // generated and charged, and swiping does not refund them.
  assert.deepEqual(view.usage, {
    inputTokens: 600,
    outputTokens: 60,
    // 20 + 40: summed over the two generations that reported a cache read.
    // The middle generation reported none, and is not counted as a zero — if
    // it were, the hit rate would be diluted by a provider that said nothing.
    cacheReadTokens: 60,
    // Reported by one generation of three, and present because one is enough.
    reasoningTokens: 5,
  })
  // No generation reported a cache write, so the bucket is absent rather than
  // `0`. This is the assertion that fails if anything starts zero-filling.
  assert.equal('cacheWriteTokens' in (view.usage ?? {}), false)
  assert.equal('totalTokens' in (view.usage ?? {}), false)

  // Swiping back moves the row's figure with the text it belongs to.
  const swiped = await fix.handlers['chat.swipe']({ chatId, turn: 1, index: 0 })
  assert.deepEqual(viewBuckets(last(swiped.view).usage, 'the swiped-to reading'), first)
  assert.deepEqual(swiped.view.usage, view.usage, 'the conversation total does not move')
})

test('every swipe is on the file, so the total survives a restart too', async (t) => {
  const first: TurnUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 }
  const second: TurnUsage = { inputTokens: 200, outputTokens: 20 }
  const fix = await fixture(t, [first, second])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await send(fix, chatId)
  await regenerate(fix, chatId)

  const stored = await lines(fix.dir, chatId)
  const reply = stored[2]
  assert.ok(reply !== undefined && reply.is_user === false, 'the reply is the third line')
  // One entry per swipe, in swipe order — the same positional shape this file
  // format already uses for per-swipe variable tables.
  assert.deepEqual(costs(reply[USAGE_FIELD]), [first, second])
  assert.equal((reply['swipes'] as string[]).length, 2, 'the array is as wide as the swipe list')

  const restarted = await open(fix.dir, [])
  const { view } = await restarted.handlers['chat.open']({ chatId })
  assert.deepEqual(view.usage, { inputTokens: 300, outputTokens: 30, cacheReadTokens: 20 })
  assert.deepEqual(viewBuckets(last(view).usage, 'the selected reading'), second, 'and the selected reading keeps its own')
})

test('a swipe that reported nothing keeps its place in the array without becoming a zero', async (t) => {
  const paid: TurnUsage = { inputTokens: 100, outputTokens: 10 }
  // The middle generation is silent, so the array must carry a hole rather
  // than closing up — closing up would file the third bill against the second
  // swipe, which is a wrong number that looks entirely reasonable.
  const third: TurnUsage = { inputTokens: 300, outputTokens: 30 }
  const fix = await fixture(t, [paid, undefined, third])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await send(fix, chatId)
  await regenerate(fix, chatId)
  await regenerate(fix, chatId)

  const stored = await lines(fix.dir, chatId)
  assert.deepEqual(costs(stored[2]?.[USAGE_FIELD]), [paid, null, third])

  const restarted = await open(fix.dir, [])
  const { view } = await restarted.handlers['chat.open']({ chatId })
  assert.deepEqual(viewBuckets(last(view).usage, 'the third swipe'), third, 'the third swipe, not the second')
  const middle = await restarted.handlers['chat.swipe']({ chatId, turn: 1, index: 1 })
  assert.equal(last(middle.view).usage, undefined, 'and the silent one is still silent')
})

test('a regenerate after a swipe back bills the new reading, not the one selected', async (t) => {
  const first: TurnUsage = { inputTokens: 100, outputTokens: 10 }
  const second: TurnUsage = { inputTokens: 200, outputTokens: 20 }
  const third: TurnUsage = { inputTokens: 300, outputTokens: 30 }
  const fix = await fixture(t, [first, second, third])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId

  await send(fix, chatId)
  await regenerate(fix, chatId)
  // Back to the first reading, then generate a third one. This is the case
  // that tells the two candidate rules apart: `selectedCandidate` still
  // answers with swipe 0 here (the last `iris/swipe-select` decides, and a
  // fresh generation does not append one), so recording against the selection
  // would add the third bill to the *first* reading — which already has its
  // own — and leave the new reading looking free.
  await fix.handlers['chat.swipe']({ chatId, turn: 1, index: 0 })
  await regenerate(fix, chatId)

  const stored = await lines(fix.dir, chatId)
  assert.deepEqual(costs(stored[2]?.[USAGE_FIELD]), [first, second, third])
  // And the conversation total is all three, once each.
  const restarted = await open(fix.dir, [])
  const { view } = await restarted.handlers['chat.open']({ chatId })
  assert.deepEqual(view.usage, { inputTokens: 600, outputTokens: 60 })
})

test('an editing rebuild does not lose the record it was written beside', async (t) => {
  const fix = await fixture(t, [CACHED])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const view = await send(fix, chatId)
  const id = last(view).id

  // An edit reassigns every seq in the log — `importChat` builds a new one —
  // so a per-candidate record that is not carried across by position is gone.
  // The same rebuild runs on the settle path when `trimSentences` is on, one
  // statement after the usage is recorded.
  const edited = await fix.handlers['chat.editMessage']({ chatId, id, text: 'A hand-edited reply.' })
  assert.equal(last(edited.view).text, 'A hand-edited reply.')
  assert.deepEqual(viewBuckets(last(edited.view).usage, 'the edited row'), CACHED)
  assert.deepEqual(edited.view.usage, CACHED_AGGREGATE)
})

test('a DeepSeek wire response reaches the view through the real translator', async (t) => {
  // **The seam, not either side of it.** Every other test here scripts a
  // `StreamChunk` by hand, and the mapping tests in
  // `@iris/llm-openai-compat` script a `WireUsage` by hand — so both halves
  // can be green while the join between them drops a field. This one starts
  // from bytes-on-the-wire shaped like DeepSeek's own response, runs the
  // adapter's `translate` over it, and asserts the cache figure comes out the
  // far end in `ChatView`. Nothing here re-states the mapping; the point is
  // that the value survives the whole path.
  //
  // Reached through the adapter package's `./src/*` subpath, which its
  // `package.json` exposes: `translate` is internal to that adapter's own
  // composition rather than part of its plugin surface, and the alternative —
  // standing up an HTTP endpoint to drive `OpenAiCompatAdapter` — would test
  // the transport as well, which has its own tests next door.
  const payloads = [
    JSON.stringify({ choices: [{ delta: { content: 'Hello.' } }] }),
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        // Only DeepSeek's native spelling, which is the case the adapter had
        // to grow a fallback for.
        prompt_tokens: 4_000,
        prompt_cache_hit_tokens: 3_776,
        prompt_cache_miss_tokens: 224,
        completion_tokens: 12,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
    '[DONE]',
  ]
  const wire: StreamFn = () => translate((async function* () {
    for (const payload of payloads) yield payload
  })())

  const dir = await mkdtemp(join(tmpdir(), 'iris-usage-wire-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const sink = collector()
  const service = new IrisAppService({
    stream: wire,
    library,
    chats: materialisingChatStore(dir, library),
    settings,
    broadcast: sink.broadcast,
    userName: 'Traveller',
  })
  const handlers = service.handlers()
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const waiting = sink.waitForNext('stream.end')
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'Hello?' })
  const view = (await waiting).view

  const buckets = {
    // 4000 - 3776: disjoint, as the harness convention requires.
    inputTokens: 224,
    outputTokens: 12,
    cacheReadTokens: 3_776,
    reasoningTokens: 3,
  }
  // The row keeps the provider's exact total. The wire sent no `total_tokens`,
  // so this is the adapter's own aggregate of counters that agreed — 4000 + 12.
  assert.deepEqual(viewBuckets(last(view).usage, 'the translated row'), { ...buckets, totalTokens: 4_012 })
  // The conversation reports the four buckets and no total, even here where it
  // holds a single generation and the two would have agreed. The rule does not
  // depend on how many generations there are, so neither does the test.
  assert.deepEqual(view.usage, buckets)
})

test('a SillyTavern round trip keeps our field and never touches theirs', async (t) => {
  // A file as SillyTavern writes one: its own token estimate in `extra`, and
  // no notion of provider usage anywhere.
  const header = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-01 00:00:00',
    chat_metadata: {},
  }
  const imported: SillyTavernMessage[] = [
    {
      name: 'Aria',
      is_user: false,
      send_date: '2026-01-01 00:00:01',
      mes: 'An imported greeting.',
      extra: { token_count: 4, api: 'openai' },
      swipes: ['An imported greeting.'],
      swipe_id: 0,
    },
  ]
  const session = importChat({ header, messages: imported }, 'round-trip')
  const entry = new ChatEntry({
    chatId: 'round-trip',
    header,
    session,
    card: undefined,
  })

  // Nothing has generated yet, so the view carries no total and the export
  // carries no field of ours — an imported history is not retro-billed.
  assert.equal(entry.toView().usage, undefined)
  assert.equal(USAGE_FIELD in (entry.toFile().messages[0] ?? {}), false)

  // Now record what a generation on that turn cost, the way the settle path
  // does, and write the file.
  entry.recordUsage(0, CACHED)
  const written = entry.toFile().messages[0]
  assert.ok(written !== undefined)
  assert.deepEqual(written[USAGE_FIELD], [CACHED])
  // **Their number, untouched.** `extra.token_count` is SillyTavern's estimate
  // of the message text; ours is the provider's charge for the request. They
  // measure different things and neither may be written over the other.
  assert.deepEqual(written['extra'], { token_count: 4, api: 'openai' })
  assert.equal(written['mes'], 'An imported greeting.')

  // And back in again, through the reader the host uses on open — not by
  // inspecting the field, because what has to survive is the *reading*.
  const reopened = new ChatEntry({
    chatId: 'round-trip',
    header,
    session: importChat({ header, messages: [written] }, 'round-trip'),
    card: undefined,
  })
  reopened.hydrateUsage([written])
  // The row keeps the provider's exact total; the conversation never carries
  // one. Both halves are checked, because the field surviving the file and the
  // field being withheld from the aggregate are two separate rules and a single
  // assertion could not tell which one broke.
  assert.deepEqual(reopened.toView().messages[0]?.usage, CACHED)
  assert.deepEqual(reopened.toView().usage, CACHED_AGGREGATE)
  // The second export is the first one again: a round trip that changed the
  // file would be a migration path that rewrites the user's history.
  assert.deepEqual(reopened.toFile().messages[0], written)
})

test('a malformed entry is dropped rather than summed into a NaN', async () => {
  const header = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-01-01 00:00:00',
    chat_metadata: {},
  }
  // Three ways a hand-edited or foreign file can be wrong, and one right one.
  const line: SillyTavernMessage = {
    name: 'Aria',
    is_user: false,
    mes: 'one',
    swipes: ['one', 'two'],
    swipe_id: 0,
    [USAGE_FIELD]: [
      { inputTokens: 10, outputTokens: 1, cacheReadTokens: 'lots' },
      { outputTokens: 2 },
      { inputTokens: 30, outputTokens: 3 },
    ],
  }
  const reports: string[] = []
  const entry = new ChatEntry({
    chatId: 'malformed',
    header,
    session: importChat({ header, messages: [line] }, 'malformed'),
    card: undefined,
  })
  entry.hydrateUsage([line], message => reports.push(message))

  // Entry 0's required buckets are sound, so it is kept — with the bucket that
  // was not a number left off rather than carried through as a string.
  assert.deepEqual(entry.toView().messages[0]?.usage, { inputTokens: 10, outputTokens: 1 })
  // Entry 1 is missing a required bucket and entry 2 has no swipe to belong
  // to; both are dropped, and both say so. A drop that says nothing is
  // indistinguishable from a file that never carried the number.
  assert.equal(reports.length, 2)
  assert.match(reports[0] ?? '', /not a usage record/)
  assert.match(reports[1] ?? '', /entry 2 dropped/)
  // The total is a real number: this is the assertion that fails if a string
  // or a missing bucket ever reaches the summation.
  assert.deepEqual(entry.toView().usage, { inputTokens: 10, outputTokens: 1 })
})

test('a conversation total carries no route, however many its generations named', async (t) => {
  /*
   * The identity fields describe **one generation**, and an aggregate must have
   * all three absent — a conversation can have run on several models across
   * several days, so a `model` on its total would name one of them as if it
   * named all of them. `sumUsage` builds from a fresh object over the four
   * optional buckets, which is what makes this true; asserted because it is
   * true by construction today and a construction can change.
   *
   * This is the one assertion in the file that would still pass if the host
   * stopped recording routes altogether, so it is paired with `withoutRoute`
   * above, which fails in that case at eight sites.
   */
  const fix = await fixture(t, [CACHED, CACHED])
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await send(fix, chatId)
  const view = await send(fix, chatId)

  assert.ok(view.usage !== undefined, 'the conversation reported no total at all')
  for (const field of ['model', 'provider', 'at'] as const) {
    assert.equal(
      field in view.usage,
      false,
      `the conversation total carries ${field}, which describes one generation`,
    )
  }
  // The premise: the generations it was summed from *did* name a route, so the
  // absence above is the sum dropping it rather than nothing having been recorded.
  const named = view.messages.filter(row => row.usage?.model !== undefined)
  assert.ok(named.length >= 2, `only ${String(named.length)} rows named a model; the sum has nothing to drop`)
})
