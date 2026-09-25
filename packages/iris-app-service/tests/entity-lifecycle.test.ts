/**
 * What deleting a character or a conversation clears, and what it keeps.
 *
 * Owner ruling 5 (2026-09-25): deleting a character or a chat clears its
 * related per-id data; **backups are kept**. Ids are minted against the files
 * that exist, so a deleted card's or chat's id is handed to the next one of the
 * same name, and anything keyed by it that was left behind is inherited by a
 * stranger. Before this, `character.delete` forgot six stores by hand and not
 * the world-info binding (which had a `forget` and no production caller), and
 * `chat.delete` forgot three and left the cache traces — whole request bodies —
 * behind.
 *
 * Two halves:
 * - **The table.** Every store the service is composed with is classified for
 *   both deletes: forgotten (and the handler is checked to call it), or
 *   retained with a named reason, or not keyed by that id at all. A store added
 *   to `AppServiceOptions` without a row fails here, so a new per-id store (the
 *   phase-two sidecar is the next one) cannot silently opt out.
 * - **The behaviour** for the two cascades this round added, run end to end.
 *
 * This is the first step of the finding's `EntityLifecycle`, not the whole of
 * it: the cascades are still hand-written in the two handlers, and the table is
 * what keeps the hand-written lists honest.
 *
 * @module @iris/app-service/tests/entity-lifecycle
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
import { CacheTraceStore } from '../src/cache-trace.ts'
import { WorldbookBindingStore } from '../src/materialise.ts'
import type { Handlers } from '../src/service.ts'
import { createTestService } from './support/service.ts'

type Fate =
  /** The delete handler calls this store's forget (or delete) for the id. */
  | 'forget'
  /** Kept on purpose; the string is the reason. */
  | { retained: string }
  /** Not partitioned by this kind of id, so there is nothing to forget. */
  | 'unkeyed'

/**
 * Every store-shaped option, and what each delete does to it.
 *
 * `call` is the text the handler's source must contain for a `'forget'` row —
 * the store's own forget reached through whatever name the handler uses.
 */
const LIFECYCLE: Record<string, { character: Fate, chat: Fate, call?: { character?: RegExp, chat?: RegExp } }> = {
  library: { character: 'forget', chat: 'unkeyed', call: { character: /library\.delete\(characterId\)/u } },
  chats: {
    character: { retained: 'a card’s conversations outlive it: they stay listed and openable, headed by the deleted card’s id' },
    chat: 'forget',
    call: { chat: /chats\.delete\(chatId\)/u },
  },
  settings: { character: 'unkeyed', chat: 'forget', call: { chat: /settings\.forget\(chatId\)/u } },
  scripts: { character: 'forget', chat: 'unkeyed', call: { character: /scripts\?\.forget\(characterId\)/u } },
  scriptLibrary: { character: 'forget', chat: 'unkeyed', call: { character: /scriptLibrary\?\.forget\(characterId\)/u } },
  extensionSettings: { character: 'forget', chat: 'unkeyed', call: { character: /extensionSettings\?\.forget\(characterId\)/u } },
  scriptButtons: { character: 'forget', chat: 'unkeyed', call: { character: /scriptButtons\?\.forget\(characterId\)/u } },
  scriptVariables: { character: 'forget', chat: 'unkeyed', call: { character: /scriptVariables\?\.forget\(characterId\)/u } },
  favorites: { character: 'forget', chat: 'unkeyed', call: { character: /favorites\?\.forget\(characterId\)/u } },
  worldbookBindings: { character: 'forget', chat: 'unkeyed', call: { character: /worldbookBindings\?\.forget\(characterId\)/u } },
  chatOrder: { character: 'unkeyed', chat: 'forget', call: { chat: /chatOrder\?\.forget\(chatId\)/u } },
  sandboxPlugins: { character: 'unkeyed', chat: 'forget', call: { chat: /sandboxPlugins\?\.forget\(chatId\)/u } },
  cacheTrace: {
    character: 'forget',
    chat: 'forget',
    call: { character: /traces\.forgetChat\(chat\.chatId\)/u, chat: /cacheTrace\?\.forgetChat\(chatId\)/u },
  },
  backups: {
    character: { retained: 'owner ruling 5 (2026-09-25): backups are kept — a snapshot is the way back from a delete' },
    chat: { retained: 'owner ruling 5 (2026-09-25): backups are kept — a snapshot is the way back from a delete' },
  },
  cardStorage: {
    character: { retained: 'profile-shared, like upstream’s one localStorage: a key this card wrote may be one another card reads' },
    chat: 'unkeyed',
  },
  worldbooks: {
    character: { retained: 'a book is the user’s world info, possibly edited; removing a card is not a statement about it' },
    chat: 'unkeyed',
  },
  connections: { character: 'unkeyed', chat: 'unkeyed' },
  presets: { character: 'unkeyed', chat: 'unkeyed' },
  personas: { character: 'unkeyed', chat: 'unkeyed' },
}

const SERVICE = new URL('../src/service.ts', import.meta.url)

/** The option names whose type is a store, read off `AppServiceOptions` itself. */
async function storeOptions(): Promise<string[]> {
  const source = await readFile(SERVICE, 'utf8')
  const start = source.indexOf('export interface AppServiceOptions {')
  const end = source.indexOf(String.fromCharCode(10) + '}', start)
  assert.ok(start >= 0 && end > start, 'AppServiceOptions was not found where this test reads it')
  const names: string[] = []
  for (const line of source.slice(start, end).split(String.fromCharCode(10))) {
    const match = /^ {2}(\w+)\??: (\w+)/u.exec(line)
    if (match === null) continue
    const type = match[2] ?? ''
    if (/Store$/u.test(type) || type === 'CharacterLibrary') names.push(match[1] ?? '')
  }
  return names
}

