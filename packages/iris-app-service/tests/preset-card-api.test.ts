/**
 * The preset arms a **card** reaches, and the snapshot the synchronous members
 * read.
 *
 * The distinction from `preset-manager.test.ts`, which covers the same store: it
 * is about the panel's acts (select, save, toggle, import), and this is about a
 * card script's. The two share a store on purpose and must not share a *meaning*
 * — a card's delete has the same consequences as a person's, which is why three
 * of these arms call the panel's rather than the store's, and why that is
 * asserted here rather than assumed.
 *
 * @module @iris/app-service/tests/preset-card-api
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  OMITTED_EXTENSIONS_KEY,
  TH_DEFAULT_PRESET,
  type TavernHelperPreset,
} from '@iris/compat-tavernhelper'
import type { ChatCompletionPreset } from '@iris/preset'
import type { GenerationSettings } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { FRAME_PRESET_LIMIT, PresetStore, livePresetFields } from '../src/presets.ts'
import { SettingsStore } from '../src/settings.ts'
import { IrisAppService, presetScalarPatch, type Handlers } from '../src/service.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

/** A preset file with one ordered prompt and whatever else a test needs. */
function file(overrides: Record<string, unknown> = {}): ChatCompletionPreset {
  return {
    prompts: [{ identifier: 'main', name: 'M', role: 'system', content: 'main', system_prompt: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
    ...overrides,
  } as unknown as ChatCompletionPreset
}

interface Fixture {
  handlers: Handlers
  settings: SettingsStore
  presets: PresetStore
  chatId: string
  dir: string
}

async function fixture(
  t: TestContext,
  options: {
    preset?: ChatCompletionPreset
    presetName?: string
    library?: readonly { name: string, body: ChatCompletionPreset }[]
    /** Compose the host **without** a preset library, to test the refusals. */
    storeless?: boolean
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-preset-card-'))
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
    settings,
    ...options.storeless === true ? {} : { presets },
    broadcast: () => {},
    userName: 'U',
    ...options.preset === undefined ? {} : { preset: options.preset },
    ...options.presetName === undefined ? {} : { presetName: options.presetName },
  }).handlers()

  const { view } = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, settings, presets, chatId: view.chatId, dir }
}

/**
 * The write arm, with the one cast the wire shape needs.
 *
 * `script.createOrReplacePreset`'s schema types `preset` as records of unknown
 * — deliberately, because `extensions` is open upstream and a field-by-field
 * schema would silently drop what it did not name (see the schema's own note).
 * A typed `TavernHelperPreset` is not assignable to that, so the cast lives
 * here instead of at every call site, exactly as the frame keeps one.
 * @param handlers - the fixture's handlers.
 * @param request - name, body and the optional create-only flag.
 * @returns the arm's answer.
 */
async function write(
  handlers: Handlers,
  request: { name: string, preset: TavernHelperPreset, ifAbsent?: boolean },
) {
  return handlers['script.createOrReplacePreset']({
    name: request.name,
    preset: request.preset as unknown as { prompts: Record<string, unknown>[] },
    ...request.ifAbsent === undefined ? {} : { ifAbsent: request.ifAbsent },
  })
}

/** The snapshot's preset half, for the chat the fixture created. */
async function snapshotPreset(fx: Fixture) {
  const { context } = await fx.handlers['script.context']({ chatId: fx.chatId, characterId: 'aria' })
  return context.preset
}

