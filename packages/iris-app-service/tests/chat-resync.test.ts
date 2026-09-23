/**
 * `chat.resync`: the read a page makes after a gap in its events (host §101,
 * web §124).
 *
 * The owner's stuck reply of 2026-09-24: the host settled and saved, the page
 * missed the `stream.end`, and the caret blinked on until a reload. The page's
 * cure is to ask this method; these tests pin what it answers and what it
 * leaves on the record.
 *
 * Three answers matter, and each is the one the nearest wrong implementation
 * gets wrong: "settled" must carry the view **with** the reply in it (a read
 * taken before the settle would tell the page to stop waiting and hand it the
 * old view); "still generating" must name the turn (a page that heard nothing
 * of it must know which one to wait for); and the note is filed **only** when
 * the page was stuck — a resync after a clean reconnect is not news.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { tempDir } from './support/temp-dir.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chatId: string
  diagnostics: DiagnosticBuffer
  /** Releases the held stream so the turn can finish. */
  release: () => void
  /** Resolves once the host has broadcast this turn's `stream.end`. */
  ended: Promise<void>
  /** Resolves once the first delta is out, i.e. the turn is in flight. */
  streaming: Promise<void>
}

/** A service whose one reply streams a delta and then waits for the test. */
async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await tempDir(t, 'iris-chat-resync-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const diagnostics = new DiagnosticBuffer()

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'The first half, ' }
    await gate
    yield { type: 'text-delta', index: 0, text: 'and the half the page never saw.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The first half, and the half the page never saw.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let onEnd!: () => void
  const ended = new Promise<void>(resolve => { onEnd = resolve })
  let onText!: () => void
  const streaming = new Promise<void>(resolve => { onText = resolve })
  const handlers = new IrisAppService({
    stream, library, chats, diagnostics,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.text') onText()
      // `chats.updated` follows `stream.end` inside the same settle, after its
      // directory read — waiting on it keeps that read out of the temp-dir
      // removal (the chat-integrity fixture's barrier, for the same reason).
      if (event.type === 'chats.updated' && endedSeen) onEnd()
      if (event.type === 'stream.end') endedSeen = true
    },
    userName: 'U',
  }).handlers()
  let endedSeen = false
  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chatId: created.view.chatId, diagnostics, release, ended, streaming }
}

const notes = (diagnostics: DiagnosticBuffer): string[] =>
  diagnostics.read().reports.filter(row => row.kind === 'host' && /resynced/.test(row.message)).map(row => row.message)

test('mid-generation, chat.resync names the turn in flight and files nothing', async (t) => {
  const f = await fixture(t)
  const turn = await f.handlers['chat.send']({ chatId: f.chatId, text: 'Tell me.' })
  await f.streaming

  const answer = await f.handlers['chat.resync']({ chatId: f.chatId, reason: 'silence', streamTurn: turn.turn, silentMs: 20_000 })
  assert.deepEqual(answer.generating, { turn: turn.turn }, 'the host says which turn is still generating')
  assert.deepEqual(notes(f.diagnostics), [], 'a page that is right to wait is not news')

  f.release()
  await f.ended
})

test('after the settle, chat.resync answers with the settled reply and no generating turn', async (t) => {
  const f = await fixture(t)
  const sent = await f.handlers['chat.send']({ chatId: f.chatId, text: 'Tell me.' })
  await f.streaming
  f.release()
  await f.ended

  const answer = await f.handlers['chat.resync']({ chatId: f.chatId, reason: 'reconnect', streamTurn: sent.turn })
  assert.equal(answer.generating, undefined, 'nothing is in flight any more')
  const reply = answer.view.messages.at(-1)
  assert.equal(reply?.role, 'assistant')
  assert.equal(reply?.text, 'The first half, and the half the page never saw.', 'the view carries the whole reply, not the half the page had')

  const filed = notes(f.diagnostics)
  assert.equal(filed.length, 1, 'the stuck page is on the record once')
  assert.match(filed[0] ?? '', /after its event socket reconnected/)
  assert.match(filed[0] ?? '', new RegExp(`turn ${String(sent.turn)} as generating, which this host had already finished`))
})

test('a resync from a page that was not stuck files nothing', async (t) => {
  const f = await fixture(t)
  await f.handlers['chat.send']({ chatId: f.chatId, text: 'Tell me.' })
  await f.streaming
  f.release()
  await f.ended

  // A reconnect with no reply showing as generating: the ordinary case.
  const answer = await f.handlers['chat.resync']({ chatId: f.chatId, reason: 'reconnect' })
  assert.equal(answer.generating, undefined)
  assert.deepEqual(notes(f.diagnostics), [])
})
