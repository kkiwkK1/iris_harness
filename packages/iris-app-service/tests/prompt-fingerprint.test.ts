import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseChatFile, type SillyTavernMessage } from '@iris/persistence'
import type { IrisEvent, TurnUsage } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { fingerprintRequest, PREFIX_BYTES, serialiseRequest } from '../src/fingerprint.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { USAGE_FIELD } from '../src/usage.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/**
 * The request fingerprint: which body a generation actually sent.
 *
 * The question it answers is the one a `cacheReadTokens: 0` turn cannot answer
 * on its own — did *we* send something different from last turn, or did the
 * provider decline to serve its cache? Two adjacent turns whose `prefixHash`
 * agree indict the provider; two that disagree indict us.
 *
 * So the failures worth guarding against are the ones that make the record
 * *look* usable while answering nothing:
 *
 * - a hash that moves when the prompt did not (a re-serialised body, a
 *   sampling knob folded in), which would blame us for every turn;
 * - a `prefixHash` that is really a whole-body hash, which would blame us for a
 *   change far past anything a cache prefix covers;
 * - the record not surviving the save, so the comparison is only possible
 *   inside the session that made it — which is the one session where the
 *   request is still in memory anyway.
 */

/** A V2 card file. */
const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
    character_version: '1', extensions: {},
  },
})

/** One request, built the way the driver hands them over. */
function request(system: string, text = 'Hello?'): GenerateOptions {
  return {
    provider: 'test',
    model: 'test-model',
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
  }
}

test('the same request assembled twice fingerprints the same', () => {
  const first = fingerprintRequest(request('You are Aria.'))
  const second = fingerprintRequest(request('You are Aria.'))

  assert.deepEqual(first, second)
  assert.match(first.promptHash, /^[0-9a-f]{16}$/)
  assert.match(first.prefixHash, /^[0-9a-f]{16}$/)
})

test('one byte of the system prompt changes both hashes', () => {
  const before = fingerprintRequest(request('You are Aria.'))
  const after = fingerprintRequest(request('You are Arim.'))

  assert.notEqual(before.promptHash, after.promptHash)
  assert.notEqual(before.prefixHash, after.prefixHash)
})

test('a sampling knob is not part of the body a cache matches on', () => {
  const cold = { ...request('You are Aria.'), temperature: 0.2, maxTokens: 100 }
  const hot = { ...request('You are Aria.'), temperature: 1.4, maxTokens: 900 }

  // A temperature that jitters between turns must not read as prompt drift:
  // the provider's cache never looks at it, and folding it in would hide the
  // drift this record exists to find behind noise from a knob.
  assert.deepEqual(fingerprintRequest(cold), fingerprintRequest(hot))
})

test('prefixHash covers the prefix, so a late change moves only the whole-body hash', () => {
  // The serialised body opens with the route and the system slot, so an edit
  // this far into the system text is past the prefix window by construction.
  const long = 'a'.repeat(PREFIX_BYTES + 2_000)
  const late = `${long.slice(0, PREFIX_BYTES + 1_000)}Z${long.slice(PREFIX_BYTES + 1_001)}`
  assert.equal(long.length, late.length)
  assert.ok(serialiseRequest(request(long)).length > PREFIX_BYTES)

  const before = fingerprintRequest(request(long))
  const after = fingerprintRequest(request(late))

  assert.notEqual(before.promptHash, after.promptHash, 'the whole-body hash missed a changed byte')
  assert.equal(before.prefixHash, after.prefixHash, 'the prefix hash is really hashing the whole body')

  // And an early change does move it, so the equality above is not a hash of
  // nothing.
  const early = fingerprintRequest(request(`Z${long.slice(1)}`))
  assert.notEqual(before.prefixHash, early.prefixHash)
})

const CACHED: TurnUsage = { inputTokens: 232, outputTokens: 50, cacheReadTokens: 768 }

interface Fixture {
  dir: string
  chats: ChatStore
  handlers: Handlers
  seen: GenerateOptions[]
  settled: () => Promise<void>
}

/**
 * A host whose provider reports a cache read on every reply.
 *
 * `'silent'` rather than `undefined` for the no-usage case: an explicit
 * `undefined` argument takes a parameter default, so the silent provider would
 * quietly become the cache-reporting one and the test would assert against the
 * fixture it was written to exclude.
 */
