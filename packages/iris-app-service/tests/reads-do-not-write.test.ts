import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { StCompatBridge } from '@iris/compat-st-extension'
import type { IrisEvent, RpcMethod } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { BackupStore } from '../src/backups.ts'
import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { PresetStore } from '../src/presets.ts'
import { PersonaStore } from '../src/persona.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { ScriptVariableStore } from '../src/script-variables.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * A method that reads must not write.
 *
 * This exists because the rule was learned the expensive way, twice. Binding the
 * macro tier to the chat's persistent scopes turned `prompt.itemize` — a
 * preview — into a write that stored a preset's menu selections into
 * `chat_metadata.variables`; and assembling a prompt for a card-initiated
 * generation would have advanced the world-info timed effects and overwritten a
 * real turn's itemization. Both were caught by looking, and looking does not
 * scale.
 *
 * So the check is empirical rather than a code review: call every read-shaped
 * method against a conversation with real state in it, and compare everything
 * observable before and after — the chat file, the view, all four variable
 * scopes, the timed effects, the itemizations, and the bytes on disk.
 *
 * The failures it is built to catch are the quiet kind. A preview that writes
 * does not error; it leaves a chat that behaves differently later, and the
 * change surfaces turns afterwards with nothing pointing back to the read that
 * caused it.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: {
      tavern_helper: {
        scripts: [{ id: 'panel', name: 'Panel', type: 'script', enabled: true, content: 'noop()' }],
      },
    },
    character_book: {
      entries: [
        {
          keys: [], content: 'count: 0', comment: '[InitVar]', name: '[InitVar]',
          enabled: false, constant: false, insertion_order: 0, extensions: {},
        },
        {
          keys: [], content: 'The maps are in the west tower.',
          enabled: true, constant: true, insertion_order: 1,
          extensions: { position: 4, depth: 0, role: 0, sticky: 3 },
        },
      ],
    },
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  chatId: string
  /** One snapshot that exists, so the `backup.*` reads perform actual reads. */
  backupId: string
  dir: string
  /** The script-variable store, whose writes are queued rather than awaited. */
  scriptVariables: ScriptVariableStore
}

/** One stored, active persona, so the persona reads land on real state. */
async function seedPersona(path: string): Promise<PersonaStore> {
  const store = new PersonaStore(path)
  await store.upsert({ name: 'Wanderer', description: 'A hooded traveller.', active: true })
  return store
}

/**
 * The same card with a prompt template in its description, so an armed ST
 * extension plane has something to expand: the bridge only runs a `generate`
 * round over contributions that carry `<%`.
 */
const TEMPLATED_CARD = CARD.replace('A retired cartographer.', 'A retired cartographer. <%= 1 %>')

/**
 * An armed ST extension plane whose every `generate` round answers with
 * **changed** variables — a chat scope and a global scope that differ each
 * round, the shape ST-Prompt-Template's `setvar` leaves — and whose settings
 * blob lives in a file under the profile, so a persisted global write is a
 * byte on disk the snapshot sees.
 */
function armedPlane(dir: string, answer: () => Handlers): NonNullable<ConstructorParameters<typeof IrisAppService>[0]['stCompat']> & { onRequest: (event: IrisEvent) => void } {
  const blob = join(dir, 'st-ext-settings.json')
  let round = 0
  return {
    bridge: new StCompatBridge(),
    extensionId: () => 'st-ext',
    revisionOf: () => 7,
    settingsFor: async () => {
      try {
        return JSON.parse(await readFile(blob, 'utf8')) as unknown
      } catch {
        return {}
      }
    },
    persistSettings: async (_id, value) => { await writeFile(blob, JSON.stringify(value), 'utf8') },
    installFromDirectory: async () => { throw new Error('not under test') },
    onRequest: (event) => {
      if (event.type !== 'st-compat.request') return
      round += 1
      if (event.kind === 'generate') {
        const payload = event.payload as { messages: Array<{ role: string, content: string }> }
        void answer()['stCompat.submit']({
          token: event.token, kind: 'generate', pluginRevision: event.revision,
          result: {
            kind: 'generate', messages: payload.messages,
            chatVariables: { bridged: round }, globalVariables: { bridgedGlobal: round },
          },
        })
      } else if (event.kind === 'reply') {
        // The reply round changes nothing: it hands back the variables it was
        // shown, so the generate round's writes are what the fixture holds.
        const payload = event.payload as { turn: number, text: string, chatVariables: Record<string, unknown> }
        void answer()['stCompat.submit']({
          token: event.token, kind: 'reply', pluginRevision: event.revision,
          result: {
            kind: 'reply', turn: payload.turn, mes: payload.text,
            chatVariables: payload.chatVariables, globalVariables: { bridgedGlobal: round - 1 }, floorVariables: {},
          },
        })
      }
    },
  }
}

