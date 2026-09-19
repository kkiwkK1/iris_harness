import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { StreamFn } from '@iris/turn'
import { SANDBOX_PLUGIN_LIMITS, SANDBOX_PLUGIN_QUOTAS, SANDBOX_PLUGIN_SIDECAR_VERSION } from '@iris/protocol'

import { ChatStore } from '../src/chats.ts'
import { ConnectionStore } from '../src/connections.ts'
import { CharacterLibrary } from '../src/library.ts'
import { ScriptVariableStore } from '../src/script-variables.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { hashOfPluginCode, SandboxPluginStore } from '../src/sandbox-plugins/store.ts'
import {
  parseSandboxPluginFences,
  parseSandboxPluginToolCall,
  validateSandboxPluginFields,
} from '../src/sandbox-plugins/parse.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * A conversation growing a feature of its own, end to end on the host side.
 *
 * The properties here are the ones `docs/SANDBOX-PLUGINS.md` §16.3 names for
 * PR-B, and three of them exist because the failure they describe is invisible
 * from outside:
 *
 * - **a deleted conversation's sidecar goes with it.** Chat ids are recycled, so
 *   a file left behind arms the next conversation of the same name with code it
 *   never confirmed — already authorised, and mounted at open.
 * - **the two parse routes agree.** A tool call and a pair of fenced blocks
 *   carrying the same content have to produce the same record, or the rules a
 *   reader was told about apply to one road and not the other.
 * - **an unset authoring connection refuses rather than falls back.** Falling
 *   back spends a player's money on a model they never chose, and the failure it
 *   produces looks like a broken feature rather than an unfinished setting.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: 'A retired cartographer.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: {},
  },
})

/** A body that compiles, so the precheck is not what a test is measuring. */
const GOOD_CODE = "return { apply() { iris.styles.insert('body{color:red}') } }"

/** What a model answers on the fenced-block route. */
function fencedReply(code = GOOD_CODE): string {
  return [
    'Here you go — note that this only changes the colour.',
    '```json',
    JSON.stringify({ idPrefix: 'dark-status', name: '深色状态栏', purpose: '把状态栏改成深色。', declares: [{ kind: 'style' }] }),
    '```',
    '```js',
    code,
    '```',
    'Let me know if you want it brighter.',
  ].join('\n')
}

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  chatId: string
  dir: string
  plugins: SandboxPluginStore
  connections: ConnectionStore
  /** Every request the host actually sent, so "it did not ask" is checkable. */
  sent: GenerateOptions[]
}

/**
 * Build a host with a sandbox-plugin store and one saved provider.
 * @param t - the test context, for cleanup.
 * @param options.reply - what the fake model answers.
 * @param options.authoring - whether an authoring connection is configured.
 * @returns the fixture.
 */
async function fixture(
  t: TestContext,
  options: { reply?: string, authoring?: boolean } = {},
): Promise<Fixture> {
  // The directory carries its own removal: `tempDir` registers it on the
  // context at the moment it hands the path over, so the line that used to go
  // missing cannot.
  const dir = await tempDir(t, 'iris-sandbox-plugins-')
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const scriptVariables = new ScriptVariableStore(join(dir, 'script-variables.json'))
  const chats = new ChatStore(join(dir, 'chats'), library, scriptVariables)
  const plugins = new SandboxPluginStore(join(dir, 'sandbox-plugins'))
  const connections = new ConnectionStore(join(dir, 'connections.json'))
  // No `baseURL`, so the profile rides the composition's own adapter and the
  // route is its provider name — which is what keeps this fixture free of an
  // installer while still exercising the real routing decision.
  const saved = await connections.save({ provider: 'test', model: 'writer-1' })
  const profileId = saved.profiles[0]?.id ?? ''
  /*
   * **In use, always** — even in the fixture whose authoring setting is absent.
   *
   * That is not decoration: the refusal this file checks is "no authoring
   * connection", and the thing it must not do instead is fall back to the
   * provider in use. A fixture with nothing in use cannot tell the two apart —
   * measured, on a first version of this file, where a build that fell back to
   * `activeId` passed every assertion here because `activeId` was undefined too.
   */
  await connections.markActive(profileId)
  if (options.authoring !== false) await connections.setAuthoring({ id: profileId, model: 'writer-1' })

  const sent: GenerateOptions[] = []
  const reply = options.reply ?? fencedReply()
  const stream: StreamFn = async function* (request: GenerateOptions): AsyncIterable<StreamChunk> {
    sent.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const handlers = new IrisAppService({
    stream, library, chats, scriptVariables, connections,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    sandboxPlugins: plugins,
    broadcast: () => undefined,
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chats, chatId: created.view.chatId, dir, plugins, connections, sent }
}

/**
 * The names of the files in the profile's sandbox-plugin directory.
 * @param dir - the profile directory.
 * @returns the file names, or an empty list when the directory is not there.
 */
async function sidecarFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'sandbox-plugins'))).sort()
  } catch {
    return []
  }
}

