import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'

import { ChatStore } from '../src/chats.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

/**
 * World-info state that outlives a turn, and a chat that owns a book.
 *
 * Three seams are pinned here, each one a place where the host previously
 * answered correctly and then forgot:
 *
 * - the timed windows a scan advances are written into the chat header under
 *   upstream's key (`chat_metadata.timedWorldInfo`), so a restart does not
 *   silently reset every sticky and cooldown window in every conversation;
 * - reopening the chat restores them, because the restore lives on the entry
 *   rather than on whichever caller remembered to pass them;
 * - the chat book is a real binding with a real existence check, and its
 *   entries reach the next assembly — the one body of world info a card
 *   writes *during play*.
 */

/** A V2 card bound to a named book. */
function cardFile(): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: { world: 'TimedBook' },
    },
  })
}

/** The shared shape of the test books' entries, with what varies layered on. */
const ENTRY = {
  uid: 0, key: ['dragontime'], keysecondary: [], comment: 'timed', content: 'TIMED_MARK',
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 0, disable: false, displayIndex: 0,
  sticky: 2, cooldown: 0, delay: 0, probability: 100, useProbability: false,
  depth: 4, role: 0, excludeRecursion: false, preventRecursion: false,
  delayUntilRecursion: false, scanDepth: null, caseSensitive: null,
  matchWholeWords: null, useGroupScoring: null, automationId: '',
  group: '', groupOverride: false, groupWeight: 100, addMemo: true,
}

async function fixture(t: TestContext): Promise<{
  dir: string
  handlers: Handlers
  chats: ChatStore
  sink: Sink
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-wb-timing-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(
    join(dir, 'worlds', 'TimedBook.json'),
    // uid 1 is constant, so its presence in a prompt proves the book was
    // scanned without depending on what was said; uid 0 stays keyword-gated.
    JSON.stringify({ entries: {
      '0': ENTRY,
      '1': { ...ENTRY, uid: 1, key: [], comment: 'always', content: 'ALWAYS_MARK', sticky: 0, constant: true },
    } }),
    'utf8',
  )

  return { dir, ...await open(dir) }
}

/** One broadcast event, kept so a test can wait for the turn to settle. */
interface Sink {
  events: IrisEvent[]
  waitFor(type: IrisEvent['type']): Promise<void>
}

/** Build the service over an existing folder, exactly as a restart would. */
async function open(dir: string, seen?: GenerateOptions[]): Promise<{ handlers: Handlers, chats: ChatStore, sink: Sink }> {
  const sink: Sink = {
    events: [],
    waitFor(type) {
      const existing = this.events.find(event => event.type === type)
      if (existing !== undefined) return Promise.resolve()
      return new Promise(resolve => {
        waiters.push({ type, resolve })
      })
    },
  }
  const waiters: { type: IrisEvent['type'], resolve: () => void }[] = []
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  await settings.load()
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))

  const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen?.push(options)
    yield { type: 'text-delta', text: 'A reply.' } as StreamChunk
  }
  const service = new IrisAppService({
    stream,
    library,
    chats,
    settings,
    worldbooks,
    broadcast: event => {
      sink.events.push(event)
      for (const [index, waiter] of waiters.entries()) {
        if (waiter.type === event.type) {
          waiters.splice(index, 1)
          waiter.resolve()
        }
      }
    },
    userName: 'Traveller',
  })
  return { chats, handlers: service.handlers(), sink }
}

/** The chat file's header line, as a restart would parse it. */
async function headerOf(dir: string, chatId: string): Promise<Record<string, unknown>> {
  const firstLine = (await readFile(join(dir, 'chats', `${chatId}.jsonl`), 'utf8')).split('\n')[0] ?? ''
  return JSON.parse(firstLine) as Record<string, unknown>
}

