import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { formatChatFile, parseChatFile, type SillyTavernMessage } from '@iris/persistence'
import type { ChatView, IrisEvent, TurnGeneration, TurnUsage } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import {
  FIRST_TOKEN_FIELD, GEN_FINISHED_FIELD, GEN_STARTED_FIELD, REASONING_DURATION_FIELD, writeTiming,
} from '../src/timing.ts'
import { USAGE_FIELD } from '../src/usage.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/**
 * How long each generation took, from the stream's own chunks to the chat file
 * and back.
 *
 * The feature this holds up is one figure at the end of a reply's action row:
 * `用量 1.1K · 75.0 tok/s`. Everything about it is a *plausible* number when it
 * is wrong, which is what the assertions here are shaped around:
 *
 * - a duration that includes the shell's work rather than the provider's, so
 *   every reply reads slower than it was;
 * - a time-to-first-token taken from the first *chunk* rather than the first
 *   chunk carrying output, which on a reasoning model is a `block-start` and
 *   reads as an instant answer;
 * - a record filed against the wrong swipe, so the number under a reply
 *   belongs to a reading the user swiped away from;
 * - the record hanging off the provider's `usage` chunk, which most
 *   OpenAI-compatible endpoints never send — the speed would then appear for
 *   some providers and not others, with nothing saying why;
 * - the whole thing vanishing on a restart, or being written under names
 *   SillyTavern does not read, which would make the timer Iris measured
 *   invisible in the product the file is compatible with.
 *
 * The moments are driven by a fake clock rather than by real time, so the
 * numbers asserted below are the numbers the stream declared. A test that
 * timed real `await`s would assert bands instead of values, and a band is
 * exactly what a wrong origin passes.
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

/** The moment every fixture here starts from, chosen to read plainly in a file. */
const T0 = Date.UTC(2026, 8, 11, 9, 30, 0)

/*
 * Line positions in the stored file, named because they are easy to get wrong
 * and the wrong one asserts absence on a line that never had the field: a chat
 * created here opens with the card's greeting, so the exchange starts at line
 * 1 and the reply this suite is about is line 2.
 */
const ASK = 1
const REPLY = 2

/** A clock the test moves by hand, standing in for `Date.now` everywhere. */
interface Clock {
  at: number
}

/**
 * Freeze `Date.now` on a clock the test owns.
 *
 * The whole host reads this one function for its moments — `sentAt`, the
 * route's `at`, the chat's `updatedAt` — so replacing it is what makes a
 * generation's timing an exact expected value instead of a range. Restored by
 * the runner when the test ends.
 * @param t - the test context, for the mock's lifetime.
 * @returns the clock, mutable by the stream and by the test.
 */
function frozenClock(t: TestContext): Clock {
  const clock: Clock = { at: T0 }
  t.mock.method(Date, 'now', () => clock.at)
  return clock
}

/** One chunk and the offset from the request, in milliseconds, it arrives at. */
interface Beat {
  at: number
  chunk: StreamChunk
}

/**
 * A stream whose chunks arrive at declared offsets on the frozen clock.
 *
 * The offsets are measured from the moment the generator's body first runs,
 * which is the same moment `#stream` took its `sentAt` — the first `next()` is
 * pulled immediately after. So a beat at `300` is a chunk that arrived 300ms
 * after the request went out, and the host has to agree.
 * @param clock - the clock to move.
 * @param beats - the chunks, in arrival order.
 * @returns the stream function to hand the service.
 */
function timedStream(clock: Clock, beats: readonly Beat[]): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const base = clock.at
    for (const beat of beats) {
      clock.at = base + beat.at
      yield beat.chunk
    }
  }
}

/** The usual shape: a reasoning block, then a visible one, then usage. */
const REPORTED: TurnUsage = { inputTokens: 900, outputTokens: 240, cacheReadTokens: 64 }

