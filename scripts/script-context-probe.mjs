/**
 * What one `script.context` costs, measured on a real profile.
 *
 * A page cold-load was measured making 22 identical `script.context` calls (one
 * per displayed message row), each ~1 s of host time, which serialised into a
 * 47 s queue. Before deduplicating the caller, this answers the three questions
 * the fix depends on: how long the host takes, how many bytes it answers with,
 * which fields those bytes are in, and whether the answer depends on the
 * `messageId` argument at all — because if it does, the frames are not asking
 * the same question and sharing one answer would be wrong.
 *
 *   node scripts/script-context-probe.mjs
 *   IRIS_PROBE_DATA=… IRIS_PROBE_CHATS='爱衣' node scripts/script-context-probe.mjs
 *
 * A script rather than a test, because it reads the operator's own profile.
 * Nothing is written there: the profile is **copied** into a scratch directory
 * first and the host runs against the copy, exactly as
 * `scripts/cache-prefix-probe.mjs` does.
 *
 * **Shapes and byte counts only.** The conversations in a real profile are the
 * operator's; this prints field names, counts and sizes, and never a substring
 * of any value.
 */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { BackupStore, DEFAULT_BACKUP_KEEP } from '../packages/iris-app-service/src/backups.ts'
import { ChatStore } from '../packages/iris-app-service/src/chats.ts'
import { ConnectionStore } from '../packages/iris-app-service/src/connections.ts'
import { DiagnosticBuffer } from '../packages/iris-app-service/src/diagnostics.ts'
import { ExtensionSettingsStore, openGlobalScope } from '../packages/iris-app-service/src/context.ts'
import { FavoriteStore } from '../packages/iris-app-service/src/favorites.ts'
import { CharacterLibrary } from '../packages/iris-app-service/src/library.ts'
import { materialiseEmbeddedBook, WorldbookBindingStore } from '../packages/iris-app-service/src/materialise.ts'
import { DEFAULT_PROFILE, profilePaths } from '../packages/iris-app-service/src/paths.ts'
import { PersonaStore } from '../packages/iris-app-service/src/persona.ts'
import { PresetStore } from '../packages/iris-app-service/src/presets.ts'
import { DEFAULT_PRESET } from '../packages/iris-app-service/src/prompt.ts'
import { ScriptButtonStore } from '../packages/iris-app-service/src/script-buttons.ts'
import { ScriptPolicyStore } from '../packages/iris-app-service/src/scripts.ts'
import { ScriptVariableStore } from '../packages/iris-app-service/src/script-variables.ts'
import { SettingsStore } from '../packages/iris-app-service/src/settings.ts'
import { StInstall } from '../packages/iris-app-service/src/st-install.ts'
import { IrisAppService } from '../packages/iris-app-service/src/service.ts'
import { WorldbookStore } from '../packages/iris-app-service/src/worldbooks.ts'

const DATA = process.env.IRIS_PROBE_DATA
  ?? 'D:/workspace/小项目/iris_cordis_traven/apps/iris/data'
const PROFILE = process.env.IRIS_PROFILE ?? DEFAULT_PROFILE
const WANTED = (process.env.IRIS_PROBE_CHATS ?? '').split(',').map(part => part.trim()).filter(Boolean)
const SCRATCH = process.env.IRIS_PROBE_SCRATCH ?? join(tmpdir(), 'iris-script-context')
/** How many repeats of the same call, so a first-call cost and a warm one are told apart. */
const REPEATS = Number(process.env.IRIS_PROBE_REPEATS ?? 3)

/** Bytes of a string as UTF-8, which is what the wire counts. */
const bytes = text => Buffer.byteLength(text, 'utf8')

/** A size in KiB, one decimal. */
const kib = count => `${(count / 1024).toFixed(1)} KiB`

/** A content hash, so two answers can be compared without printing either. */
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