async function fixture(t: TestContext, reports: TurnUsage | 'silent' = CACHED): Promise<Fixture> {
  const usage = reports === 'silent' ? undefined : reports
  const dir = await mkdtemp(join(tmpdir(), 'iris-fingerprint-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  return { dir, ...await open(dir, usage) }
}

/** The same profile, opened again — as a restart does. */
async function open(dir: string, usage: TurnUsage | undefined): Promise<Omit<Fixture, 'dir'>> {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const seen: GenerateOptions[] = []
  let call = 0
  let ends = 0
  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    const text = `reply ${String(call)}`
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats, settings,
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    // The report panel's own store: a note is retained and read through
    // `debug.reports`, not pushed — only an irreversible report is broadcast.
    diagnostics: new DiagnosticBuffer(),
  }).handlers()
  return {
    chats, handlers, seen,
    settled: async () => {
      const wanted = ends + 1
      while (ends < wanted) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** The fingerprint lines this host reported, oldest first — the panel's own read. */
async function lines(handlers: Handlers): Promise<string[]> {
  const page = await handlers['debug.reports']({})
  return page.reports
    .filter(report => report.kind === 'prompt' && report.message.startsWith('prompt '))
    .map(report => report.message)
}

/** The stored chat file's message lines. */
async function fileLines(dir: string, chatId: string): Promise<SillyTavernMessage[]> {
  return parseChatFile(await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')).messages
}

test('every generation reports one line naming its body and its cache read', async (t) => {
  const fixed = await fixture(t)
  const chatId = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await fixed.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fixed.settled()
  await fixed.handlers['chat.send']({ chatId, text: 'And then?' })
  await fixed.settled()

  const reported = await lines(fixed.handlers)
  assert.equal(reported.length, 2, 'one line per generation')
  for (const line of reported) {
    assert.match(line, /^prompt [0-9a-f]{16} prefix [0-9a-f]{16} cache-read 768$/)
  }
  // The two turns sent different bodies — the second carries a turn the first
  // did not — so a reader comparing the lines sees the prompt change that
  // explains a cache miss.
  assert.notEqual(reported[0], reported[1])

  // The lines describe the bodies that actually went out, not a re-assembly.
  const sent = fixed.seen.map(options => fingerprintRequest(options))
  assert.deepEqual(
    reported,
    sent.map(print => `prompt ${print.promptHash} prefix ${print.prefixHash} cache-read 768`),
  )
})

test('a provider that reports no usage still leaves a line, saying so', async (t) => {
  const fixed = await fixture(t, 'silent')
  const chatId = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await fixed.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fixed.settled()

  // "unreported" and "0" are different facts, and only one of them is a cache
  // miss. A line that printed `cache-read 0` here would invent a measurement.
  assert.match((await lines(fixed.handlers))[0] ?? '', /cache-read unreported$/)
})

test('the fingerprint rides the chat file beside the cost, and survives a restart', async (t) => {
  const fixed = await fixture(t)
  const chatId = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await fixed.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fixed.settled()

  const stored = (await fileLines(fixed.dir, chatId)).at(-1)
  const entry = (stored?.[USAGE_FIELD] as unknown[])[0] as Record<string, unknown>
  // One object per swipe holding both records: the buckets an older reader
  // already understands, and the two hashes beside them.
  assert.equal(entry['inputTokens'], 232)
  assert.equal(entry['cacheReadTokens'], 768)
  const sent = fingerprintRequest(fixed.seen[0] as GenerateOptions)
  assert.equal(entry['promptHash'], sent.promptHash)
  assert.equal(entry['prefixHash'], sent.prefixHash)

  // Read back by a fresh host: a comparison across a restart is the whole
  // point, since the request itself is long gone.
  const restarted = await open(fixed.dir, CACHED)
  const reopened = await restarted.chats.open(chatId)
  const line = reopened.toFile().messages.at(-1)
  assert.deepEqual((line?.[USAGE_FIELD] as unknown[])[0], entry)
})

test('a reroll fingerprints the same body as the send it rerolls, and each swipe keeps a record', async (t) => {
  const fixed = await fixture(t)
  const chatId = (await fixed.handlers['chat.create']({ characterId: 'aria' })).view.chatId

  await fixed.handlers['chat.send']({ chatId, text: 'Hello?' })
  await fixed.settled()
  await fixed.handlers['chat.regenerate']({ chatId })
  await fixed.settled()

  const stored = (await fileLines(fixed.dir, chatId)).at(-1)
  const entries = stored?.[USAGE_FIELD] as Record<string, unknown>[]
  assert.equal(entries.length, 2, 'each swipe carries its own record')
  const sent = fixed.seen.map(options => fingerprintRequest(options))
  assert.deepEqual(
    entries.map(item => item['promptHash']),
    sent.map(print => print.promptHash),
  )
  // **Equal, and that is the point.** Now that the reroll leaves the reply it
  // is replacing out of the request, its body is byte-identical to the send it
  // rerolls — which is the strongest cache statement a reroll can make, and a
  // second, independent reading of the projection change: an identical hash is
  // only possible if the candidate is absent from the prompt.
  assert.equal(entries[0]?.['promptHash'], entries[1]?.['promptHash'])
  assert.equal(entries[0]?.['prefixHash'], entries[1]?.['prefixHash'])
})