test('a real turn persists the scan\u2019s timed windows into the chat header', async (t) => {
  const { dir, handlers, sink } = await fixture(t)
  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  // `chat.send` resolves at turn-open; the header is written by the assembly
  // and lands on disk with the turn's save, so the wait is part of the subject.
  await handlers['chat.send']({ chatId: view.chatId, text: 'dragontime, now' })
  await sink.waitFor('stream.end')

  // Read the file, not the live entry: the property under test is what a
  // restart will find on disk.
  const header = await headerOf(dir, view.chatId)
  const metadata = header['chat_metadata'] as Record<string, unknown>
  const stored = metadata['timedWorldInfo'] as
    | { sticky?: Record<string, { hash: number, start: number, end: number, protected: boolean }> }
    | undefined

  assert.ok(stored !== undefined, 'the header carries no timed windows after a real turn')
  const windows = Object.entries(stored.sticky ?? {})
  assert.equal(windows.length, 1, 'the fired entry opened exactly one sticky window')
  const [key, window_] = windows[0]!
  assert.equal(key, 'TimedBook.0', 'the window is keyed world.uid, as upstream keys it')
  assert.equal(typeof window_.hash, 'number')
  assert.equal(window_.end, window_.start + 2, 'the window spans the entry\u2019s sticky count')
})

test('reopening the chat restores the windows, the way upstream reads chat metadata', async (t) => {
  const { dir, handlers, sink } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['chat.send']({ chatId: created.view.chatId, text: 'dragontime, now' })
  await sink.waitFor('stream.end')

  // A fresh store over the same folder: no in-memory state survives this.
  const reopened = await open(dir)
  const entry = reopened.chats.cached(created.view.chatId) ?? await reopened.chats.open(created.view.chatId)

  assert.ok(entry.timedEffects !== undefined, 'the windows were not restored')
  assert.deepEqual(Object.keys(entry.timedEffects.sticky), ['TimedBook.0'])
  // Cooldown absent: the book declared none, and restoring an empty table would
  // be indistinguishable from never having persisted anything.
  assert.deepEqual(entry.timedEffects.cooldown, {})
})

test('binding a chat book is a real write, guarded by the book\u2019s existence', async (t) => {
  const { dir, handlers } = await fixture(t)
  const { view } = await handlers['chat.create']({ characterId: 'aria' })

  await assert.rejects(
    handlers['worldbook.bindChat']({ chatId: view.chatId, name: 'No Such Book' }),
    /No Such Book/u,
    'a dangling binding would make every later scan silently skip the chat book',
  )

  await handlers['worldbook.bindChat']({ chatId: view.chatId, name: 'TimedBook' })
  const header = await headerOf(dir, view.chatId)
  const metadata = header['chat_metadata'] as Record<string, unknown>
  assert.equal(metadata['world_info'], 'TimedBook')

  // `null` clears, upstream's own else branch.
  await handlers['worldbook.bindChat']({ chatId: view.chatId, name: null })
  const cleared = await headerOf(dir, view.chatId)
  assert.equal('world_info' in (cleared['chat_metadata'] as Record<string, unknown>), false, 'clearing leaves no dangling key')
})

test('the chat book\u2019s entries reach the next assembly, and overlaps stay single', async (t) => {
  // A constant entry, so activation cannot depend on what was said: if the
  // chat book is in the scan list at all, CHAT_MARK is in the prompt.
  const { dir, handlers } = await fixture(t)
  await writeFile(
    join(dir, 'worlds', 'ChatNotes.json'),
    JSON.stringify({ entries: {
      // Constant, keyless: it fires on every scan exactly while its book is scanned.
      '0': { ...ENTRY, key: [], comment: 'chat notes', content: 'CHAT_MARK', sticky: 0, constant: true },
    } }),
    'utf8',
  )

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  await handlers['worldbook.bindChat']({ chatId: view.chatId, name: 'ChatNotes' })

  const seen: GenerateOptions[] = []
  // A fresh service so the `seen` capture is ours; the chat is already on disk.
  const { handlers: fresh } = await open(dir, seen)
  await fresh['script.generate']({ chatId: view.chatId, userInput: 'go on' })

  const system = seen[0]?.system ?? ''
  assert.ok(system.includes('CHAT_MARK'), 'the chat book never reached the scan')

  // Binding the character's own book as the chat book must not double it:
  // upstream drops the *character* side of that overlap
  // ("already activated in chat lore! Skipping..."), so the text appears once.
  await handlers['worldbook.bindChat']({ chatId: view.chatId, name: 'TimedBook' })
  const seen2: GenerateOptions[] = []
  const { handlers: again } = await open(dir, seen2)
  await again['script.generate']({ chatId: view.chatId, userInput: 'dragontime go' })

  const system2 = seen2[0]?.system ?? ''
  // The overlap entry is constant, so its count is pure bookkeeping: two would
  // mean both sides scanned the same book.
  assert.equal(system2.split('ALWAYS_MARK').length - 1, 1, 'the character/chat overlap is deduped to one copy')
})