async function buildHost(dataDir) {
  const warn = message => {
    const text = message instanceof Error ? message.message : String(message)
    if (process.env.IRIS_PROBE_VERBOSE === '1') console.error(`  · ${text}`)
  }
  const paths = profilePaths(dataDir, PROFILE)

  const library = new CharacterLibrary(paths.characters, '/iris/avatar')
  const scriptVariables = new ScriptVariableStore(paths.scriptVariables, warn)
  const extensionSettings = new ExtensionSettingsStore(paths.extensionSettings)
  const globalScope = await openGlobalScope(extensionSettings, warn)
  const worldbooks = new WorldbookStore(paths.worlds)
  const settings = new SettingsStore(paths.settings, { provider: 'default', model: 'local-model' })
  const worldbookBindings = new WorldbookBindingStore(paths.worldbookBindings, warn)
  const stInstall = new StInstall(undefined)
  const personas = new PersonaStore(paths.personas)
  const backups = new BackupStore(paths.chats, { keep: DEFAULT_BACKUP_KEEP, onError: warn })

  const bookFor = async (characterId, card) => {
    if (characterId === undefined) return undefined
    const done = await materialiseEmbeddedBook(
      characterId, card, worldbooks, worldbookBindings, stInstall)
    for (const line of done?.reports ?? []) warn(line)
    return done?.name
  }

  const chats = new ChatStore(
    paths.chats, library, scriptVariables, globalScope, worldbooks,
    () => settings.globalSelect(),
    bookFor,
    () => personas.activeSync() ?? '',
    () => extensionSettings.globalRegex(),
    characterId => settings.charBooks(characterId),
    backups,
  )

  await settings.load()
  await personas.prime()

  const service = new IrisAppService({
    stream: async function* () { throw new Error('the probe sends nothing') },
    library,
    chats,
    settings,
    scripts: new ScriptPolicyStore(paths.scriptPolicy),
    extensionSettings,
    scriptButtons: new ScriptButtonStore(paths.scriptButtons, warn),
    worldbooks,
    connections: new ConnectionStore(paths.connections),
    personas,
    favorites: new FavoriteStore(paths.favorites),
    worldbookBindings,
    installConnection: () => {},
    scriptVariables,
    backups,
    preset: settings.presetBody() ?? DEFAULT_PRESET,
    ...settings.presetName() === undefined ? {} : { presetName: settings.presetName() },
    presets: new PresetStore(paths.presets),
    broadcast: () => {},
    diagnostics: new DiagnosticBuffer(),
    userName: process.env.IRIS_USER_NAME ?? 'User',
    contextWindow: Number(process.env.IRIS_CONTEXT_WINDOW ?? 32_768),
    onError: warn,
  })

  return { handlers: service.handlers() }
}

/**
 * Where the bytes of one snapshot are, by top-level key.
 * @param context - the snapshot.
 * @returns rows sorted by size, largest first, plus the whole-object total.
 */
function keyShares(context) {
  const total = bytes(JSON.stringify(context))
  const rows = Object.entries(context).map(([key, value]) => ({
    key,
    bytes: bytes(JSON.stringify(value) ?? 'undefined'),
    shape: Array.isArray(value)
      ? `array(${String(value.length)})`
      : value === null
        ? 'null'
        : typeof value === 'object'
          ? `object(${String(Object.keys(value).length)} keys)`
          : typeof value,
  })).sort((left, right) => right.bytes - left.bytes)
  return { total, rows }
}

/**
 * Inside the `chat` array: which per-line field carries the bytes.
 *
 * Field names and totals only — never a value.
 * @param lines - the snapshot's `chat`.
 * @returns rows sorted by size.
 */
function chatLineShares(lines) {
  const perField = new Map()
  for (const line of lines) {
    for (const [key, value] of Object.entries(line)) {
      perField.set(key, (perField.get(key) ?? 0) + bytes(JSON.stringify(value) ?? 'undefined'))
    }
  }
  return [...perField].map(([key, count]) => ({ key, bytes: count }))
    .sort((left, right) => right.bytes - left.bytes)
}