test('the snapshot carries the names, the loaded name and the body as text', async (t) => {
  const fx = await fixture(t, {
    preset: file(),
    presetName: 'Mine',
    library: [{ name: 'Mine', body: file() }, { name: 'Other', body: file() }],
  })
  const preset = await snapshotPreset(fx)
  assert.ok(preset !== undefined)

  // `'in_use'` first, because upstream's `getPresetNames` puts it first
  // (`preset.ts:571`) and a card reading `names[0]` gets the running preset there.
  assert.deepEqual(preset.names, ['in_use', 'Mine', 'Other'])
  assert.equal(preset.loaded, 'Mine')
  assert.equal(preset.refusal, undefined)

  /*
   * **Text, not an object**, and this assertion is the one that catches a
   * well-meaning "simplification". The body is structured-cloned into every live
   * frame, and measured 2026-09-10 on the heaviest real preset a string copies
   * in 0.252 ms against 0.481 ms for the object graph — while a frame that never
   * calls `getPreset` skips the 0.304 ms parse entirely. Sending an object would
   * pay both, in every frame, whether or not anything asked.
   */
  assert.equal(typeof preset.inUse, 'string')
  const body = JSON.parse(preset.inUse ?? '') as TavernHelperPreset
  assert.deepEqual(body.prompts.map(prompt => prompt.id), ['main'])
  assert.equal(body.prompts[0]?.content, 'main')
})

test('the snapshot’s body leaves out the two heavy extension keys and names them', async (t) => {
  /*
   * Measured over the eight real presets in the two local corpora on
   * 2026-09-10: the heaviest whole `Preset` is 5,961 KiB, of which 5,040 KiB is
   * `extensions.tavern_helper` (that preset's own script library) and 202 KiB
   * `extensions.regex_scripts`. At `FRAME_COUNT_LIMIT` 18 that is 105 MiB of
   * clone per reading window, for two keys no body in the 1,694-source corpus
   * reads. Without them the same preset is 719 KiB.
   */
  const fx = await fixture(t, {
    preset: file({
      extensions: {
        tavern_helper: { scripts: [{ id: 'heavy' }], variables: {} },
        regex_scripts: [{ scriptName: 'r' }],
        SPreset: { third_party: true },
      },
    }),
  })
  const preset = await snapshotPreset(fx)
  const body = JSON.parse(preset?.inUse ?? '') as TavernHelperPreset

  assert.deepEqual(body.extensions[OMITTED_EXTENSIONS_KEY], ['tavern_helper', 'regex_scripts'])
  assert.equal(body.extensions['tavern_helper'], undefined)
  assert.equal(body.extensions['regex_scripts'], undefined)
  // Every other key rides through: `SPreset` is 202 KiB of a third-party
  // extension's state in one real preset, and a card may read it.
  assert.deepEqual(body.extensions['SPreset'], { third_party: true })
})

test('the round-trip arm answers the whole body, extensions included', async (t) => {
  /*
   * The other half of the trim decision, and the reason it is safe: the
   * asynchronous arm is one round trip on demand rather than a clone per frame,
   * so it carries what the frame's copy cannot. Without this, a card's
   * `setPreset` would read a trimmed preset and write it straight back.
   */
  const fx = await fixture(t, {
    preset: file({ extensions: { tavern_helper: { scripts: [{ id: 'heavy' }], variables: {} } } }),
  })
  const { preset } = await fx.handlers['script.getPreset']({ name: 'in_use' })
  const body = preset as unknown as TavernHelperPreset
  assert.deepEqual(body.extensions['tavern_helper'], { scripts: [{ id: 'heavy' }], variables: {} })
  assert.equal(body.extensions[OMITTED_EXTENSIONS_KEY], undefined)
})

test('a body past the frame ceiling is refused with its size, not silently dropped', async (t) => {
  /*
   * The ceiling is a guard, not a tuning: it exists so a preset nobody has
   * measured cannot turn one card's synchronous read into a page that never
   * paints. What is asserted is the *shape* of the refusal — a sentence
   * carrying the size, so a person can act on it — because a snapshot that
   * simply omitted the body would leave `getPreset` unable to say why.
   */
  const huge = 'x'.repeat(FRAME_PRESET_LIMIT + 1024)
  const fx = await fixture(t, {
    preset: file({
      prompts: [{ identifier: 'main', name: 'M', role: 'system', content: huge, system_prompt: true }],
    }),
  })
  const preset = await snapshotPreset(fx)
  assert.equal(preset?.inUse, undefined)
  assert.match(preset?.refusal ?? '', /KiB/u)
  // The names still travel: `getPresetNames` and `loadPreset` are unaffected by
  // a body too big to send, and taking them away would turn one member's limit
  // into three members' outage.
  assert.deepEqual(preset?.names, ['in_use'])
})

