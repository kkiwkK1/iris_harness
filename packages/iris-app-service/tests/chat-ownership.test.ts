/**
 * Who may write a conversation's file, and how many live copies of it exist.
 *
 * Two defects of one shape: the store answered "which entry is this chat?" by
 * whoever asked last. A turn still streaming when its conversation was deleted
 * or restored kept its entry, and its settle saved that entry by chatId — so a
 * deleted chat came back on disk with its partial reply, and a restore was
 * silently undone. And two opens of one cold chat each built their own entry,
 * so the per-entry busy guard let two concurrent sends both stream.
 *
 * The provider here is gated: a request streams a prefix and then waits for a
 * release or for its abort signal, so each test can act *while* a turn is in
 * flight — the window both defects live in.
 *
 * @module @iris/app-service/tests/chat-ownership
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { BackupStore } from '../src/backups.ts'
import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { tempDir } from './support/temp-dir.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'M0', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Host {
  handlers: Handlers
  chats: ChatStore
  backups: BackupStore
  events: IrisEvent[]
  /** How many requests reached the provider. */
  requests: () => number
  /** Resolves once `count` requests are parked at the gate. */
  parked: (count: number) => Promise<void>
  /** Let every parked request finish normally. */
  release: () => void
  /** Resolves once a turn of this chat has ended, however it ended. */
  ended: (chatId: string) => Promise<void>
}

interface Profile {
  dir: string
  library: CharacterLibrary
  /** A host over the profile; a second call is what a restart looks like. */
  host: (gated: boolean) => Host
}

async function profile(t: TestContext): Promise<Profile> {
  const dir = await tempDir(t, 'iris-ownership-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  return {
    dir,
    library,
    host: (gated) => {
      const chats = new ChatStore(join(dir, 'chats'), library)
      const backups = new BackupStore(join(dir, 'chats'), { keep: 50 })
      const events: IrisEvent[] = []
      let requests = 0
      let parked = 0
      let gate: () => void = () => {}
      let opened = new Promise<void>((resolve) => { gate = resolve })
      const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests += 1
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        if (gated) {
          parked += 1
          await new Promise<void>((resolve, reject) => {
            void opened.then(resolve)
            options.signal?.addEventListener('abort', () => {
              const error = new Error('the turn was aborted')
              error.name = 'AbortError'
              reject(error)
            }, { once: true })
          })
        }
        yield { type: 'text-delta', index: 0, text: ' reply' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial reply' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      const handlers = new IrisAppService({
        stream, library, chats, backups,
        settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
        broadcast: (event: IrisEvent) => { events.push(event) },
        userName: 'U',
      }).handlers()
      const ended = (chatId: string): boolean => events.some(event =>
        (event.type === 'stream.end' || event.type === 'stream.error') && event.chatId === chatId)
      return {
        handlers, chats, backups, events,
        requests: () => requests,
        parked: async (count) => { while (parked < count) await new Promise(resolve => setTimeout(resolve, 1)) },
        release: () => {
          gate()
          opened = new Promise<void>((resolve) => { gate = resolve })
        },
        ended: async (chatId) => { while (!ended(chatId)) await new Promise(resolve => setTimeout(resolve, 1)) },
      }
    },
  }
}

test('a chat deleted while its turn streams stays deleted after the turn settles', async (t) => {
  const p = await profile(t)
  const host = p.host(true)
  const { view } = await host.handlers['chat.create']({ characterId: 'aria' })
  const file = join(p.dir, 'chats', `${view.chatId}.jsonl`)

  await host.handlers['chat.send']({ chatId: view.chatId, text: 'U0' })
  await host.parked(1)
  await host.handlers['chat.delete']({ chatId: view.chatId })
  assert.equal(existsSync(file), false, 'premise: the delete removed the file')
  await host.ended(view.chatId)
  // The settle runs after the terminal broadcast's save; give it its turn.
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(existsSync(file), false, 'the aborted turn’s settle wrote the deleted conversation back')
  const { chats } = await host.handlers['chat.list']({})
  assert.equal(chats.some(row => row.chatId === view.chatId), false, 'the deleted chat is listed again')
})

test('a restore while a turn streams keeps the restored text after the turn settles', async (t) => {
  const p = await profile(t)
  const host = p.host(true)
  const { view } = await host.handlers['chat.create']({ characterId: 'aria' })
  const file = join(p.dir, 'chats', `${view.chatId}.jsonl`)
  const snapshot = await host.backups.snapshot(view.chatId, 'cleanup', 'aria')
  const snapshotText = await readFile(host.backups.locate(snapshot.backupId), 'utf8')

  await host.handlers['chat.send']({ chatId: view.chatId, text: 'U0' })
  await host.parked(1)
  await host.handlers['backup.restore']({ backupId: snapshot.backupId, confirm: 'Aria' })
  // Released as well as aborted, so the assertion holds whether or not the
  // restore stops the turn: the write is what is under test.
  host.release()
  await host.ended(view.chatId)
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(await readFile(file, 'utf8'), snapshotText, 'the settle wrote the pre-restore conversation over the restore')
  const reopened = await host.handlers['chat.open']({ chatId: view.chatId })
  assert.deepEqual(reopened.view.messages.map(message => message.text), ['M0'])
})

test('concurrent opens of a cold chat share one entry', async (t) => {
  const p = await profile(t)
  const { view } = await p.host(false).handlers['chat.create']({ characterId: 'aria' })
  // A fresh store over the same directory: nothing is cached, as after a restart.
  const cold = new ChatStore(join(p.dir, 'chats'), p.library)
  const [a, b] = await Promise.all([cold.open(view.chatId), cold.open(view.chatId)])
  assert.equal(a, b, 'two concurrent opens built two live copies of one conversation')
  assert.equal(cold.cached(view.chatId), a)
})

test('two concurrent sends to a cold chat: one streams, the other is refused busy', async (t) => {
  const p = await profile(t)
  const { view } = await p.host(false).handlers['chat.create']({ characterId: 'aria' })
  const host = p.host(true)

  const answers = await Promise.allSettled([
    host.handlers['chat.send']({ chatId: view.chatId, text: 'X1' }),
    host.handlers['chat.send']({ chatId: view.chatId, text: 'X2' }),
  ])
  const outcomes = answers.map(answer => answer.status === 'fulfilled'
    ? 'ok'
    : String((answer.reason as { code?: string }).code))
  assert.deepEqual([...outcomes].sort(), ['busy', 'ok'], `outcomes were ${outcomes.join(', ')}`)
  await host.parked(1)
  host.release()
  await host.ended(view.chatId)
  assert.equal(host.requests(), 1, 'both sends reached the provider')
})