async function main() {
  const source = profilePaths(resolve(DATA), PROFILE).root
  if (!existsSync(source)) {
    console.error(`no profile at ${source}; set IRIS_PROBE_DATA`)
    process.exitCode = 1
    return
  }
  await mkdir(SCRATCH, { recursive: true })
  const scratch = await mkdtemp(join(SCRATCH, 'run-'))
  const dataDir = join(scratch, 'data')
  console.log(`profile   ${source}`)
  console.log(`copy      ${join(dataDir, PROFILE)}`)
  await cp(source, join(dataDir, PROFILE), { recursive: true })

  try {
    const { handlers } = await buildHost(dataDir)
    const listed = (await handlers['chat.list']()).chats
    const chosen = WANTED.length === 0
      ? listed
      : listed.filter(chat => WANTED.some(want =>
        chat.chatId.includes(want) || (chat.title ?? '').includes(want)))

    for (const chat of chosen) {
      const { view } = await handlers['chat.open']({ chatId: chat.chatId })
      const characterId = view.characterId
      if (characterId === undefined) {
        console.log(`\n${chat.chatId}: no card, script.context has no asker`)
        continue
      }
      console.log(`\n=== ${chat.chatId}`)
      console.log(`card      ${characterId}   messages ${String(view.messages.length)}`)

      // (a) how long the host takes, and (b) how many bytes it answers with.
      const timings = []
      let last
      for (let round = 0; round < REPEATS; round += 1) {
        const started = performance.now()
        const answer = await handlers['script.context']({ chatId: chat.chatId, characterId })
        timings.push(performance.now() - started)
        last = answer.context
      }
      const wire = JSON.stringify(last)
      console.log(`elapsed   ${timings.map(ms => `${ms.toFixed(0)} ms`).join(' → ')}`)
      console.log(`plaintext ${String(bytes(wire))} bytes (${kib(bytes(wire))})`)

      // (c) where the bytes are.
      const { total, rows } = keyShares(last)
      console.log(`by key    (sum of members ${kib(rows.reduce((sum, row) => sum + row.bytes, 0))} of ${kib(total)} whole)`)
      for (const row of rows) {
        const share = ((row.bytes / total) * 100).toFixed(1)
        console.log(`  ${row.key.padEnd(20)} ${kib(row.bytes).padStart(11)}  ${share.padStart(5)}%  ${row.shape}`)
      }
      if (Array.isArray(last.chat)) {
        console.log('  chat[] per field:')
        for (const row of chatLineShares(last.chat)) {
          console.log(`    ${row.key.padEnd(18)} ${kib(row.bytes).padStart(11)}`)
        }
      }
      if (Array.isArray(last.characters)) {
        const perCard = last.characters
          .map(card => ({ id: card.characterId, bytes: bytes(JSON.stringify(card)) }))
          .sort((left, right) => right.bytes - left.bytes)
        console.log(`  characters[]: ${String(perCard.length)} cards, largest ${kib(perCard[0]?.bytes ?? 0)}, `
          + `median ${kib(perCard[Math.floor(perCard.length / 2)]?.bytes ?? 0)}`)
      }

      // (d) does the answer depend on `messageId`?
      const floors = [undefined, 0, Math.max(0, view.messages.length - 1)]
      const seen = []
      for (const messageId of floors) {
        const answer = await handlers['script.context']({
          chatId: chat.chatId,
          characterId,
          ...messageId === undefined ? {} : { messageId },
        })
        const text = JSON.stringify(answer.context)
        seen.push({ messageId, hash: digest(text), bytes: bytes(text) })
      }
      console.log('messageId dependence:')
      for (const row of seen) {
        console.log(`  messageId=${String(row.messageId).padEnd(6)} ${String(row.bytes).padStart(8)} bytes  ${row.hash}`)
      }
      const noArg = seen[0]
      const same = seen.every(row => row.hash === noArg.hash)
      console.log(`  identical across messageId: ${same ? 'yes' : 'no — only `floor` may differ; see below'}`)
      if (!same) {
        for (const messageId of floors) {
          const answer = await handlers['script.context']({
            chatId: chat.chatId,
            characterId,
            ...messageId === undefined ? {} : { messageId },
          })
          const { floor, ...rest } = answer.context
          console.log(`  messageId=${String(messageId).padEnd(6)} rest ${digest(JSON.stringify(rest))}`
            + `  floor ${floor === undefined ? 'absent' : `present (${kib(bytes(JSON.stringify(floor)))})`}`)
        }
      }
    }
  } finally {
    if (process.env.IRIS_PROBE_KEEP === '1') console.log(`\nkept ${scratch}`)
    else await rm(scratch, { recursive: true, force: true })
  }
}

await main()