test('the two parse routes produce the same record from the same content', () => {
  const meta = { idPrefix: 'dark-status', name: '深色状态栏', purpose: '把状态栏改成深色。', declares: [{ kind: 'style' }] }
  const viaTool = parseSandboxPluginToolCall(JSON.stringify({ ...meta, code: GOOD_CODE }))
  const viaFence = parseSandboxPluginFences(fencedReply())

  assert.equal(viaTool.ok, true, `the tool route refused: ${viaTool.ok ? '' : viaTool.detail}`)
  assert.equal(viaFence.ok, true, `the fenced route refused: ${viaFence.ok ? '' : viaFence.detail}`)
  assert.ok(viaTool.ok && viaFence.ok)
  /*
   * Deep-equal on the whole candidate, not on `code` alone. The thing that goes
   * wrong is a rule applied on one road and not the other — a length cut, a
   * trim, a declaration dropped — and every one of those lives in a field this
   * comparison covers and a `code` comparison would not.
   */
  assert.deepEqual(viaTool.candidate, viaFence.candidate)
})

test('the fenced route reads its two markers exactly', () => {
  // The tooth for the row above: a reader that also accepted `javascript` would
  // be encoding a guess about what a model might write into the one place that
  // says what it must write. Renaming the accepted marker in `parse.ts` turns
  // the equivalence test red, and this states why in its own right.
  const javascript = fencedReply().replace('```js\n', '```javascript\n')
  const answer = parseSandboxPluginFences(javascript)
  assert.equal(answer.ok, false)
  assert.ok(!answer.ok && answer.detail.includes('js'), answer.ok ? '' : answer.detail)

  // And the other half: metadata with no code is not a record either, and the
  // two absences get two different sentences.
  const noMeta = parseSandboxPluginFences(['```js', GOOD_CODE, '```'].join('\n'))
  assert.equal(noMeta.ok, false)
  assert.ok(!noMeta.ok && noMeta.detail.includes('json'), noMeta.ok ? '' : noMeta.detail)
})