async function fixture(t: TestContext, options: { armed?: boolean } = {}): Promise<Fixture> {
  const dir = await tempDir(t, 'iris-reads-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), options.armed === true ? TEMPLATED_CARD : CARD, 'utf8')
  // A real book, so `worldbook.get` below performs an actual read. Pointed at a
  // host with no store it would refuse before touching anything, and pass this
  // check without ever exercising the code it is supposed to be checking.
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(join(dir, 'worlds', 'Eldoria.json'), JSON.stringify({
    entries: { 1: { uid: 1, key: ['tower'], comment: 'Tower', content: 'Maps.', displayIndex: 0 } },
  }), 'utf8')
  // A real preset in the library, so the `preset.*` reads below perform actual
  // reads rather than refusing their way past the check.
  await mkdir(join(dir, 'presets'), { recursive: true })
  await writeFile(join(dir, 'presets', 'Sample.json'), JSON.stringify({
    prompts: [{ identifier: 'main', name: 'Main', marker: true }],
  }), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const scriptVariables = new ScriptVariableStore(join(dir, 'script-variables.json'))
  const chats = new ChatStore(join(dir, 'chats'), library, scriptVariables)
  const backups = new BackupStore(join(dir, 'chats'))
  let ends = 0
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = "Noted. _.set('count', 1);"
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let handlers: Handlers | undefined
  const plane = options.armed === true ? armedPlane(dir, () => handlers as Handlers) : undefined
  handlers = new IrisAppService({
    stream, library, chats, scriptVariables,
    ...plane === undefined ? {} : { stCompat: plane },
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    scripts: new ScriptPolicyStore(join(dir, 'script-policy.json')),
    extensionSettings: new ExtensionSettingsStore(join(dir, 'extension-settings.json')),
    worldbooks: new WorldbookStore(join(dir, 'worlds')),
    presets: new PresetStore(join(dir, 'presets')),
    // A persona on disk, so the `persona.*` reads below perform actual reads —
    // `persona.get` with no id resolves the active persona — rather than
    // refusing their way past the check.
    personas: await seedPersona(join(dir, 'personas.json')),
    backups,
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end') ends += 1
      plane?.onRequest(event)
    },
    userName: 'Traveller',
  }).handlers()
  if (plane !== undefined) await handlers['stCompat.plane.attach']({ extensionId: 'st-ext', pluginRevision: 7 })

  // A conversation with state worth not disturbing: a folded variable table, a
  // sticky world-info window, an itemization, and something on disk.
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  await handlers['chat.send']({ chatId, text: 'Where are the maps?' })
  while (ends < 1) await new Promise(resolve => setTimeout(resolve, 1))

  // One snapshot on disk, so the `backup.*` reads below read rather than
  // refuse their way past the check — the same rule the book and the persona
  // above follow.
  const seeded = await backups.snapshot(chatId, 'cleanup')

  return { handlers, chats, chatId, backupId: seeded.backupId, dir, scriptVariables }
}

/** Everything observable about a conversation and its store. */
async function snapshot(fixed: Fixture): Promise<string> {
  // Settled first. `ScriptVariableStore` queues its writes instead of awaiting
  // them, so a flush from earlier setup can land between the two snapshots and
  // look exactly like a read that wrote. That is not hypothetical — it made this
  // very test fail on one run in three, and an intermittent assertion is worse
  // than a failing one because it teaches the reader to re-run instead of look.
  await fixed.scriptVariables.settled()
  const entry = await fixed.chats.open(fixed.chatId)
  const files: Record<string, string> = {}
  const walk = async (at: string, prefix: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(at, { withFileTypes: true }).then(items => items.map(item => item.name))
    } catch {
      return
    }
    for (const name of names) {
      const path = join(at, name)
      try {
        files[`${prefix}${name}`] = await readFile(path, 'utf8')
      } catch {
        await walk(path, `${prefix}${name}/`)
      }
    }
  }
  await walk(fixed.dir, '')

  return JSON.stringify({
    file: entry.toFile(),
    view: entry.toView(),
    timedEffects: entry.timedEffects ?? null,
    itemizations: [...entry.itemizations.entries()],
    events: entry.session.events.length,
    variables: {
      message: entry.currentVariables() ?? null,
      chat: entry.variables.getVariables({ type: 'chat' }),
      global: entry.variables.getVariables({ type: 'global' }),
      script: entry.variables.getVariables({ type: 'script', script_id: 'panel' }),
    },
    files,
  })
}