test('a host with no preset library carries no preset field at all', async (t) => {
  /*
   * Absence rather than `['in_use']`, and the line is the one every other
   * preset arm draws: a host with no library cannot honour `loadPreset` or
   * `createPreset` either, and a one-name list would invite a card to offer a
   * switch that can never land. The frame turns the absence into "this host
   * keeps no preset library", which is the true sentence.
   */
  const fx = await fixture(t, { storeless: true, preset: file() })
  assert.equal(await snapshotPreset(fx), undefined)
  await assert.rejects(() => fx.handlers['script.loadPreset']({ name: 'x' }), /preset library/u)
  await assert.rejects(() => fx.handlers['script.deletePreset']({ name: 'x' }), /preset library/u)
})

test('the loaded name is absent, not invented, when the running body has none', async (t) => {
  const fx = await fixture(t, { preset: file() })
  const preset = await snapshotPreset(fx)
  /*
   * A state upstream cannot reach and this host can: a composition may carry a
   * preset with no name, and `preset.delete` of the active one deliberately
   * leaves the body live and nameless. A fabricated name here would be a name
   * `getPreset` then throws on.
   */
  assert.equal(preset?.loaded, undefined)
  assert.deepEqual(preset?.names, ['in_use'])
})

test('createOrReplacePreset creates, then replaces, and says which it did', async (t) => {
  const fx = await fixture(t, { preset: file() })
  const body: TavernHelperPreset = {
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [{ id: 'mine', name: 'X', enabled: true, role: 'user', content: 'x' }],
    prompts_unused: [],
    extensions: {},
  }

  const created = await write(fx.handlers, { name: 'New', preset: body })
  assert.deepEqual(created, { created: true, restored: [] })
  const stored = await fx.presets.read('New')
  // Written in SillyTavern's own file shape, not Tavern Helper's: the file has
  // to be one an install could load.
  assert.deepEqual(stored.prompts.map(prompt => prompt.identifier), ['mine'])
  assert.deepEqual(stored.prompt_order, [{ character_id: 100001, order: [{ identifier: 'mine', enabled: true }] }])

  const replaced = await write(fx.handlers, { name: 'New', preset: body })
  assert.equal(replaced.created, false, 'the second write replaced rather than created')
})

test('ifAbsent makes the write a create, decided beside the file', async (t) => {
  const fx = await fixture(t, { preset: file(), library: [{ name: 'Taken', body: file() }] })
  const body: TavernHelperPreset = {
    settings: TH_DEFAULT_PRESET.settings,
    prompts: [{ id: 'replacement', name: 'R', enabled: true, role: 'user', content: 'r' }],
    prompts_unused: [],
    extensions: {},
  }
  const answer = await write(fx.handlers, { name: 'Taken', preset: body, ifAbsent: true })
  assert.deepEqual(answer, { created: false, restored: [] })
  /*
   * And **nothing was written**. This is the assertion that matters: without the
   * flag, `createPreset` on a taken name would have replaced the stored preset
   * and answered `false`, which reads to the card exactly like "I did nothing".
   */
  assert.deepEqual((await fx.presets.read('Taken')).prompts.map(prompt => prompt.identifier), ['main'])
  // `'in_use'` is never free: upstream's `createPreset` excludes the name and
  // its own name list contains it.
  assert.equal((await write(fx.handlers, { name: 'in_use', preset: body, ifAbsent: true })).created, false)
})