test('the seven ceilings each refuse or cut, and each is the number it claims', () => {
  /*
   * Seven ceilings, one assertion each — and `codeBytes` is written out as a
   * **literal** while the rest are read from the constants.
   *
   * That asymmetry is the whole of this test's discriminating power and it was
   * measured: a first version read every number from `SANDBOX_PLUGIN_LIMITS`,
   * and changing `64 * 1024` to `64 * 1000` stayed green, because both sides of
   * every comparison moved together. A ceiling asserted only against itself is a
   * ceiling nothing pins. The literal below is the one the design fixes (§3.2
   * Q2) and the mis-spelling it exists to catch is the ordinary one — KiB read
   * as KB.
   */
  assert.equal(
    SANDBOX_PLUGIN_LIMITS.codeBytes,
    65_536,
    'one plugin\'s ceiling is 64 KiB — 65536 bytes, not 64000',
  )
  const meta = { idPrefix: 'p', name: 'n', purpose: 'p', declares: [] }

  // 1. code, in UTF-8 bytes — refused, never truncated, because a cut body is a
  //    syntax error attributed to the model for a fault the ceiling introduced.
  const atCeiling = 'x'.repeat(SANDBOX_PLUGIN_LIMITS.codeBytes)
  assert.equal(validateSandboxPluginFields({ ...meta, code: atCeiling }, 'x').ok, true)
  const overCeiling = validateSandboxPluginFields({ ...meta, code: `${atCeiling}y` }, 'x')
  assert.equal(overCeiling.ok, false)
  assert.equal(overCeiling.ok ? '' : overCeiling.state, 'too-large')
  // Bytes rather than characters: three-byte characters must not buy three
  // times the ceiling.
  const wide = '中'.repeat(SANDBOX_PLUGIN_LIMITS.codeBytes)
  assert.equal(validateSandboxPluginFields({ ...meta, code: wide }, 'x').ok, false)

  // 2–4. name, purpose and prompt are **cut**, not refused: a shorter name is a
  //      name. (The prompt is cut by the definition path; the other two here.)
  const long = validateSandboxPluginFields({
    idPrefix: 'p',
    name: 'n'.repeat(SANDBOX_PLUGIN_QUOTAS.nameChars + 50),
    purpose: 'p'.repeat(SANDBOX_PLUGIN_QUOTAS.purposeChars + 50),
    declares: [],
    code: GOOD_CODE,
  }, 'x')
  assert.ok(long.ok)
  assert.equal(long.candidate.name.length, SANDBOX_PLUGIN_QUOTAS.nameChars)
  assert.equal(long.candidate.purpose.length, SANDBOX_PLUGIN_QUOTAS.purposeChars)
  assert.ok(SANDBOX_PLUGIN_QUOTAS.promptChars > 0)

  // 5–7. the conversation-wide ceilings and the file's own, as declared numbers
  //      the definition path and the store enforce. Asserted as relations rather
  //      than as literals, so the assertion states why each number is where it
  //      is instead of repeating it.
  assert.ok(SANDBOX_PLUGIN_QUOTAS.plugins > 0 && SANDBOX_PLUGIN_QUOTAS.plugins <= 64)
  assert.ok(SANDBOX_PLUGIN_QUOTAS.chatCodeBytes >= SANDBOX_PLUGIN_LIMITS.codeBytes)
  assert.ok(SANDBOX_PLUGIN_QUOTAS.sidecarBytes > SANDBOX_PLUGIN_QUOTAS.chatCodeBytes)
  assert.ok(SANDBOX_PLUGIN_QUOTAS.versionsKept > 1)
})

test('a sidecar round-trips, and a schema version it does not know is set aside whole', async (t) => {
  const dir = await tempDir(t, 'iris-sidecar-')
  const problems: string[] = []
  const store = new SandboxPluginStore(join(dir, 'sandbox-plugins'), {
    onProblem: message => { problems.push(message) },
  })

  const written = await store.mutate('aria-20260919-000001', 'aria', () => [{
    id: '01-dark',
    versions: [{
      version: 1, name: 'n', purpose: 'p', declares: [{ kind: 'style' }],
      code: GOOD_CODE, bytes: Buffer.byteLength(GOOD_CODE, 'utf8'), hash: 'abc123abc123',
      prompt: 'make it dark',
      authored: { connectionId: 'c', model: 'm', at: 1 },
    }],
    enabled: true,
    trustFutureVersions: false,
    authorizedHashes: ['abc123abc123'],
  }])
  assert.equal(written.length, 1)
  const read = await store.read('aria-20260919-000001')
  assert.deepEqual(read, written)

  /*
   * A version this build does not know quarantines the **whole file**, rather
   * than being migrated or partly salvaged: what is parsed out of this file gets
   * executed, so "I understood most of it" would be a guess about which code the
   * player authorised.
   *
   * The tooth: change the `!==` in `store.ts` to a `>=` and this goes red,
   * because a newer file would then be read as if it were this one's.
   */
  const path = join(dir, 'sandbox-plugins', 'aria-20260919-000001.json')
  const bumped = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  bumped['version'] = SANDBOX_PLUGIN_SIDECAR_VERSION + 1
  await writeFile(path, JSON.stringify(bumped), 'utf8')
  assert.deepEqual(await store.read('aria-20260919-000001'), [])
  assert.equal((await readdir(join(dir, 'sandbox-plugins'))).some(name => name.includes('.schema-')), true)
  assert.ok(problems.some(message => message.includes('schema version')), problems.join(' | '))
})