/**
 * A reasoning model's stream, timed.
 *
 * The `block-start` chunks are deliberately at the same offsets as the deltas
 * that follow them: a host that started its clock on "the first chunk" rather
 * than "the first chunk carrying output" would still get the reasoning right
 * here and would get it wrong the moment a provider announced a block early.
 * `usage` arrives before the terminal `finish`, which is the adapters' own
 * contract.
 * @param usage - the report, or `null` for an endpoint that sends none. `null`
 * rather than an omitted argument, because a default parameter is applied to an
 * explicit `undefined` too — a fixture that means "no usage chunk" would have
 * got the usual one and the test built on it would have passed while asserting
 * nothing.
 * @returns the beats.
 */
function reasoningBeats(usage: TurnUsage | null): Beat[] {
  return [
    { at: 250, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { at: 300, chunk: { type: 'reasoning-delta', index: 0, text: 'Weighing it. ' } },
    { at: 900, chunk: { type: 'reasoning-delta', index: 0, text: 'Still weighing it.' } },
    { at: 1_000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Weighing it. Still weighing it.' } } },
    { at: 1_100, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
    { at: 1_400, chunk: { type: 'text-delta', index: 1, text: 'The road ' } },
    { at: 2_100, chunk: { type: 'text-delta', index: 1, text: 'bends east.' } },
    { at: 2_200, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'The road bends east.' } } },
    ...usage === null ? [] : [{ at: 2_300, chunk: { type: 'usage' as const, usage } }],
    { at: 2_500, chunk: { type: 'finish' as const, reason: { kind: 'stop' as const } } },
  ]
}

/** What `reasoningBeats` must produce, computed from the offsets by hand. */
const REASONING_TIMING: TurnGeneration = {
  startedAt: T0,
  // The terminal `finish` is the last chunk, so the window closes at 2,500ms —
  // not whenever the consumer got round to the last one.
  durationMs: 2_500,
  // The first *output*, which is the reasoning delta at 300 and not the
  // `block-start` at 250.
  firstTokenMs: 300,
  // Upstream's own boundary: the first visible word after thinking, at 1,400.
  // Not the last reasoning delta at 900, and not the reasoning `block-end`.
  reasoningMs: 1_400,
}

/** Collects pushed frames and waits for the **next** one of a kind. */
function collector(): {
  events: IrisEvent[]
  broadcast: (event: IrisEvent) => void
  waitForNext: <T extends IrisEvent['type']>(type: T) => Promise<Extract<IrisEvent, { type: T }>>
  waitFor: <T extends IrisEvent['type']>(type: T) => Promise<Extract<IrisEvent, { type: T }>>
} {
  const events: IrisEvent[] = []
  const waiters: { type: string, resolve: (event: IrisEvent) => void }[] = []
  const waitForNext = <T extends IrisEvent['type']>(type: T): Promise<Extract<IrisEvent, { type: T }>> =>
    new Promise<Extract<IrisEvent, { type: T }>>((resolve) => {
      waiters.push({ type, resolve: event => { resolve(event as Extract<IrisEvent, { type: T }>) } })
    })
  return {
    events,
    broadcast(event) {
      events.push(event)
      for (const waiter of waiters.splice(0, waiters.length)) {
        if (waiter.type === event.type) waiter.resolve(event)
        else waiters.push(waiter)
      }
    },
    waitForNext,
    waitFor<T extends IrisEvent['type']>(type: T) {
      const seen = events.find(event => event.type === type)
      if (seen !== undefined) return Promise.resolve(seen as Extract<IrisEvent, { type: T }>)
      return waitForNext(type)
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

/** A service over an existing profile, as a restart builds one. */
async function open(dir: string, stream: StreamFn): Promise<Omit<Fixture, 'dir'>> {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const sink = collector()
  const service = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    broadcast: sink.broadcast,
    userName: 'Traveller',
  })
  return { chats, service, handlers: service.handlers(), sink }
}

/** A service over a fresh profile holding one card. */
async function fixture(t: TestContext, stream: StreamFn): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-timing-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')
  return { dir, ...await open(dir, stream) }
}

/** Drive one send to completion and answer with the `stream.end` view. */
async function send(fix: Fixture, chatId: string, text = 'Which way?'): Promise<ChatView> {
  const waiting = fix.sink.waitForNext('stream.end')
  await fix.handlers['chat.send']({ chatId, text })
  return (await waiting).view
}

/** Drive one regenerate to completion and answer with the `stream.end` view. */
async function regenerate(fix: Fixture, chatId: string): Promise<ChatView> {
  const waiting = fix.sink.waitForNext('stream.end')
  await fix.handlers['chat.regenerate']({ chatId })
  return (await waiting).view
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
 * The four fields upstream's own timer reads, off one line.
 *
 * Read through the constants rather than by literal, so a rename in
 * `../src/timing.ts` cannot pass here while breaking the compatibility this
 * whole storage choice exists for.
 * @param line - a message line from the file.
 * @returns the timer's four values, whatever types the file holds.
 */
function timerFields(line: SillyTavernMessage | undefined): Record<string, unknown> {
  assert.ok(line !== undefined, 'the file has no such line')
  const extra = line.extra ?? {}
  return {
    [GEN_STARTED_FIELD]: line[GEN_STARTED_FIELD],
    [GEN_FINISHED_FIELD]: line[GEN_FINISHED_FIELD],
    [FIRST_TOKEN_FIELD]: extra[FIRST_TOKEN_FIELD],
    [REASONING_DURATION_FIELD]: extra[REASONING_DURATION_FIELD],
  }
}

test('stamping a line copies its extra rather than writing into the log’s own record', () => {
  // How this was found: the whole branch suite went red with `Cannot assign to
  // read only property 'time_to_first_token'`. An imported line's `extra` is
  // the object the log's `iris/st-meta` event remembers, handed back by
  // `rowFields`, and the log's records are frozen — so an export that wrote
  // into it threw, and if the records were ever unfrozen it would instead edit
  // the log's copy of what the file originally held.
  const remembered = Object.freeze({ token_count: 6, api: 'openai' })
  const line: SillyTavernMessage = { name: 'Aria', is_user: false, mes: 'East.', extra: remembered }
  writeTiming(line, { startedAt: T0, durationMs: 1_200, firstTokenMs: 300 })

  assert.equal(line.extra?.[FIRST_TOKEN_FIELD], 300)
  assert.equal(line.extra?.['token_count'], 6, 'the carried-through keys were dropped')
  assert.notEqual(line.extra, remembered, 'the line still points at the log’s own object')
  assert.deepEqual(remembered, { token_count: 6, api: 'openai' }, 'the log’s record was edited')
})

test('the four moments are measured from the stream, and the reply carries them', async (t) => {
  const clock = frozenClock(t)
  const fix = await fixture(t, timedStream(clock, reasoningBeats(REPORTED)))
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const view = await send(fix, created.view.chatId)

  // `deepEqual`, not a field-by-field check: the failure being guarded against
  // is a *fifth* moment appearing, or `reasoningMs` arriving as a zero on a
  // model that did not reason, and both survive a spot check.
  assert.deepEqual(last(view).generation, REASONING_TIMING)
  // The stopwatch and the bill are separate objects on the row, and the timing
  // is not folded into the usage: `sumUsage` adds a `TurnUsage`'s fields up,
  // and a summed duration or a summed moment is not a fact about anything.
  assert.deepEqual(Object.keys(last(view).usage ?? {}).filter(key => key.endsWith('Ms')), [])
  assert.equal('durationMs' in (last(view).usage ?? {}), false)
  // The greeting was never generated, so it has no timing and none may be
  // invented for it — the same rule its absent cost lives under.
  assert.equal(view.messages[0]?.generation, undefined)
})

test('the chat file carries the timer in SillyTavern’s own fields and format', async (t) => {
  const clock = frozenClock(t)
  const fix = await fixture(t, timedStream(clock, reasoningBeats(REPORTED)))
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  await send(fix, created.view.chatId)

  const stored = await lines(fix.dir, created.view.chatId)
  // The exact strings, because the compatibility claim is about bytes: upstream
  // parses these with `moment(...)` and `JSON.stringify` of a `Date` is ISO
  // 8601 with milliseconds and a `Z`. All 12,960 timestamps in the SillyTavern
  // install on this machine are in exactly this shape.
  assert.deepEqual(timerFields(stored[REPLY]), {
    gen_started: '2026-09-11T09:30:00.000Z',
    gen_finished: '2026-09-11T09:30:02.500Z',
    time_to_first_token: 300,
    reasoning_duration: 1_400,
  })
  // Upstream's arithmetic on what Iris wrote: `gen_finished - gen_started`
  // divided into the provider's output count. This is the number SillyTavern
  // would print for this reply, and it is the number Iris prints.
  const window = Date.parse(String(stored[REPLY]?.[GEN_FINISHED_FIELD]))
    - Date.parse(String(stored[REPLY]?.[GEN_STARTED_FIELD]))
  assert.equal(window, 2_500)
  assert.equal(REPORTED.outputTokens / (window / 1_000), 96)

  // The user's line is not a generation and must not be stamped: its turn
  // number is shared with the reply, which is exactly how a positional walk
  // charges a question for its answer.
  assert.deepEqual(timerFields(stored[ASK]), {
    gen_started: undefined, gen_finished: undefined,
    time_to_first_token: undefined, reasoning_duration: undefined,
  })
})

test('a provider that reports no usage still has its generation timed', async (t) => {
  const clock = frozenClock(t)
  const fix = await fixture(t, timedStream(clock, reasoningBeats(null)))
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const view = await send(fix, created.view.chatId)

  // The case that decides whether this feature works on most endpoints at all:
  // no `usage` chunk, so no cost — and the host's own clock is unaffected.
  assert.equal(last(view).usage, undefined, 'a cost was invented')
  assert.deepEqual(last(view).generation, REASONING_TIMING)
  const stored = await lines(fix.dir, created.view.chatId)
  assert.equal(USAGE_FIELD in (stored[REPLY] ?? {}), false)
  assert.equal(stored[REPLY]?.[GEN_STARTED_FIELD], '2026-09-11T09:30:00.000Z')
})

test('a model that emitted no reasoning has no thinking duration, not a zero one', async (t) => {
  const clock = frozenClock(t)
  const fix = await fixture(t, timedStream(clock, [
    { at: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { at: 640, chunk: { type: 'text-delta', index: 0, text: 'East.' } },
    { at: 700, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'East.' } } },
    { at: 900, chunk: { type: 'usage', usage: REPORTED } },
    { at: 1_000, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]))
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const view = await send(fix, created.view.chatId)

  assert.deepEqual(last(view).generation, { startedAt: T0, durationMs: 1_000, firstTokenMs: 640 })
  assert.equal('reasoningMs' in (last(view).generation ?? {}), false, 'a zero would read as instant thinking')
  // And nothing is written into `extra` for it either: upstream's own
  // `reasoning_duration` is `null` on 1,260 lines of the corpus, and a `0`
  // there would be Iris asserting a measurement it did not take.
  const stored = await lines(fix.dir, created.view.chatId)
  assert.equal(REASONING_DURATION_FIELD in (stored[REPLY]?.extra ?? {}), false)
  assert.equal(stored[REPLY]?.extra?.[FIRST_TOKEN_FIELD], 640)
})

test('an aborted turn records the wait up to what the provider had said', async (t) => {
  const clock = frozenClock(t)
  const stalling: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const base = clock.at
    clock.at = base + 400
    yield { type: 'block-start', index: 0, blockType: 'text' }
    clock.at = base + 700
    yield { type: 'text-delta', index: 0, text: '*She opens her mouth to' }
    await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('the turn was aborted')) }, { once: true })
    })
  }
  const fix = await fixture(t, stalling)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const ending = fix.sink.waitForNext('stream.end')
  await fix.handlers['chat.send']({ chatId, text: 'Which way?' })
  await fix.sink.waitFor('stream.text')
  // The user thinks for a while before pressing stop. That time is *not* the
  // model's: the window closes at the last thing the provider said, which is
  // also where upstream's own `gen_finished` stops moving.
  clock.at = T0 + 9_000
  await fix.handlers['chat.abort']({ chatId })
  const view = (await ending).view

  assert.equal(last(view).text, '*She opens her mouth to')
  assert.deepEqual(last(view).generation, { startedAt: T0, durationMs: 700, firstTokenMs: 700 })
  // A kept partial is a reply, so its speed reaches the file like any other.
  const stored = await lines(fix.dir, chatId)
  assert.equal(stored[REPLY]?.[GEN_FINISHED_FIELD], '2026-09-11T09:30:00.700Z')
})

