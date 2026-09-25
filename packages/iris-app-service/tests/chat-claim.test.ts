/**
 * The chat's claim covers compaction, and Stop reaches every request.
 *
 * Before this, the per-chat busy guard was set by `begin(turn)` alone. The
 * pre-turn compaction (a full model call) ran before it, so during the
 * summary a second send passed validation and ran a summary of its own,
 * `/compact` passed its idle check, and Stop found nothing to stop. A manual
 * `chat.compact` checked idle once and then awaited the summary unclaimed. And
 * a card's `script.generate` / `generateRaw` ran with no signal at all, so
 * Stop, a delete or a restore could not reach it (owner ruling 4, 2026-09-25:
 * Stop aborts side calls too; host DEVIATIONS records it as an upgrade).
 *
 * The provider is gated per request kind: a summary or a side request parks
 * until released or aborted, and a turn answers at once — so each test acts
 * inside exactly the window it is about.
 *
 * @module @iris/app-service/tests/chat-claim
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import type { ChatStore } from '../src/chats.ts'
import { DEFAULT_THRESHOLD_RATIO, readCompaction } from '../src/compaction.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { readSideUsage } from '../src/side-usage.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { tempDir } from './support/temp-dir.ts'

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

const SUMMARY = 'They met in the archive. She is guarded; he is looking for one book.'
const SIDE_PROMPT = 'Name one book, slowly.'

type Kind = 'summary' | 'side' | 'turn'

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  events: IrisEvent[]
  /** Requests the provider was handed, by kind, in order. */
  seen: Kind[]
  /** Which kinds park at the gate. */
  gated: Set<Kind>
  /** Resolves once `count` requests of this kind are parked. */
  parked: (kind: Kind, count: number) => Promise<void>
  release: () => void
  /** Resolves once the next terminal event (after `after` of them) for the chat. */
  terminal: (chatId: string, after: number) => Promise<IrisEvent>
  terminals: (chatId: string) => number
}

function kindOf(options: GenerateOptions): Kind {
  const last = JSON.stringify(options.messages.at(-1)?.content ?? '')
  if (last.includes('compaction engine')) return 'summary'
  if (last.includes(SIDE_PROMPT)) return 'side'
  return 'turn'
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await tempDir(t, 'iris-chat-claim-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const events: IrisEvent[] = []
  const seen: Kind[] = []
  const gated = new Set<Kind>()
  const parked = new Map<Kind, number>()
  let open: () => void = () => {}
  let gate = new Promise<void>((resolve) => { open = resolve })

  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    const kind = kindOf(options)
    seen.push(kind)
    const text = kind === 'summary' ? SUMMARY : 'The archivist says something.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    // Usage first, so a request stopped at the gate has still been billed —
    // the shape of a provider that reports usage before the stream closes.
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 7 } }
    if (gated.has(kind)) {
      parked.set(kind, (parked.get(kind) ?? 0) + 1)
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve)
        options.signal?.addEventListener('abort', () => {
          const error = new Error('stopped')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
        if (options.signal?.aborted === true) {
          const error = new Error('stopped')
          error.name = 'AbortError'
          reject(error)
        }
      })
    }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const handlers = new IrisAppService({
    stream, library, chats, settings,
    broadcast: (event: IrisEvent) => { events.push(event) },
    userName: 'Traveller',
  }).handlers()
  const isTerminal = (event: IrisEvent, chatId: string): boolean =>
    (event.type === 'stream.end' || event.type === 'stream.error') && event.chatId === chatId
  const terminals = (chatId: string): number => events.filter(event => isTerminal(event, chatId)).length
  return {
    handlers, chats, events, seen, gated,
    parked: async (kind, count) => {
      while ((parked.get(kind) ?? 0) < count) await new Promise(resolve => setTimeout(resolve, 1))
    },
    release: () => {
      open()
      gate = new Promise<void>((resolve) => { open = resolve })
    },
    terminals,
    terminal: async (chatId, after) => {
      while (terminals(chatId) <= after) await new Promise(resolve => setTimeout(resolve, 1))
      return events.filter(event => isTerminal(event, chatId))[after] as IrisEvent
    },
  }
}

/** A chat with three exchanges, and a budget the next send will compact under. */
async function overThreshold(f: Fixture): Promise<string> {
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  const chatId = view.chatId
  for (let at = 0; at < 3; at += 1) {
    await f.handlers['chat.send']({
      chatId, kind: 'send',
      text: `Line ${String(at)}: ${'the reader says something at length. '.repeat(6)}`,
    })
    await f.terminal(chatId, at)
  }
  // The same arithmetic `compaction.test.ts` uses to reach the trigger: shrink
  // the budget under the request that was just recorded.
  const { itemization } = await f.handlers['prompt.itemize']({ chatId, turn: 3 })
  assert.equal(itemization.preview, false)
  const context = Math.floor(itemization.tokens / DEFAULT_THRESHOLD_RATIO) + itemization.budget.reserve - 200
  await f.handlers['settings.set']({ chatId, settings: { contextWindow: context } })
  return chatId
}