test('deleting a conversation takes its plugins with it', async (t) => {
  const fixed = await fixture(t)
  await fixed.plugins.mutate(fixed.chatId, 'aria', () => [{
    id: '01-dark',
    versions: [{
      version: 1, name: 'n', purpose: 'p', declares: [],
      code: GOOD_CODE, bytes: 1, hash: 'h', prompt: 's',
      authored: { connectionId: 'c', model: 'm', at: 1 },
    }],
    enabled: true, trustFutureVersions: true, authorizedHashes: ['h'],
  }])
  assert.deepEqual(await sidecarFiles(fixed.dir), [`${fixed.chatId}.json`])

  await fixed.handlers['chat.delete']({ chatId: fixed.chatId })

  /*
   * **The hard requirement of §10.3**, and the tooth is to comment out the
   * `sandboxPlugins?.forget(chatId)` line in `chat.delete`.
   *
   * Asserted on the directory rather than through `read`, because `read`
   * answering an empty list is exactly what a *leftover* file would also produce
   * once the next conversation of this name had been handed the id — the file
   * has to be gone, not merely unreadable.
   */
  assert.deepEqual(await sidecarFiles(fixed.dir), [])
})

test('a branch carries its parent\'s plugins, with their authorisations and a mark', async (t) => {
  const fixed = await fixture(t)
  await fixed.plugins.mutate(fixed.chatId, 'aria', () => [{
    id: '01-dark',
    versions: [{
      version: 2, name: 'n', purpose: 'p', declares: [],
      code: GOOD_CODE, bytes: 1, hash: 'hash-2', prompt: 's',
      authored: { connectionId: 'c', model: 'm', at: 1 },
    }],
    enabled: true, trustFutureVersions: true, authorizedHashes: ['hash-1', 'hash-2'],
  }])

  const branched = await fixed.handlers['chat.branch']({ chatId: fixed.chatId, id: 0 })
  const child = branched.view.chatId
  assert.notEqual(child, fixed.chatId)

  const copied = await fixed.plugins.read(child)
  assert.equal(copied.length, 1, 'the branch grew nothing of its own')
  /*
   * With the authorisations, and **not re-asked**: the player has already
   * nodded at this code, and a branch is "carry on down another road" rather
   * than "start again". Both halves are asserted, because carrying the row and
   * dropping its authorisations would look identical in the panel and would put
   * a confirmation card in front of the reader on a branch.
   */
  assert.deepEqual(copied[0]?.authorizedHashes, ['hash-1', 'hash-2'])
  assert.equal(copied[0]?.trustFutureVersions, true)
  // And the mark, so the panel can say why a conversation the player never grew
  // anything in has something in it — which stays true after the parent is
  // deleted, because these are copies rather than references.
  assert.equal(copied[0]?.branchedFrom, fixed.chatId)

  // The parent is unchanged: two roads from here.
  const parent = await fixed.plugins.read(fixed.chatId)
  assert.equal(parent[0]?.branchedFrom, undefined)
})

test('with no authoring connection, 「create」 refuses and asks nobody', async (t) => {
  const fixed = await fixture(t, { authoring: false })
  await assert.rejects(
    fixed.handlers['sandboxPlugin.define']({
      chatId: fixed.chatId, characterId: 'aria', sentence: 'make the status bar dark',
    }),
    (error: unknown) => (error as { code?: string }).code === 'no-provider',
  )
  /*
   * **And no request went out.** The refusal alone would pass against a build
   * that fell back to the active connection and then failed for some other
   * reason; what the ruling forbids is spending the player's money on a model
   * they did not choose, so the assertion is about the request, not the error.
   */
  assert.deepEqual(fixed.sent, [])
})