test('a row being regenerated shows neither the old cost nor the old stopwatch', async (t) => {
  const clock = frozenClock(t)
  let call = 0
  const thenStalling: StreamFn = (options: GenerateOptions) => {
    call += 1
    if (call === 1) return timedStream(clock, reasoningBeats(REPORTED))(options)
    return (async function* (): AsyncIterable<StreamChunk> {
      clock.at += 300
      yield { type: 'block-start', index: 0, blockType: 'text' }
      clock.at += 200
      yield { type: 'text-delta', index: 0, text: 'West' }
      await new Promise<void>((_resolve, reject) => {
        const stop = (): void => { reject(new Error('the turn was aborted')) }
        // Checked as well as listened for: a signal that is already aborted
        // never fires the event, and the listener would wait for ever.
        if (options.signal?.aborted === true) stop()
        else options.signal?.addEventListener('abort', stop, { once: true })
      })
    })()
  }
  const fix = await fixture(t, thenStalling)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const settled = await send(fix, chatId)
  assert.deepEqual(last(settled).generation, REASONING_TIMING)

  // A regenerate streams **over** the row that already has a reading, so the
  // projection has to strip both records from it: the cost belonged to text
  // that is no longer on screen, and the duration would divide a token count
  // that has not finished arriving. A growing duration makes a rate that
  // starts absurd and settles down, which is the one rendering this figure
  // must never have.
  // Registered before the call and waiting for the **next** frame, not any
  // frame already in the buffer: the first generation emitted its own
  // `stream.text`, and a waiter satisfied by that one would read the row before
  // the regenerate had started — a green test about a state that never existed.
  const streaming = fix.sink.waitForNext('stream.text')
  const ending = fix.sink.waitForNext('stream.end')
  await fix.handlers['chat.regenerate']({ chatId })
  await streaming
  // Read off the entry's own projection rather than through `chat.open`, which
  // waits for the chat to be idle and would deadlock against the stall.
  const mid = fix.chats.cached(chatId)?.toView()
  assert.ok(mid !== undefined, 'the entry is not loaded')
  assert.equal(last(mid).streaming, true, 'the row is not streaming, so this proves nothing')
  assert.equal(last(mid).generation, undefined, 'the previous reading’s stopwatch is still on the row')
  assert.equal(last(mid).usage, undefined, 'and so is its cost')

  await fix.handlers['chat.abort']({ chatId })
  await ending
})