const busy = (error: unknown): boolean => (error as { code?: string }).code === 'busy'

test('a second send while the pre-turn compaction runs is refused busy before any second summary', async (t) => {
  const f = await fixture(t)
  const chatId = await overThreshold(f)
  f.gated.add('summary')
  const before = f.seen.length

  const first = f.handlers['chat.send']({ chatId, kind: 'send', text: 'Carry on.' })
  await f.parked('summary', 1)
  await assert.rejects(f.handlers['chat.send']({ chatId, kind: 'send', text: 'Again.' }), busy,
    'a second send passed while the compaction held the chat')
  await assert.rejects(f.handlers['chat.compact']({ chatId }), busy, '/compact passed during the pre-turn compaction')
  assert.deepEqual(f.seen.slice(before), ['summary'], 'a second summary was requested')

  f.release()
  await first
  await f.terminal(chatId, 3)
  assert.deepEqual(f.seen.slice(before), ['summary', 'turn'])
})

test('Stop during the pre-turn compaction ends the turn aborted, and no turn request is sent', async (t) => {
  const f = await fixture(t)
  const chatId = await overThreshold(f)
  f.gated.add('summary')
  const before = f.seen.length

  const sending = f.handlers['chat.send']({ chatId, kind: 'send', text: 'Carry on.' })
  await f.parked('summary', 1)
  await f.handlers['chat.abort']({ chatId })
  await sending
  const end = await f.terminal(chatId, 3)

  assert.deepEqual(f.seen.slice(before), ['summary'], 'the turn’s request went out after Stop')
  assert.ok(end.type === 'stream.error' && end.code === 'aborted', `the turn ended as ${JSON.stringify(end)}`)
  assert.equal(readCompaction((await f.chats.open(chatId)).header), undefined, 'a stopped summary was written')
  // The claim is released: the chat is usable again.
  f.gated.delete('summary')
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Now.' })
  await f.terminal(chatId, 4)
})

test('a manual compaction holds the claim: a send is refused, and Stop ends it with nothing written', async (t) => {
  const f = await fixture(t)
  const chatId = await overThreshold(f)
  f.gated.add('summary')

  const compacting = f.handlers['chat.compact']({ chatId })
  await f.parked('summary', 1)
  await assert.rejects(f.handlers['chat.send']({ chatId, kind: 'send', text: 'Carry on.' }), busy,
    'a send began in the middle of a manual compaction')
  await f.handlers['chat.abort']({ chatId })
  await assert.rejects(compacting, (error: unknown) => (error as { code?: string }).code === 'provider-error')
  assert.equal(readCompaction((await f.chats.open(chatId)).header), undefined)
  // Released on the way out.
  f.gated.delete('summary')
  await f.handlers['chat.send']({ chatId, kind: 'send', text: 'Now.' })
  await f.terminal(chatId, 3)
})

test('Stop aborts a card’s generateRaw in flight, and what it reported is still billed', async (t) => {
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  f.gated.add('side')

  const generating = f.handlers['script.generateRaw']({ chatId: view.chatId, prompt: SIDE_PROMPT })
  await f.parked('side', 1)
  await f.handlers['chat.abort']({ chatId: view.chatId })
  await assert.rejects(generating, (error: unknown) =>
    (error as { code?: string }).code === 'provider-error' && /stopped/.test((error as Error).message))

  const records = readSideUsage((await f.chats.open(view.chatId)).header)
  assert.equal(records.length, 1, 'the stopped request’s usage was not billed')
  assert.equal(records[0]?.usage.inputTokens, 100)
})

test('Stop aborts a card’s generate in flight', async (t) => {
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  f.gated.add('side')

  const generating = f.handlers['script.generate']({ chatId: view.chatId, userInput: SIDE_PROMPT })
  await f.parked('side', 1)
  await f.handlers['chat.abort']({ chatId: view.chatId })
  await assert.rejects(generating, (error: unknown) => (error as { code?: string }).code === 'provider-error')
})

test('deleting the chat aborts a card’s generateRaw in flight', async (t) => {
  const f = await fixture(t)
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  f.gated.add('side')

  const generating = f.handlers['script.generateRaw']({ chatId: view.chatId, prompt: SIDE_PROMPT })
  await f.parked('side', 1)
  // The refusal is watched before the delete runs: it lands inside it.
  const refused = assert.rejects(generating, (error: unknown) => (error as { code?: string }).code === 'provider-error')
  await f.handlers['chat.delete']({ chatId: view.chatId })
  await refused
})
