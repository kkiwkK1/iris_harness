import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { DEFAULT_PROFILE, profilePaths } from '../src/paths.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Profile isolation.
 *
 * Multi-profile was a founding decision and the storage layer is shaped for it,
 * so what is worth guarding is the property that shape exists for: one
 * profile's data never lands in another's. The derivation lives in one function
 * precisely so a store added later cannot be the one that forgot — these tests
 * assert against that function and against two services running side by side.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A stream that answers with one line. */
const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'A reply.' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A reply.' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Build a service over one profile of a shared data directory. */
async function serviceFor(dataDir: string, profile: string): Promise<Handlers> {
  const paths = profilePaths(dataDir, profile)
  await mkdir(paths.characters, { recursive: true })
  await writeFile(join(paths.characters, 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(paths.characters, '/iris/avatar')
  const chats = new ChatStore(paths.chats, library)
  const settings = new SettingsStore(paths.settings, { provider: 'test', model: 'test-model' })
  const extensionSettings = new ExtensionSettingsStore(paths.extensionSettings)

  return new IrisAppService({
    stream,
    library,
    chats,
    settings,
    extensionSettings,
    broadcast: (_event: IrisEvent) => {},
    userName: 'Traveller',
  }).handlers()
}

test('the default profile is SillyTavern’s own layout', () => {
  const paths = profilePaths('/data')
  const asPosix = (value: string): string => value.replaceAll('\\', '/')

  // `data/default-user/characters` is exactly where an existing SillyTavern
  // install keeps its cards, so pointing dataDir at one finds them in place.
  assert.equal(DEFAULT_PROFILE, 'default-user')
  assert.match(asPosix(paths.characters), /\/data\/default-user\/characters$/)
  assert.match(asPosix(paths.chats), /\/data\/default-user\/chats$/)
  assert.match(asPosix(paths.settings), /\/data\/default-user\/settings\.json$/)
})

test('every stored thing sits under the profile, with nothing left beside it', () => {
  const paths = profilePaths('/data', 'second')
  const asPosix = (value: string): string => value.replaceAll('\\', '/')

  // The point of one derivation: if a path ever escaped the profile root, the
  // store that produced it would be the one writing into a shared space.
  for (const [name, value] of Object.entries(paths)) {
    if (name === 'root') continue
    assert.ok(
      asPosix(value).startsWith(`${asPosix(paths.root)}/`),
      `${name} (${value}) is not inside the profile root`,
    )
  }
})

test('a profile name that would escape the data directory is refused', () => {
  // The name arrives from configuration and becomes a directory. Unchecked, a
  // `..` in it puts one profile's data inside another's.
  for (const bad of ['..', '../elsewhere', 'a/b', 'a\\b', '']) {
    assert.throws(() => profilePaths('/data', bad), /not a valid identifier/, `accepted "${bad}"`)
  }
})

test('two profiles in one data directory do not see each other', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'iris-profiles-'))
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }) })

  const first = await serviceFor(dataDir, 'alice')
  const second = await serviceFor(dataDir, 'bob')

  const created = await first['chat.create']({ characterId: 'aria' })
  await first['chat.rename']({ chatId: created.view.chatId, title: 'Alice’s conversation' })
  await first['settings.set']({ settings: { temperature: 1.5 } })
  await first['script.setExtensionSettings']({ characterId: 'aria', settings: { secret: 'alice only' } })

  // Alice's chat, settings and card data are hers alone.
  assert.equal((await first['chat.list']({})).chats.length, 1)
  assert.equal((await second['chat.list']({})).chats.length, 0, 'bob sees none of alice’s conversations')
  assert.equal((await second['settings.get']({})).settings.temperature, undefined)
  assert.equal((await first['settings.get']({})).settings.temperature, 1.5)

  const bobChat = await second['chat.create']({ characterId: 'aria' })
  const bobContext = await second['script.context']({ chatId: bobChat.view.chatId, characterId: 'aria' })
  assert.deepEqual(bobContext.context.extensionSettings, {}, 'a card gets nothing another profile stored')

  // And on disk they are separate trees, with nothing loose at the root.
  const roots = (await readdir(dataDir)).sort()
  assert.deepEqual(roots, ['alice', 'bob'])
})

test('opening another profile’s chat by id finds nothing', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'iris-profiles-'))
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }) })

  const first = await serviceFor(dataDir, 'alice')
  const second = await serviceFor(dataDir, 'bob')
  const created = await first['chat.create']({ characterId: 'aria' })

  // Ids are not secrets and a browser can send any string; isolation has to come
  // from where the store looks, not from the id being unguessable.
  await assert.rejects(
    () => second['chat.open']({ chatId: created.view.chatId }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})