/**
 * The methods whose names promise a read.
 *
 * Listed rather than derived from the contract, because "is this a read" is a
 * judgement about intent that no schema records — and writing it down is what
 * makes a future method's classification a decision instead of an omission.
 */
const READS: { method: RpcMethod, params: (fixed: Fixture) => unknown }[] = [
  { method: 'chat.list', params: () => ({}) },
  { method: 'chat.open', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'prompt.itemize', params: fixed => ({ chatId: fixed.chatId }) },
  // Reads two files and, unlike `prompt.itemize`, does not even open the chat —
  // so it is the one method here whose only way to write would be a defect
  // rather than a side effect of assembling a preview.
  { method: 'prompt.divergence', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'script.context', params: fixed => ({ chatId: fixed.chatId, characterId: 'aria' }) },
  { method: 'script.context', params: fixed => ({ chatId: fixed.chatId, characterId: 'aria', messageId: 2 }) },
  { method: 'script.list', params: () => ({ characterId: 'aria' }) },
  { method: 'script.body', params: () => ({ characterId: 'aria', scriptId: 'panel' }) },
  { method: 'script.getVariables', params: fixed => ({ chatId: fixed.chatId, scope: 'chat' }) },
  { method: 'script.getVariables', params: fixed => ({ chatId: fixed.chatId, scope: 'message' }) },
  { method: 'script.getVariables', params: fixed => ({ chatId: fixed.chatId, scope: 'global' }) },
  { method: 'settings.get', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'connection.list', params: () => ({}) },
  /*
   * What a conversation grew. This fixture configures no sandbox-plugin store,
   * so the call refuses — the same arm `plugin.list` below exercises, and the
   * property most worth seeing for it is that a refusal writes as little as an
   * answer would: a store whose reader created its own directory would leave
   * `<profile>/sandbox-plugins/` behind for every conversation ever opened.
   */
  { method: 'sandboxPlugin.list', params: fixed => ({ chatId: fixed.chatId }) },
  { method: 'character.list', params: () => ({}) },
  { method: 'persona.list', params: () => ({}) },
  { method: 'persona.get', params: () => ({}) },
  { method: 'worldbook.names', params: () => ({}) },
  { method: 'worldbook.get', params: () => ({ name: 'Eldoria' }) },
  { method: 'worldbook.charNames', params: () => ({ characterId: 'aria' }) },
  { method: 'worldbook.charDigest', params: () => ({ characterId: 'aria' }) },
  { method: 'preset.list', params: () => ({}) },
  { method: 'preset.view', params: () => ({}) },
  { method: 'preset.read', params: () => ({ name: 'Sample' }) },
  // The plugin catalog listing. This fixture configures no runtime, so the
  // call refuses (`requirePlugins` throws before any store is touched) — the
  // same arm `connection.list` exercises above, and the one this check most
  // wants seen for it: a refusal must write as little as an answer would.
  { method: 'plugin.list', params: () => ({}) },
  // A read of the effective settings: it must answer what a scan would run
  // with, and write nothing — an earlier sibling of this seam (the sampler's
  // `settings.get`) is exactly where a silent write once hid.
  { method: 'worldbook.settings', params: () => ({}) },
  { method: 'regex.list', params: () => ({}) },
  // The library listing. It reads two stores that a save writes, so the
  // interesting property is that *asking* what is in the library does not
  // create the file — a store whose loader wrote a default on first read would
  // pass a round-trip test and fail this one.
  { method: 'scriptLibrary.list', params: () => ({}) },
  // A listing and a preview of the snapshot seeded above: reads off the
  // snapshot's own bytes, which must not so much as re-date it.
  { method: 'backup.list', params: () => ({}) },
  { method: 'backup.preview', params: fixed => ({ backupId: fixed.backupId }) },
]

