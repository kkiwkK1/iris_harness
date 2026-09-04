import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { ChatCompletionPreset } from '@iris/preset'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { AppError } from '../src/errors.ts'
import { CharacterLibrary } from '../src/library.ts'
import { PresetStore } from '../src/presets.ts'
import { SettingsStore } from '../src/settings.ts'
import { IrisAppService, presetScalarPatch, type Handlers } from '../src/service.ts'

/**
 * The preset switch and the prompt manager, as the protocol serves them.
 *
 * The mechanism under test is upstream's two layers: preset **files** are
 * snapshots, and the manager edits live state on top of the active one — with
 * the assembler reading the live body, and a switch writing the scalars it acts
 * on into the settings layer. What the tests guard is the seams a silent wrong
 * answer hides in: a switch that does not reach the assembler, a toggle that
 * does not persist, a manager view that disagrees with what a generation would
 * actually assemble.
 */

const LIBRARY_PRESET: ChatCompletionPreset = {
  temperature: 0.3,
  openai_max_context: 4095,
  openai_max_tokens: 512,
  prompts: [
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Library main.', system_prompt: true },
    { identifier: 'enhanceDefinitions', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'jailbreak', name: 'Post-History', role: 'system', content: 'UJ.', system_prompt: true },
    { identifier: 'custom', name: 'Custom', role: 'system', content: 'Custom text.' },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'main', enabled: true },
    { identifier: 'enhanceDefinitions', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'custom', enabled: true },
  ] }],
} as unknown as ChatCompletionPreset

const OTHER_PRESET: ChatCompletionPreset = {
  prompts: [
    { identifier: 'main', name: 'Other Main', role: 'system', content: 'Other main.' },
  ],
} as unknown as ChatCompletionPreset

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  settings: SettingsStore
  presets: PresetStore
  dir: string
}

async function fixture(
  t: TestContext,
  options: {
    /** The preset the composition configured, before any switch. */
    preset?: ChatCompletionPreset
    /** Preset files the profile's library starts with. */
    library?: readonly { name: string, body: ChatCompletionPreset }[]
    /** An install directory to point `sillyTavernDir` at. */
    install?: string
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-preset-mgr-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const stream: StreamFn = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const presets = new PresetStore(join(dir, 'presets'))
  for (const row of options.library ?? []) await presets.save(row.name, row.body)

  const handlers = new IrisAppService({
    stream, library,
    chats: new ChatStore(join(dir, 'chats'), library),
    settings, presets,
    broadcast: () => {},
    userName: 'U',
    ...options.preset === undefined ? {} : { preset: options.preset },
    ...options.install === undefined ? {} : { sillyTavernDir: options.install },
  }).handlers()

  return { handlers, settings, presets, dir }
}

test('preset.list names the library, the active preset and what the install offers', async (t) => {
  const installDir = await mkdtemp(join(tmpdir(), 'iris-install-'))
  t.after(async () => { await rm(installDir, { recursive: true, force: true }) })
  await mkdir(join(installDir, 'OpenAI Settings'), { recursive: true })
  await writeFile(join(installDir, 'OpenAI Settings', 'FromInstall.json'), JSON.stringify(OTHER_PRESET), 'utf8')

  const { handlers } = await fixture(t, {
    preset: LIBRARY_PRESET,
    library: [{ name: 'Local', body: LIBRARY_PRESET }],
    install: installDir,
  })

  const listed = await handlers['preset.list']({})
  assert.deepEqual(listed.presets, [{ name: 'Local' }])
  assert.equal(listed.active, undefined, 'nothing has been switched, so nothing is active')
  assert.deepEqual(listed.install, ['FromInstall'])
})

test('preset.select swaps the assembler’s preset and persists the choice for the next boot', async (t) => {
  const { handlers, settings, dir } = await fixture(t, {
    preset: LIBRARY_PRESET,
    library: [{ name: 'Other', body: OTHER_PRESET }],
  })

  const answer = await handlers['preset.select']({ name: 'Other' })
  assert.equal(answer.active, 'Other')
  assert.equal(answer.manager.name, 'Other')
  assert.deepEqual(answer.manager.prompts.map(prompt => prompt.id), ['main'])

  // The assembler reads the live body: a card asking what preset is in use
  // must hear the one that will run, not the one the composition configured.
  const readBack = await handlers['script.getPreset']({ name: 'in_use' })
  assert.equal(readBack.prompts.length, 1, 'the swapped-in preset is what a card now reads')
  assert.equal(readBack.prompts[0]?.content, 'Other main.')

  // The scalars the switch acts on landed in the global settings layer…
  const global = await settings.get(undefined)
  assert.equal(global.temperature, OTHER_PRESET['temperature'])
  assert.equal(global.contextWindow, OTHER_PRESET['openai_max_context'])

  // …and the choice itself is on disk, where the next boot reads it back.
  const file = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
    preset?: { name?: string, body?: { prompts?: unknown[] } }
  }
  assert.equal(file.preset?.name, 'Other')
  assert.ok(Array.isArray(file.preset?.body?.prompts))
})