test('the timing survives a restart, because the file carries it', async (t) => {
  const clock = frozenClock(t)
  const fix = await fixture(t, timedStream(clock, reasoningBeats(REPORTED)))
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await send(fix, chatId)

  // A second service over the same folder: nothing is shared but the files.
  const restarted = await open(fix.dir, timedStream(clock, reasoningBeats(REPORTED)))
  const { view } = await restarted.handlers['chat.open']({ chatId })
  assert.deepEqual(last(view).generation, REASONING_TIMING)
})

test('the file’s one timer belongs to the reading it is showing', async (t) => {
  const clock = frozenClock(t)
  // Two generations of different lengths, so which one the file describes is
  // visible in the bytes rather than only in an object identity.
  const slow = reasoningBeats(REPORTED)
  const quick: Beat[] = [
    { at: 120, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { at: 200, chunk: { type: 'text-delta', index: 0, text: 'West.' } },
    { at: 260, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'West.' } } },
    { at: 400, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]
  let call = 0
  const alternating: StreamFn = (options: GenerateOptions) => {
    const beats = call === 0 ? slow : quick
    call += 1
    return timedStream(clock, beats)(options)
  }
  const fix = await fixture(t, alternating)
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await send(fix, chatId)
  const second = await regenerate(fix, chatId)

  // The newest reading is selected, and the row shows *its* stopwatch — not the
  // turn's first, and not a total of the two. The clock is never rewound
  // between the two generations, so the second one started where the first one
  // ended: its own `startedAt` is 2,500ms in, which is the whole point of
  // recording a moment per generation rather than per turn.
  assert.deepEqual(last(second).swipes, { count: 2, index: 1 })
  assert.deepEqual(last(second).generation, { startedAt: T0 + 2_500, durationMs: 400, firstTokenMs: 200 })
  assert.equal((await lines(fix.dir, chatId))[REPLY]?.[GEN_FINISHED_FIELD], '2026-09-11T09:30:02.900Z')

  // Swiping back moves the timer with the text, in the view and in the file:
  // the four fields are the line's own and describe `swipe_id`, which is what
  // they mean in SillyTavern.
  const swiped = await fix.handlers['chat.swipe']({ chatId, turn: 1, index: 0 })
  assert.deepEqual(last(swiped.view).generation, REASONING_TIMING)
  assert.deepEqual(timerFields((await lines(fix.dir, chatId))[REPLY]), {
    gen_started: '2026-09-11T09:30:00.000Z',
    gen_finished: '2026-09-11T09:30:02.500Z',
    time_to_first_token: 300,
    reasoning_duration: 1_400,
  })
})