test('a write to in_use goes through the switch, so an open chat’s regex tier is refreshed', async (t) => {
  /*
   * The consequence a card's write shares with a person's. A preset carries its
   * own regex rules, and a body swapped in without the refresh leaves the
   * *previous* preset's rules rewriting the page with nothing to show it (host
   * §53). Observed through the persisted state: `#applyPreset` writes the body
   * and its scalar patch into the settings layer, which the store-only path
   * would not do.
   */
  const fx = await fixture(t, { preset: file(), presetName: 'Mine', library: [{ name: 'Mine', body: file() }] })
  const body: TavernHelperPreset = {
    settings: { ...TH_DEFAULT_PRESET.settings, temperature: 0.77, max_context: 4096 },
    prompts: [{ id: 'main', name: 'M', enabled: true, role: 'system', content: 'edited' }],
    prompts_unused: [],
    extensions: {},
  }
  await write(fx.handlers, { name: 'in_use', preset: body })

  // The running body is the edited one…
  const preset = await snapshotPreset(fx)
  const readBack = JSON.parse(preset?.inUse ?? '') as TavernHelperPreset
  assert.equal(readBack.prompts[0]?.content, 'edited')
  // …the scalar fields landed in the settings layer, which is what generates…
  assert.equal(fx.settings.get().temperature, 0.77)
  // …and the library file it was loaded from is untouched, because upstream is
  // explicit that editing `'in_use'` and saving it back are two acts
  // (`preset.d.ts:152-160`).
  assert.equal((await fx.presets.read('Mine')).prompts[0]?.content, 'main')
  assert.equal(preset?.loaded, 'Mine', 'the running body keeps the name it was loaded from')
})

test('a card writing back the frame’s trimmed copy does not delete the preset’s script library', async (t) => {
  /*
   * Upstream's own documented round trip: `const p = getPreset('in_use');
   * p.settings.should_stream = true; await replacePreset('in_use', p)`. The `p`
   * a card holds came from the frame's copy, which leaves out
   * `extensions.tavern_helper` — 5 MiB in one real preset — so writing it
   * verbatim would delete a preset's whole script library as a side effect of
   * turning streaming on, and the preset would still load.
   */
  const fx = await fixture(t, {
    preset: file({ extensions: { tavern_helper: { scripts: [{ id: 'keep' }], variables: { a: 1 } } } }),
  })
  const asFrameSeesIt = JSON.parse((await snapshotPreset(fx))?.inUse ?? '') as TavernHelperPreset
  assert.equal(asFrameSeesIt.extensions['tavern_helper'], undefined, 'the fixture must actually be trimmed')

  const answer = await write(fx.handlers, {
    name: 'in_use',
    preset: { ...asFrameSeesIt, settings: { ...asFrameSeesIt.settings, should_stream: true } },
  })
  assert.deepEqual(answer.restored, ['tavern_helper'])

  const { preset } = await fx.handlers['script.getPreset']({ name: 'in_use' })
  assert.deepEqual(
    (preset as unknown as TavernHelperPreset).extensions['tavern_helper'],
    { scripts: [{ id: 'keep' }], variables: { a: 1 } },
  )
})

test('a card that supplies the key itself is replacing it, and the restore stands aside', async (t) => {
  // The mirror image of the test above: restoring over a deliberate write would
  // make the write silently not happen.
  const fx = await fixture(t, {
    preset: file({ extensions: { tavern_helper: { scripts: [{ id: 'old' }], variables: {} } } }),
  })
  const asFrameSeesIt = JSON.parse((await snapshotPreset(fx))?.inUse ?? '') as TavernHelperPreset
  const answer = await write(fx.handlers, {
    name: 'in_use',
    preset: { ...asFrameSeesIt, extensions: { ...asFrameSeesIt.extensions, tavern_helper: { scripts: [], variables: {} } } },
  })
  assert.deepEqual(answer.restored, [])
  const { preset } = await fx.handlers['script.getPreset']({ name: 'in_use' })
  assert.deepEqual(
    (preset as unknown as TavernHelperPreset).extensions['tavern_helper'],
    { scripts: [], variables: {} },
  )
})