test('the manager’s toggles and orders write through to the persisted state', async (t) => {
  const { handlers, settings } = await fixture(t, {
    library: [{ name: 'Active', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Active' })

  // A prompt the manager may toggle, toggled: the reply and the persisted body
  // must agree.
  const toggled = await handlers['preset.setEnabled']({ id: 'custom', enabled: false })
  assert.equal(toggled.manager.prompts.find(prompt => prompt.id === 'custom')?.enabled, false)
  const stored = await settings.presetBody()
  const storedCustom = stored?.prompt_order?.[0]?.order.find(row => row.identifier === 'custom')
  assert.equal(storedCustom?.enabled, false)

  // Upstream's rule: a *marker* outside the force-toggle list has no toggle at
  // all. `enhanceDefinitions` is that marker; refusing is the honest answer.
  await assert.rejects(
    () => handlers['preset.setEnabled']({ id: 'enhanceDefinitions', enabled: false }),
    (error: unknown) => error instanceof AppError && error.code === 'invalid-request',
  )

  // Moving the custom prompt before `main` reorders what the view shows.
  const moved = await handlers['preset.move']({ id: 'custom', index: 0 })
  assert.equal(moved.manager.prompts[0]?.id, 'custom')
})

test('a prompt the ordering omits is off, and toggling it on adds it at the end', async (t) => {
  const { handlers } = await fixture(t, {
    library: [{ name: 'Active', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Active' })

  // `jailbreak` is in the preset's prompts but absent from its prompt_order —
  // the file's own way of keeping a prompt off.
  const view = await handlers['preset.view']({})
  const jailbreak = view.manager.prompts.find(prompt => prompt.id === 'jailbreak')
  assert.equal(jailbreak?.enabled, false)
  assert.equal(jailbreak?.toggleable, true)

  const enabled = await handlers['preset.setEnabled']({ id: 'jailbreak', enabled: true })
  const ordered = enabled.manager.prompts
  assert.equal(ordered.find(prompt => prompt.id === 'jailbreak')?.enabled, true)
  assert.equal(ordered[ordered.length - 1]?.id, 'jailbreak', 'the repair lands at the end, where the view showed it')
})

test('upsert creates at the end enabled, refuses to overwrite a built-in slot, and edits in place', async (t) => {
  const { handlers, settings } = await fixture(t, {
    library: [{ name: 'Active', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Active' })

  // A card's expected prompt appears by identifier, created rather than refused.
  const created = await handlers['preset.upsertPrompt']({ prompt: {
    identifier: 'card-added', name: 'Card Added', role: 'system', content: 'Extra.',
  } })
  const row = created.manager.prompts.find(prompt => prompt.id === 'card-added')
  assert.equal(row?.enabled, true, 'an addition that does nothing is the bad kind of surprise')
  // Last in the *ordering* — the view still shows unpositioned prompts
  // (`jailbreak`) behind it, which is its documented sort.
  const ordered = (await settings.presetBody())?.prompt_order?.[0]?.order
  assert.equal(ordered?.[ordered.length - 1]?.identifier, 'card-added')

  // Creating over a built-in slot would put text where the host fills in live
  // data — refused by name. (`nsfw` is a built-in the active preset does not
  // carry, so this is a creation, not an edit.)
  await assert.rejects(
    () => handlers['preset.upsertPrompt']({ prompt: { identifier: 'nsfw', content: 'mine' } }),
    (error: unknown) => error instanceof Error && error.message.includes('built-in slot'),
  )

  // Editing an existing prompt keeps its position and toggle.
  const before = (await handlers['preset.view']({})).manager.prompts.findIndex(prompt => prompt.id === 'custom')
  await handlers['preset.upsertPrompt']({ prompt: { identifier: 'custom', content: 'Replaced.' } })
  const after = (await handlers['preset.view']({})).manager.prompts.findIndex(prompt => prompt.id === 'custom')
  assert.equal(after, before)
  // The view carries no content; the edit is judged on the persisted body,
  // which is what a generation reads.
  const body = await settings.presetBody()
  const edited = body?.prompts.find(prompt => prompt.identifier === 'custom')
  assert.equal((edited as { content?: string } | undefined)?.content, 'Replaced.')
})

test('remove takes a non-system prompt out of prompts and orders; a system prompt is refused', async (t) => {
  const { handlers, settings } = await fixture(t, {
    library: [{ name: 'Active', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Active' })

  const removed = await handlers['preset.removePrompt']({ id: 'custom' })
  assert.equal(removed.manager.prompts.find(prompt => prompt.id === 'custom'), undefined)
  const body = await settings.presetBody()
  assert.equal(body?.prompts.some(prompt => prompt.identifier === 'custom'), false)
  assert.equal(
    body?.prompt_order?.[0]?.order.some(row => row.identifier === 'custom'),
    false,
    'the ordering kept a row for a prompt that no longer exists',
  )

  await assert.rejects(
    () => handlers['preset.removePrompt']({ id: 'main' }),
    (error: unknown) => error instanceof Error && error.message.includes('system prompt'),
  )
})

test('preset.save persists the live state under a name; saving a nameless state names it', async (t) => {
  const { handlers, presets } = await fixture(t, {
    library: [{ name: 'Active', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Active' })
  await handlers['preset.upsertPrompt']({ prompt: { identifier: 'scratch', name: 'Scratch', content: 'x' } })

  const saved = await handlers['preset.save']({ name: 'Snapshot' })
  assert.ok(saved.presets.some(row => row.name === 'Snapshot'))
  assert.ok(await presets.has('Snapshot'))
  // The snapshot carries the manager's edit, because the manager's state is
  // what "save" means.
  const body = await presets.read('Snapshot')
  assert.ok(body.prompts.some(prompt => prompt.identifier === 'scratch'))
  assert.equal(saved.active, 'Active')

  // Saving while only the composition's built-in is active (no library name)
  // names the state: it became a library preset by being saved.
  const bare = await fixture(t, { preset: LIBRARY_PRESET })
  const adopted = await bare.handlers['preset.save']({ name: 'Named' })
  assert.equal(adopted.active, 'Named')
})

test('deleting the active preset leaves the state live but unnamed', async (t) => {
  const { handlers } = await fixture(t, {
    library: [{ name: 'Active', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Active' })

  const answer = await handlers['preset.delete']({ name: 'Active' })
  assert.deepEqual(answer.presets, [])
  assert.equal(answer.active, undefined)
  // The manager still answers: the body is in memory, and the next boot's
  // fallback is the composition's preset — which is what "unnamed" means.
  const view = await handlers['preset.view']({})
  assert.equal(view.manager.name, undefined)
  assert.ok(view.manager.prompts.length > 0)
})

test('preset.read returns the file body an export downloads', async (t) => {
  const { handlers, presets } = await fixture(t, {
    library: [{ name: 'Exported', body: LIBRARY_PRESET }],
  })
  const answer = await handlers['preset.read']({ name: 'Exported' })
  assert.equal(answer.name, 'Exported')
  assert.equal(answer.preset['temperature'], LIBRARY_PRESET['temperature'])
  assert.ok(await presets.has('Exported'))
})

test('preset.import copies from the install and reports each skip with its reason', async (t) => {
  const installDir = await mkdtemp(join(tmpdir(), 'iris-install-'))
  t.after(async () => { await rm(installDir, { recursive: true, force: true }) })
  await mkdir(join(installDir, 'OpenAI Settings'), { recursive: true })
  await writeFile(join(installDir, 'OpenAI Settings', 'Good.json'), JSON.stringify(LIBRARY_PRESET), 'utf8')
  await writeFile(join(installDir, 'OpenAI Settings', 'NotOne.json'), '{"x": 1}', 'utf8')

  const { handlers } = await fixture(t, { install: installDir })
  const answer = await handlers['preset.import']({})

  assert.deepEqual(answer.imported, ['Good'])
  const skipped = answer.skipped.find(row => row.name === 'NotOne')
  assert.ok(skipped !== undefined)
  assert.match(skipped.reason, /not a Chat Completion preset/)
  assert.ok(answer.presets.some(row => row.name === 'Good'))
})

test('a preset switch moves the assembly window: openai_max_context is what the budget reads', async (t) => {
  const { handlers, settings } = await fixture(t, {
    library: [{ name: 'Narrow', body: LIBRARY_PRESET }],
  })
  await handlers['preset.select']({ name: 'Narrow' })

  // The switch applied the preset's window to the global layer, and the merged
  // view every chat assembles under now carries it — a preset tuned for 4 095
  // assembled against 32 768 would silently trim a different conversation.
  const merged = await settings.get(undefined)
  assert.equal(merged.contextWindow, 4095)
})

test('presetScalarPatch maps the keys this host acts on, and skips garbage', () => {
  const patch = presetScalarPatch({
    temperature: 0.2,
    openai_max_context: 65536,
    openai_max_tokens: 700,
    top_p: 0.9,
    reasoning_effort: 'high',
  } as unknown as ChatCompletionPreset)
  assert.equal(patch['temperature'], 0.2)
  assert.equal(patch['contextWindow'], 65536)
  assert.equal(patch['maxTokens'], 700)
  assert.equal(patch['topP'], 0.9)
  assert.equal(patch['reasoningEffort'], 'high')

  // A value the host would refuse if typed by hand must not arrive by preset:
  // one bad field skips, it does not fail the switch.
  const garbage = presetScalarPatch({
    temperature: 'high',
    top_k: 'lots',
    reasoning_effort: 'mega',
  } as unknown as ChatCompletionPreset)
  assert.deepEqual(garbage, {})
})