test('a chat imported from SillyTavern shows the timer SillyTavern measured', async (t) => {
  const clock = frozenClock(t)
  const fix = await fixture(t, timedStream(clock, reasoningBeats(REPORTED)))
  const created = await fix.handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  const file = parseChatFile(await readFile(join(fix.dir, 'chats', `${chatId}.jsonl`), 'utf8'))

  // A reply as SillyTavern itself writes one: its own estimate in
  // `extra.token_count`, its own timer beside it, and no Iris key anywhere.
  // `reasoning_duration: null` is upstream's ordinary shape for a model that
  // did not reason (`getDuration()` returns `null`), and 1,260 lines of the
  // corpus on this machine carry it.
  file.messages.push({
    name: 'Aria',
    is_user: false,
    mes: 'The road bends east.',
    extra: { token_count: 6, reasoning_duration: null, time_to_first_token: 512 },
    gen_started: '2026-09-10T21:04:11.250Z',
    gen_finished: '2026-09-10T21:04:14.750Z',
  })
  await writeFile(join(fix.dir, 'chats', `${chatId}.jsonl`), formatChatFile(file), 'utf8')

  const reopened = await open(fix.dir, timedStream(clock, reasoningBeats(REPORTED)))
  const { view } = await reopened.handlers['chat.open']({ chatId })
  // Unlike a *cost*, which upstream never records and which may never be
  // back-filled, the time is something upstream measured in these very fields.
  assert.deepEqual(last(view).generation, {
    startedAt: Date.parse('2026-09-10T21:04:11.250Z'),
    durationMs: 3_500,
    firstTokenMs: 512,
  })
  // The `null` is read as absent rather than as zero, and it survives the round
  // trip: nothing here overwrites another product's record of its own work.
  assert.equal('reasoningMs' in (last(view).generation ?? {}), false)
  // Nothing was generated in this chat, so the file is the greeting and the
  // line pushed onto it.
  const imported = 1
  const stored = await lines(fix.dir, chatId)
  assert.equal(stored[imported]?.extra?.[REASONING_DURATION_FIELD], null)
  assert.equal(stored[imported]?.extra?.['token_count'], 6, 'SillyTavern’s own estimate was overwritten')
})