/** The body of one handler arm, from its key to the next arm at the same indent. */
async function handlerBody(method: string): Promise<string> {
  const source = await readFile(SERVICE, 'utf8')
  const start = source.indexOf(`      '${method}': async`)
  assert.ok(start >= 0, `no '${method}' handler`)
  const next = source.slice(start + 1).search(/\n {6}'[\w.]+': /u)
  return source.slice(start, next < 0 ? undefined : start + 1 + next)
}

test('every store the service is composed with is classified for both deletes', async () => {
  const stores = await storeOptions()
  // Premise: the reader found the stores, so an empty list cannot pass as
  // "nothing unclassified".
  assert.ok(stores.length >= 15, `only ${String(stores.length)} store options were read: ${stores.join(', ')}`)
  const missing = stores.filter(name => LIFECYCLE[name] === undefined)
  assert.deepEqual(missing, [],
    `these stores have no lifecycle row: ${missing.join(', ')}. Decide for each whether deleting a character `
    + 'and deleting a chat forgets it, or retains it with a reason — ids are re-minted, so a leftover is a stranger’s')
  const stale = Object.keys(LIFECYCLE).filter(name => !stores.includes(name))
  assert.deepEqual(stale, [], `these rows name stores the service no longer has: ${stale.join(', ')}`)
})

test('every store classified as forgotten is forgotten by the delete handler', async () => {
  const bodies = { character: await handlerBody('character.delete'), chat: await handlerBody('chat.delete') }
  let checked = 0
  for (const [name, row] of Object.entries(LIFECYCLE)) {
    for (const kind of ['character', 'chat'] as const) {
      if (row[kind] !== 'forget') continue
      const pattern = row.call?.[kind]
      assert.ok(pattern !== undefined, `${name} is forgotten on ${kind} delete but names no call to look for`)
      assert.match(bodies[kind], pattern, `${kind}.delete does not forget ${name}`)
      checked += 1
    }
  }
  // A floor, so a table whose rows all became 'unkeyed' cannot pass by
  // checking nothing.
  assert.ok(checked >= 14, `only ${String(checked)} forget calls were checked`)
})

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: 'An archivist.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  traces: CacheTraceStore
  bindings: WorldbookBindingStore
  backups: BackupStore
  dir: string
  /** One sent turn, settled, in a fresh chat; its id. */
  played: () => Promise<string>
}

async function fixture(t: TestContext): Promise<Fixture> {
  let ends = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Noted.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Noted.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let stores: { traces: CacheTraceStore, bindings: WorldbookBindingStore, backups: BackupStore } | undefined
  const { handlers, dir } = await createTestService(t, async ({ dir }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    stores = {
      traces: new CacheTraceStore(join(dir, 'cache-trace'), { keep: 8 }),
      bindings: new WorldbookBindingStore(join(dir, 'worldbook-bindings.json')),
      backups: new BackupStore(join(dir, 'chats')),
    }
    return {
      stream,
      backups: stores.backups,
      cacheTrace: stores.traces,
      worldbookBindings: stores.bindings,
      broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
      userName: 'Traveller',
    }
  }, 'iris-lifecycle-')
  assert.ok(stores !== undefined)
  const { traces, bindings, backups } = stores
  return {
    handlers, traces, bindings, backups, dir,
    played: async () => {
      const { view } = await handlers['chat.create']({ characterId: 'aria' })
      const waited = ends + 1
      await handlers['chat.send']({ chatId: view.chatId, text: 'Where are the maps?' })
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
      return view.chatId
    },
  }
}

test('deleting a chat removes its cache traces and keeps its backups', async (t) => {
  const f = await fixture(t)
  const chatId = await f.played()
  assert.ok((await f.traces.list(chatId)).length > 0, 'premise: the turn left a trace')
  const snapshot = await f.backups.snapshot(chatId, 'cleanup', 'aria')

  await f.handlers['chat.delete']({ chatId })

  assert.deepEqual(await f.traces.list(chatId), [], 'the deleted conversation’s traces are still there')
  assert.equal(existsSync(join(f.dir, 'cache-trace', chatId)), false, 'its trace directory is still there')
  assert.equal(existsSync(f.backups.locate(snapshot.backupId)), true, 'the backup went with the conversation')
})

test('deleting a character forgets its world-info binding and its chats’ traces, and keeps chats and backups', async (t) => {
  const f = await fixture(t)
  const chatId = await f.played()
  await f.bindings.set('aria', {
    name: 'Aria’s book', sourceHash: 's', materialisedHash: 'm', origin: 'card-name', at: 1,
  })
  assert.ok(await f.bindings.get('aria') !== undefined, 'premise: the binding is stored')
  assert.ok((await f.traces.list(chatId)).length > 0, 'premise: the turn left a trace')
  const snapshot = await f.backups.snapshot(chatId, 'cleanup', 'aria')

  await f.handlers['character.delete']({ characterId: 'aria' })

  assert.equal(await f.bindings.get('aria'), undefined, 'the binding survived its character')
  // Read back through a fresh store, so the answer is the file and not a cache.
  const reread = new WorldbookBindingStore(join(f.dir, 'worldbook-bindings.json'))
  assert.equal(await reread.get('aria'), undefined, 'the forgotten binding is still on disk')
  assert.deepEqual(await f.traces.list(chatId), [], 'the character’s conversations kept their traces')
  assert.equal(existsSync(join(f.dir, 'chats', `${chatId}.jsonl`)), true, 'the conversation itself went with the card')
  assert.equal(existsSync(f.backups.locate(snapshot.backupId)), true, 'the backup went with the card')
})