test('a repeated marker id is refused with upstream’s own sentence', async (t) => {
  const fx = await fixture(t, { preset: file() })
  /*
   * Upstream throws a bare `Error` for this (`preset.ts:481`) and lets it out of
   * the member, so a card's `catch` sees it. Answered `invalid-request` with
   * upstream's own text: the card's message match still works, and the wire code
   * says whose fault it was.
   */
  await assert.rejects(
    () => write(fx.handlers, {
      name: 'Dup',
      preset: {
        settings: TH_DEFAULT_PRESET.settings,
        prompts: [
          { id: 'chatHistory', name: 'a', enabled: true, role: 'system', position: { type: 'relative' } },
          { id: 'chatHistory', name: 'b', enabled: true, role: 'system', position: { type: 'relative' } },
        ],
        prompts_unused: [],
        extensions: {},
      },
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request'
      && /chatHistory/u.test((error as Error).message),
  )
  // And nothing was written under that name.
  await assert.rejects(() => fx.presets.read('Dup'))
})

test('deletePreset refuses in_use, answers false for an absent name, and clears the active name', async (t) => {
  const fx = await fixture(t, { preset: file(), presetName: 'Mine', library: [{ name: 'Mine', body: file() }] })

  /*
   * `'in_use'` answers `false` rather than being obeyed: upstream's signature
   * excludes the name and its `preset_manager.deletePreset` has no entry to
   * remove for it, so a host that deleted the running body here would destroy
   * state on a call upstream answers `false` to.
   */
  assert.deepEqual(await fx.handlers['script.deletePreset']({ name: 'in_use' }), { deleted: false })
  assert.deepEqual(await fx.handlers['script.deletePreset']({ name: 'Nope' }), { deleted: false })

  assert.deepEqual(await fx.handlers['script.deletePreset']({ name: 'Mine' }), { deleted: true })
  const preset = await snapshotPreset(fx)
  assert.deepEqual(preset?.names, ['in_use'])
  /*
   * The consequence that makes this go through the panel's arm rather than the
   * store: the active preset's *name* is the key its regex allow-list is
   * addressed by, so deleting it has to clear the name — and it leaves the body
   * live, which is honest, because it is no longer a library preset.
   */
  assert.equal(preset?.loaded, undefined)
  assert.notEqual(preset?.inUse, undefined, 'the body is still running')
})

test('the word in_use never reaches a library file of the same name', async (t) => {
  /*
   * The fixture that gives the `'in_use'` guards their teeth, and it exists
   * because a mutation said so: with no such file, dropping the check in
   * `deletePreset` changes nothing — `store.has('in_use')` is false, so the arm
   * answers `deleted: false` for a different reason and the assertion passes
   * for the implementation that has the guard *and* for the one that does not.
   *
   * `sanitizePresetName('in_use')` is `in_use`, so this file is a thing a user
   * can really have — an import from an install whose preset was named that
   * would produce it — and only then do the two implementations disagree: one
   * refuses the word, the other deletes the file. Same for the rename and the
   * switch, which is why all three are here.
   */
  const fx = await fixture(t, {
    preset: file(),
    library: [{ name: 'in_use', body: file({ temperature: 0.99 }) }],
  })

  assert.deepEqual(await fx.handlers['script.deletePreset']({ name: 'in_use' }), { deleted: false })
  assert.ok(await fx.presets.has('in_use'), 'the word must not reach the file of the same name')

  assert.deepEqual(
    await fx.handlers['script.renamePreset']({ name: 'in_use', newName: 'Copy' }),
    { renamed: false, reason: 'no-such-preset' },
  )
  assert.equal(await fx.presets.has('Copy'), false)

  assert.deepEqual(await fx.handlers['script.loadPreset']({ name: 'in_use' }), { loaded: false })
  assert.notEqual(fx.settings.get().temperature, 0.99, 'the file was not switched to')
})

test('renamePreset refuses a taken target and leaves both presets standing', async (t) => {
  /*
   * The deliberate divergence. Upstream's `renamePreset` calls `createPreset`
   * (which answers `false` and writes nothing when the name exists) and then
   * deletes the old preset **unconditionally** (`preset.ts:696-703`), so a
   * rename onto an existing name destroys the source and returns `true`.
   * Copying that would put a data loss into the compatibility floor.
   */
  const fx = await fixture(t, {
    preset: file(),
    library: [{ name: 'A', body: file() }, { name: 'B', body: file({ prompts: [] }) }],
  })
  assert.deepEqual(
    await fx.handlers['script.renamePreset']({ name: 'A', newName: 'B' }),
    { renamed: false, reason: 'name-taken' },
  )
  // Both survive, which is the whole point.
  assert.ok(await fx.presets.has('A'))
  assert.ok(await fx.presets.has('B'))

  assert.deepEqual(
    await fx.handlers['script.renamePreset']({ name: 'Nope', newName: 'C' }),
    { renamed: false, reason: 'no-such-preset' },
  )
  assert.deepEqual(
    await fx.handlers['script.renamePreset']({ name: 'in_use', newName: 'C' }),
    { renamed: false, reason: 'no-such-preset' },
  )
})

test('a rename carries the running body’s name with it', async (t) => {
  /*
   * `preset.delete` of the active preset leaves the body nameless on purpose —
   * honest for a delete, wrong for a rename, where the same preset is still
   * there under a new name. Without the re-select, `getLoadedPresetName()` would
   * answer `''` after a card renamed the preset it is playing with.
   */
  const fx = await fixture(t, { preset: file(), presetName: 'A', library: [{ name: 'A', body: file() }] })
  assert.deepEqual(await fx.handlers['script.renamePreset']({ name: 'A', newName: 'B' }), { renamed: true })

  const preset = await snapshotPreset(fx)
  assert.deepEqual(preset?.names, ['in_use', 'B'])
  assert.equal(preset?.loaded, 'B')
  assert.equal(await fx.presets.has('A'), false)
})

test('loadPreset switches through the same path the panel takes', async (t) => {
  const fx = await fixture(t, {
    preset: file(),
    presetName: 'A',
    library: [
      { name: 'A', body: file() },
      { name: 'B', body: file({ prompts: [{ identifier: 'b', name: 'B', role: 'system', content: 'b-main', system_prompt: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'b', enabled: true }] }], temperature: 0.42 }) },
    ],
  })

  assert.deepEqual(await fx.handlers['script.loadPreset']({ name: 'Nope' }), { loaded: false })
  assert.deepEqual(await fx.handlers['script.loadPreset']({ name: 'in_use' }), { loaded: false })

  assert.deepEqual(await fx.handlers['script.loadPreset']({ name: 'B' }), { loaded: true })
  const preset = await snapshotPreset(fx)
  assert.equal(preset?.loaded, 'B')
  assert.deepEqual((JSON.parse(preset?.inUse ?? '') as TavernHelperPreset).prompts.map(prompt => prompt.id), ['b'])
  /*
   * And the scalar fields reached the settings layer, which is what proves the
   * switch went through `#applyPreset` rather than only assigning the body: a
   * switch that skipped it would generate at the previous preset's temperature.
   */
  assert.equal(fx.settings.get().temperature, 0.42)
})

