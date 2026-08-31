import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore } from '../src/connections.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Saved connections.
 *
 * The property worth guarding is the one upstream loses: a profile's displayed
 * name and its contents cannot disagree, because nothing displayed is stored.
 * Measured on the user's own install, their selected profile reads
 * `deepseek deepseek-chat - Default` and points at a Gemini model on another
 * endpoint — true when written, wrong ever since.
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

const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function fixture(t: TestContext): Promise<{
  handlers: Handlers
  settings: SettingsStore
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-conn-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'default', model: 'local-model' })
  const connections = new ConnectionStore(join(dir, 'connections.json'))

  const handlers = new IrisAppService({
    stream, library, chats, settings, connections,
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  return { handlers, settings, dir }
}

test('a profile’s summary follows its contents, because it is not stored', async (t) => {
  const { handlers, dir } = await fixture(t)

  const created = await handlers['connection.save']({ provider: 'deepseek', model: 'deepseek-chat' })
  const id = created.profiles[0]?.id
  assert.ok(id !== undefined)
  assert.equal(created.profiles[0]?.summary, 'deepseek · deepseek-chat')

  // The exact move that breaks upstream: change the model, keep the profile.
  const updated = await handlers['connection.save']({ id, provider: 'openrouter', model: 'gemini-2.5-pro' })
  assert.equal(updated.profiles[0]?.summary, 'openrouter · gemini-2.5-pro')

  // And nothing derived is on disk to go stale.
  const file = JSON.parse(await readFile(join(dir, 'connections.json'), 'utf8')) as { profiles: Record<string, unknown>[] }
  assert.equal('summary' in (file.profiles[0] ?? {}), false, 'the summary is derived, never written')
})

test('a user’s own label is kept and never overwritten by a derived one', async (t) => {
  const { handlers } = await fixture(t)

  const saved = await handlers['connection.save']({
    label: '便宜的那个',
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const changed = await handlers['connection.save']({ id, label: '便宜的那个', provider: 'x', model: 'y' })
  // The label is the user's words, so it cannot go stale — only they can change
  // it. The summary next to it tells the truth about the contents.
  assert.equal(changed.profiles[0]?.label, '便宜的那个')
  assert.equal(changed.profiles[0]?.summary, 'x · y')
})

test('activating a profile applies it through the settings guard', async (t) => {
  const { handlers } = await fixture(t)
  const saved = await handlers['connection.save']({
    provider: 'deepseek',
    model: 'deepseek-chat',
    sampling: { temperature: 0.7, topP: 0.9 },
  })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  const applied = await handlers['connection.activate']({ id })

  assert.equal(applied.settings.provider, 'deepseek')
  assert.equal(applied.settings.model, 'deepseek-chat')
  assert.equal(applied.settings.temperature, 0.7)
  assert.equal(applied.activeId, id)
  assert.equal((await handlers['connection.list']({})).activeId, id)
})

test('a profile cannot store a value that setting it by hand would be refused', async (t) => {
  const { handlers } = await fixture(t)

  // Sampling goes through the same `sanitize` a settings patch does, so a
  // profile is not a way around the range checks.
  await assert.rejects(
    () => handlers['connection.save']({ provider: 'p', model: 'm', sampling: { topP: 4 } }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
})

test('activating for one chat leaves the global route alone', async (t) => {
  const { handlers } = await fixture(t)
  const chat = await handlers['chat.create']({ characterId: 'aria' })
  const saved = await handlers['connection.save']({ provider: 'deepseek', model: 'deepseek-chat' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)

  await handlers['connection.activate']({ id, chatId: chat.view.chatId })

  assert.equal((await handlers['settings.get']({ chatId: chat.view.chatId })).settings.model, 'deepseek-chat')
  assert.equal((await handlers['settings.get']({})).settings.model, 'local-model', 'the global layer is untouched')
})

test('deleting the active profile clears the active id with it', async (t) => {
  const { handlers } = await fixture(t)
  const saved = await handlers['connection.save']({ provider: 'p', model: 'm' })
  const id = saved.profiles[0]?.id
  assert.ok(id !== undefined)
  await handlers['connection.activate']({ id })

  const after = await handlers['connection.delete']({ id })

  // Pointing at a profile that is gone would report an active connection
  // nobody can open.
  assert.deepEqual(after.profiles, [])
  assert.equal(after.activeId, undefined)

  await assert.rejects(
    () => handlers['connection.delete']({ id }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('profiles survive a restart', async (t) => {
  const { handlers, dir } = await fixture(t)
  await handlers['connection.save']({ label: 'kept', provider: 'p', model: 'm', preset: 'Antennae_v18' })

  const reopened = new ConnectionStore(join(dir, 'connections.json'))
  const { profiles } = await reopened.list()

  assert.equal(profiles.length, 1)
  assert.equal(profiles[0]?.label, 'kept')
  assert.equal(profiles[0]?.preset, 'Antennae_v18')
  assert.equal(profiles[0]?.summary, 'p · m · Antennae_v18')
})