test('a sentence becomes a parked plugin that cannot mount until it is confirmed', async (t) => {
  const fixed = await fixture(t)
  const defined = await fixed.handlers['sandboxPlugin.define']({
    chatId: fixed.chatId, characterId: 'aria', sentence: 'make the status bar dark',
  })

  // The request went out on the authoring profile's model, not the
  // conversation's (`test-model` is what the settings say).
  assert.equal(fixed.sent.length, 1)
  assert.equal(fixed.sent[0]?.model, 'writer-1')
  // …and it declared the tool, so a provider that supports one can answer in a
  // field rather than in prose.
  assert.equal(fixed.sent[0]?.tools?.[0]?.name, 'iris_define_sandbox_plugin')

  assert.equal(defined.pending.versions.at(-1)?.name, '深色状态栏')
  assert.equal(defined.pending.authorized, false)
  /*
   * **Parked, not mounted.** The record is on disk — a definition that lived
   * only in memory would disappear on a refresh and read as a silent failure —
   * and `mounts` is what the shell puts into the frame, so the whole of "landing
   * is not executing" is this one assertion.
   */
  assert.deepEqual(defined.mounts, [])
  assert.deepEqual(await sidecarFiles(fixed.dir), [`${fixed.chatId}.json`])

  const hash = defined.pending.versions.at(-1)?.hash
  const decided = await fixed.handlers['sandboxPlugin.decide']({
    chatId: fixed.chatId, characterId: 'aria', pluginId: defined.pending.id, verdict: 'version', hash,
  })
  assert.equal(decided.mounts.length, 1)
  assert.equal(decided.mounts[0]?.code, GOOD_CODE)
  assert.equal(decided.plugins[0]?.authorized, true)

  // A tick that names a version other than the one the card showed is refused
  // rather than applied to the current one.
  await assert.rejects(
    fixed.handlers['sandboxPlugin.decide']({
      chatId: fixed.chatId, characterId: 'aria', pluginId: defined.pending.id, verdict: 'version', hash: 'stale',
    }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )

  // Off is not gone, and on again is not re-asked.
  const off = await fixed.handlers['sandboxPlugin.decide']({
    chatId: fixed.chatId, characterId: 'aria', pluginId: defined.pending.id, verdict: 'disable',
  })
  assert.deepEqual(off.mounts, [])
  assert.equal(off.plugins.length, 1)
  const on = await fixed.handlers['sandboxPlugin.decide']({
    chatId: fixed.chatId, characterId: 'aria', pluginId: defined.pending.id, verdict: 'enable',
  })
  assert.equal(on.mounts.length, 1)

  // And gone is gone, file and all.
  const removed = await fixed.handlers['sandboxPlugin.decide']({
    chatId: fixed.chatId, characterId: 'aria', pluginId: defined.pending.id, verdict: 'remove',
  })
  assert.deepEqual(removed.plugins, [])
  assert.deepEqual(await sidecarFiles(fixed.dir), [])
})

test('code the model cannot compile is refused by name, before anything is stored', async (t) => {
  const fixed = await fixture(t, { reply: fencedReply('return { apply() { ') })
  await assert.rejects(
    fixed.handlers['sandboxPlugin.define']({
      chatId: fixed.chatId, characterId: 'aria', sentence: 'break it',
    }),
    (error: unknown) => (error as Error).message.includes('does not compile'),
  )
  // Nothing was written: the precheck is before the sidecar, so a syntax error
  // never becomes a row the player has to delete.
  assert.deepEqual(await sidecarFiles(fixed.dir), [])
  // And the conversation is untouched — a card that failed to grow a feature is
  // still a card you can talk to.
  const view = await fixed.handlers['chat.open']({ chatId: fixed.chatId })
  assert.equal(view.view.chatId, fixed.chatId)
})

test('a reply that yields no record is `unparseable`, and says what arrived', async (t) => {
  const fixed = await fixture(t, { reply: 'I would rather not. Here is a poem instead.' })
  await assert.rejects(
    fixed.handlers['sandboxPlugin.define']({
      chatId: fixed.chatId, characterId: 'aria', sentence: 'anything',
    }),
    (error: unknown) => (error as Error).message.includes('block'),
  )
  assert.deepEqual(await sidecarFiles(fixed.dir), [])
})

test('a chat exports the same bytes whether or not it has grown anything', async (t) => {
  const fixed = await fixture(t)
  const before = await fixed.handlers['chat.export']({ chatId: fixed.chatId })
  assert.deepEqual(await sidecarFiles(fixed.dir), [], 'the fixture should start with no sidecar')

  await fixed.handlers['sandboxPlugin.define']({
    chatId: fixed.chatId, characterId: 'aria', sentence: 'make the status bar dark',
  })
  assert.deepEqual(await sidecarFiles(fixed.dir), [`${fixed.chatId}.json`], 'nothing was stored to compare against')

  /*
   * **Byte for byte**, against the export taken when the sidecar directory did
   * not exist — which is the compatibility floor this whole feature is held to
   * (`docs/SANDBOX-PLUGINS.md` §1): a chat taken out of Iris is a chat
   * SillyTavern can read, and a sandbox plugin is not part of it.
   *
   * The tooth is to have the export carry the sidecar: any byte of it in
   * `content` fails this.
   */
  const after = await fixed.handlers['chat.export']({ chatId: fixed.chatId })
  assert.equal(after.content, before.content)
  assert.equal(after.filename, before.filename)
})

/**
 * `sandboxPlugin.source` — the one read that carries a model's code.
 *
 * Four properties, and three of them are about what it **refuses**, because the
 * failure this door can have is not "it did not answer" but "it answered with
 * the wrong bytes". A reader opens this view to hold the source against the hash
 * the confirmation card showed them; a call that quietly substituted the current
 * version for a missing one, or answered for a plugin belonging to another
 * conversation, would render a screen that is wrong in a way nothing on it says.
 */
test('one version\'s source is readable by name, and nothing else is', async (t) => {
  const fixed = await fixture(t)
  const defined = await fixed.handlers['sandboxPlugin.define']({
    chatId: fixed.chatId, characterId: 'aria', sentence: 'make the status bar dark',
  })
  const pluginId = defined.pending.id
  const first = defined.pending.versions.at(-1)
  assert.ok(first !== undefined)

  /*
   * A second version, appended through the store rather than through a second
   * model reply: the fixture answers one scripted reply, so two `define` calls
   * would produce two byte-identical versions and the assertion below — that
   * v1 and v2 answer *different* bytes — would pass on a handler that ignored
   * `version` entirely.
   */
  const SECOND_CODE = "return { apply() { iris.styles.insert('body{color:blue}') } }"
  await fixed.plugins.mutate(fixed.chatId, 'aria', records => records.map(record => record.id === pluginId
    ? {
        ...record,
        versions: [...record.versions, {
          ...first,
          version: first.version + 1,
          code: SECOND_CODE,
          bytes: Buffer.byteLength(SECOND_CODE, 'utf8'),
          hash: hashOfPluginCode(SECOND_CODE),
        }],
      }
    : record))

  // No version asked for: the current one, named in the answer rather than left
  // for the caller to assume.
  const current = await fixed.handlers['sandboxPlugin.source']({ chatId: fixed.chatId, pluginId })
  assert.equal(current.code, SECOND_CODE)
  assert.equal(current.version, first.version + 1)
  assert.equal(current.hash, hashOfPluginCode(SECOND_CODE))

  // A kept earlier one, by number — the bytes the model actually wrote, and the
  // hash the confirmation card recorded the authorisation under.
  const earlier = await fixed.handlers['sandboxPlugin.source']({
    chatId: fixed.chatId, pluginId, version: first.version,
  })
  assert.equal(earlier.code, GOOD_CODE)
  assert.equal(earlier.version, first.version)
  assert.equal(earlier.hash, first.hash)
  assert.notEqual(earlier.hash, current.hash, 'the two versions must differ, or this test compares one version twice')

  // A version that is not kept is refused **by name**, and the sentence says
  // which ones are — the usual cause is that the oldest was dropped, not that
  // the number never existed.
  await assert.rejects(
    fixed.handlers['sandboxPlugin.source']({ chatId: fixed.chatId, pluginId, version: 7 }),
    (error: unknown) => {
      const message = (error as Error).message
      return (error as { code?: string }).code === 'not-found'
        && message.includes('version 7')
        && message.includes('v1')
    },
  )

  // A plugin this conversation does not have.
  await assert.rejects(
    fixed.handlers['sandboxPlugin.source']({ chatId: fixed.chatId, pluginId: 'no-such-plugin' }),
    (error: unknown) => (error as { code?: string }).code === 'not-found'
      && (error as Error).message.includes('no-such-plugin'),
  )

  /*
   * **The id scoping, which is the one refusal a reader cannot see for
   * themselves.** The other conversation exists, the plugin id is real, and the
   * only thing wrong is whose it is. A handler that looked the plugin up in a
   * table keyed by id alone would answer this one happily.
   */
  const other = await fixed.handlers['chat.create']({ characterId: 'aria' })
  assert.notEqual(other.view.chatId, fixed.chatId)
  await assert.rejects(
    fixed.handlers['sandboxPlugin.source']({ chatId: other.view.chatId, pluginId }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})