for (const { method, params } of READS) {
  test(`${method} leaves the conversation exactly as it found it`, async (t) => {
    const fixed = await fixture(t)
    const before = await snapshot(fixed)

    const call = fixed.handlers[method] as (input: unknown) => Promise<unknown>
    // A refusal is a legitimate outcome — `connection.list` refuses on a host
    // with no connection store — and it is still a read that must not have
    // written. Swallowing the error rather than configuring every store keeps
    // the subject the mutation, and it covers the worse case besides: a method
    // that writes and *then* fails still has to pass the comparison below.
    await call(params(fixed)).catch(() => undefined)

    const after = await snapshot(fixed)
    // Compared whole rather than field by field: the two escapes found so far
    // were both fields nobody thought to check — a preview writing chat
    // variables, and an assembly advancing world-info timing. A per-field
    // assertion only catches the fields its author already suspected.
    assert.equal(after, before, `${method} changed something about the conversation or the store`)
  })
}

/*
 * **The same check with the ST extension plane armed.** The list above composes
 * the service without `stCompat`, so its `prompt.itemize` never reaches the
 * bridge — and with the plane armed, the preview used to run a real
 * `generate` round and commit its variable effects: chat variables into the
 * entry (saved by the next save) and global variables straight to disk. The
 * premise is asserted first, so a bridge that never ran cannot pass as a
 * bridge whose effects were discarded.
 */
test('prompt.itemize with the ST extension plane armed leaves the conversation as it found it', async (t) => {
  const fixed = await fixture(t, { armed: true })
  const entry = await fixed.chats.open(fixed.chatId)
  assert.ok(typeof entry.variables.getVariables({ type: 'chat' })['bridged'] === 'number',
    'premise: the real turn in the fixture ran a bridge round and committed its effects')
  const before = await snapshot(fixed)

  const { itemization } = await fixed.handlers['prompt.itemize']({ chatId: fixed.chatId })
  assert.equal(itemization.preview, true)

  assert.equal(await snapshot(fixed), before, 'the preview committed the bridge round’s variable effects')
})

test('the host’s own compaction does not commit the ST bridge’s variable effects', async (t) => {
  const fixed = await fixture(t, { armed: true })
  const entry = await fixed.chats.open(fixed.chatId)
  const chat = JSON.stringify(entry.variables.getVariables({ type: 'chat' }))
  let blob: string | undefined
  try {
    blob = await readFile(join(fixed.dir, 'st-ext-settings.json'), 'utf8')
  } catch {
    blob = undefined
  }
  // One exchange is enough history to compact: the greeting and the turn.
  await fixed.handlers['chat.compact']({ chatId: fixed.chatId }).catch(() => undefined)

  assert.equal(JSON.stringify(entry.variables.getVariables({ type: 'chat' })), chat,
    'the compaction assembly wrote the bridge’s chat variables')
  let after: string | undefined
  try {
    after = await readFile(join(fixed.dir, 'st-ext-settings.json'), 'utf8')
  } catch {
    after = undefined
  }
  assert.equal(after, blob, 'the compaction assembly persisted the bridge’s global variables')
})

test('the read list is not silently incomplete', async (t) => {
  // A read added to the contract and not to the list above would be unchecked,
  // and unchecked is indistinguishable from checked in a green suite. This
  // cannot prove the list complete — that is a judgement — but it fails when a
  // method named like a read is missing from it, which is the case that actually
  // happens.
  const { handlers } = await fixture(t)
  // `names` and `charNames` were added to this pattern after it caught
  // `worldbook.get` and let its two siblings through in the same commit. A
  // completeness guard that is itself incomplete fails in the direction that
  // looks like success, so the pattern is widened whenever a read is added with
  // a verb it does not know.
  const readShaped = Object.keys(handlers).filter(name =>
    /^(?:.*\.(?:list|open|get|getVariables|names|charNames|body|context|itemize))$/u.test(name))
  const covered = new Set(READS.map(entry => entry.method as string))

  const missing = readShaped.filter(name => !covered.has(name))
  assert.deepEqual(
    missing,
    [],
    `these read-shaped methods are not checked for writes: ${missing.join(', ')}`,
  )
})