test('the settings half a card reads is the running one, so a chat’s override does not leak in', async (t) => {
  const fx = await fixture(t, { preset: file({ temp_openai: 0.1 }) })
  await fx.settings.set(undefined, { temperature: 0.6 })
  await fx.settings.set(fx.chatId, { temperature: 0.95 })

  const body = JSON.parse((await snapshotPreset(fx))?.inUse ?? '') as TavernHelperPreset
  /*
   * The **global** layer, not the chat's. Upstream has one settings space, so
   * `getPreset('in_use')` there reports what every chat runs with; a chat-scoped
   * override is an Iris-only layer and a preset is not where a card would look
   * for one. It also matters mechanically: one snapshot serves every frame of
   * the page, so a per-chat reading would make `getPreset` answer differently in
   * frames that are all showing the same preset.
   */
  assert.equal(body.settings.temperature, 0.6)
})

test('livePresetFields reads back every field presetScalarPatch writes', () => {
  /*
   * The pairing, asserted rather than trusted. A switch copies a preset's
   * scalar fields *out* into the settings layer; `getPreset('in_use')` has to
   * read the same fields back, or it reports the temperature the preset shipped
   * while the host generates at the one in force. One direction growing a field
   * without the other is exactly the drift this catches — and it is silent,
   * because both halves keep working on their own.
   */
  const preset: ChatCompletionPreset = {
    prompts: [],
    temperature: 0.5,
    openai_max_tokens: 111,
    openai_max_context: 2222,
    top_p: 0.8,
    top_k: 5,
    min_p: 0.01,
    repetition_penalty: 1.1,
    frequency_penalty: 0.2,
    presence_penalty: 0.3,
    seed: 7,
    squash_system_messages: true,
    max_context_unlocked: true,
    reasoning_effort: 'high',
  } as unknown as ChatCompletionPreset

  const patch = presetScalarPatch(preset)
  const live = livePresetFields(patch as unknown as GenerationSettings)

  /*
   * Two fields of `GenerationSettings` are deliberately **not** read back, and
   * naming them here is what stops the list quietly widening:
   *
   * - `continuePostfix`, because it is stored as a word here and upstream's
   *   `Preset.settings` has no field for a continue separator at all;
   * - `frequencyPenalty`/`presencePenalty` and friends are read back — those are
   *   the ones a preset carries.
   *
   * So every key of the patch except `continuePostfix` must appear on the
   * live-field side under its file spelling.
   */
  const unread = new Set(['continuePostfix'])
  const spelling: Record<string, string> = {
    temperature: 'temp_openai',
    maxTokens: 'openai_max_tokens',
    contextWindow: 'openai_max_context',
    topP: 'top_p_openai',
    topK: 'top_k_openai',
    minP: 'min_p_openai',
    repetitionPenalty: 'repetition_penalty_openai',
    frequencyPenalty: 'freq_pen_openai',
    presencePenalty: 'pres_pen_openai',
    seed: 'seed',
    squashSystemMessages: 'squash_system_messages',
    contextUnlocked: 'max_context_unlocked',
    reasoningEffort: 'reasoning_effort',
  }
  const missing = Object.keys(patch)
    .filter(key => !unread.has(key))
    .filter(key => {
      const target = spelling[key]
      return target === undefined || !Object.hasOwn(live, target)
    })
  assert.deepEqual(
    missing,
    [],
    'a field a preset switch applies is not read back, so getPreset("in_use") would answer the body’s value',
  )
  // And the values actually round-trip, not merely the keys.
  assert.equal(live['temp_openai'], 0.5)
  assert.equal(live['openai_max_context'], 2222)
  assert.equal(live['reasoning_effort'], 'high')
})

test('livePresetFields carries only what is set, so the body’s own value stands', () => {
  /*
   * Not `undefined` for an unset field: `toTavernHelperPreset` spreads this
   * patch over the file, and an explicit `undefined` would shadow the file's
   * value and fall through to `default_preset` — reporting temperature 1 for a
   * preset that says 0.3.
   */
  const live = livePresetFields({ provider: 'p', model: 'm' })
  assert.deepEqual(live, {})
})
