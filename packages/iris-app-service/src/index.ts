/**
 * The Iris application service, as a Cordis plugin.
 *
 * Mounts the protocol handlers onto the transport and the character folder onto
 * the web server. It is a separate row from `@iris/rpc-host` on purpose: the
 * wire and the application have different reasons to change, and this one can
 * be unloaded and reloaded — taking its handlers with it — without dropping a
 * single page's event socket.
 *
 * @module @iris/app-service
 */

import { mkdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatCompletionPreset } from '@iris/preset'
import { DEFAULT_TIMEOUTS, OpenAiCompatAdapter } from '@iris/llm-openai-compat'
import { versionRoute } from './version.ts'

import { BackupStore, DEFAULT_BACKUP_KEEP } from './backups.ts'
import { CacheTraceStore, DEFAULT_CACHE_TRACE_KEEP } from './cache-trace.ts'
import { ChatStore } from './chats.ts'
import { CharacterLibrary } from './library.ts'
import { DEFAULT_PRESET } from './prompt.ts'
import type { CharacterCard } from '@iris/character'

import { CardStorageStore } from './card-storage.ts'
import { DiagnosticBuffer } from './diagnostics.ts'
import { acquireHostLock } from './host-lock.ts'
import { materialiseEmbeddedBook, WorldbookBindingStore } from './materialise.ts'
import { refuseOverlappingInstall, StInstall } from './st-install.ts'
import { IrisAppService } from './service.ts'
import { ConnectionStore } from './connections.ts'
import { PersonaStore } from './persona.ts'
import { FavoriteStore } from './favorites.ts'
import { ChatOrderStore } from './chat-order.ts'
import { ExtensionSettingsStore } from './context.ts'
import { DEFAULT_PROFILE, profilePaths } from './paths.ts'
import { PresetStore } from './presets.ts'
import { ScriptButtonStore } from './script-buttons.ts'
import { WorldbookStore } from './worldbooks.ts'
import { openGlobalScope } from './context.ts'
import { DEFAULT_PRUNE } from './prune.ts'
import { PluginAssetStore, type PluginAssetState } from './plugin-assets.ts'
import { serveSandboxAsset } from './sandbox-assets.ts'
import { stampShellIndex } from './shell-csp.ts'
import { ScriptCache } from './script-cache.ts'
import { presetRegexSource } from './regex.ts'
import { ScriptPolicyStore } from './scripts.ts'
import { ScriptLibraryStore } from './script-library.ts'
import { ScriptVariableStore } from './script-variables.ts'
import { SettingsStore } from './settings.ts'
import { SystemPluginRuntime } from './system-plugins.ts'
import { BUILTIN_SYSTEM_PLUGIN_DEFINITIONS } from './plugins/builtins.ts'
import { PLUGIN_ASSET_PREFIX } from '@iris/plugin-web-api'

export {
  BackupStore,
  DEFAULT_BACKUP_KEEP,
  NO_CHARACTER,
  backupStamp,
  compareBackupNames,
  parseBackupStamp,
  rotateBackups,
  type BackupIntent,
  type BackupStoreOptions,
} from './backups.ts'
export { ChatStore, formatCreateDate, seedGreeting } from './chats.ts'
export {
  SystemPluginRuntime,
  type SystemPluginActivationScope,
  type SystemPluginDefinition,
  type SystemPluginLease,
  type SystemPluginRuntimeOptions,
} from './system-plugins.ts'
export { BUILTIN_SYSTEM_PLUGIN_DEFINITIONS } from './plugins/builtins.ts'
export type { SystemPluginCapabilities } from './plugins/capabilities.ts'
export { createTavernHelperCapability, type TavernHelperCapability } from './plugins/tavern-helper.ts'
export { createMvuCapability, type MvuCapability } from './plugins/mvu.ts'
export {
  ConnectionStore,
  keyFilePathFor,
  keyTailOf,
  summarize,
  routeOf,
  type ConnectionStoreOptions,
  type ProfileInput,
} from './connections.ts'
export {
  KEY_FILE_WARNING,
  dpapiProtector,
  encryptValue,
  decryptValue,
  fileProtector,
  type EncryptedValue,
  type KeyProtector,
} from './key-protection.ts'
export type { ConnectionEndpoint } from './service.ts'
export {
  assertStorable,
  buildCardContext,
  commitChatMetadata,
  ExtensionSettingsStore,
  type ScriptContext,
} from './context.ts'
export { ChatEntry, lineTurns, metadataBackend, readMeta, type IrisChatMeta } from './entry.ts'
export { AppError, busy, invalid, notFound } from './errors.ts'
export { FavoriteStore } from './favorites.ts'
export {
  acquireHostLock,
  describeHeldLock,
  HOST_LOCK_FILE,
  isPidAlive,
  readLockRecord,
  type HostLock,
  type HostLockOptions,
  type HostLockRecord,
} from './host-lock.ts'
export { applyChatOrder, ChatOrderStore } from './chat-order.ts'
export { CharacterLibrary, type CardFileRef } from './library.ts'
export {
  DEFAULT_PROFILE,
  fileFor,
  isSafeId,
  profilePaths,
  toId,
  uniqueId,
  type ProfilePaths,
} from './paths.ts'
export {
  PluginAssetStore,
  type PluginAssetState,
  type PluginAssetStateView,
} from './plugin-assets.ts'
export {
  applyCardOverrides,
  buildPrompt,
  DEFAULT_PRESET,
  scanEntriesOf,
  type PromptInput,
  type PromptResult,
} from './prompt.ts'
export {
  placementFor,
  presetRegexSource,
  presetRegexTier,
  readPresetRegex,
  runScripts,
  scriptsOf,
  substituteFor,
  type PresetRegexPolicy,
  type PresetRegexTier,
  type ScopedRegexPolicy,
  // —— family②: regex ——
  SOURCE_PLACEMENT,
  formatAsTavernRegexed,
  fromTavernRegex,
  toTavernRegex,
} from './regex.ts'
export {
  DiagnosticBuffer,
  DEFAULT_LIMITS,
  WIRED_KINDS,
  type BufferLimits,
  type DebugReport,
  type ReportContext,
  type ReportKind,
  type ReportPage,
} from './diagnostics.ts'
export {
  canonicalBody,
  fingerprintBody,
  fingerprintLine,
  fingerprintRequest,
  parseFingerprint,
  serialiseRequest,
  PREFIX_BYTES,
  type BodySlot,
  type CanonicalBody,
  type PromptFingerprint,
} from './fingerprint.ts'
export {
  CacheTraceStore,
  divergenceOf,
  spansOf,
  traceOf,
  CACHE_TRACE_VERSION,
  DEFAULT_CACHE_TRACE_KEEP,
  TAIL_SPAN_ID,
  type CacheTraceFile,
  type CacheTraceOptions,
  type TraceSpan,
  type TraceSpanKind,
  type TraceTarget,
} from './cache-trace.ts'
export { IrisAppService, samplingOf, type AppServiceOptions, type Handlers } from './service.ts'
export {
  DEFAULT_PERSONA_DEPTH,
  DEFAULT_PERSONA_ROLE,
  PersonaStore,
  type ActivePersona,
  type PersonaInput,
  type PersonaPosition,
} from './persona.ts'
export { ScriptCache, cacheKey, type CacheFailure, type ScriptCacheOptions } from './script-cache.ts'
export {
  DEFAULT_MAX_BYTES,
  MAX_HOPS,
  fetchAllowedRemote,
  nodeFetch,
  type FetchLike,
  type RemoteFetchFailure,
  type RemoteFetchInit,
  type RemoteFetchOptions,
  type RemoteFetchOutcome,
  type RemoteResponse,
} from './remote-fetch.ts'
export { ScriptPolicyStore, scopedRegexRows } from './scripts.ts'
export { ScriptLibraryStore, viewOf as userScriptViewOf, scriptRowOf, type LibraryScope, type OwnedUserScript, type UserScriptInput } from './script-library.ts'
export { ScriptVariableStore, scriptIdOf } from './script-variables.ts'
export { SettingsStore, sanitize, type SettingsPatch } from './settings.ts'
export { SHELL_CSP_DIRECTIVES, shellPolicy, stampShellIndex, type IndexStamp } from './shell-csp.ts'
export { applyOps, buildSnapshot, scalarsOf, worldInfoOf, writePath } from './template.ts'
export { charWorldbookNames, resolveCardWorldbook, toWorldbookEntry, WorldbookStore } from './worldbooks.ts'
export type { CharWorldbookNames, ResolvedWorldbook } from './worldbooks.ts'
export {
  projectMessages,
  reasoningOf,
  textOf,
  toChatView,
  type Names,
  type PendingTurn,
} from './views.ts'

/** Cordis plugin name. */
export const name = 'iris-app-service'

/** The transport to serve on, the model registry to generate with, the carrier for avatars. */
export const inject = ['irisRpc', 'llm', 'webServer']

/** Plugin config. Every field has a default. */
export interface Config {
  /**
   * Folder holding `characters/`, `chats/` and `settings.json`.
   *
   * Relative paths resolve against the composition file's own directory, not
   * the shell's working directory — a host started from anywhere should find
   * the same library.
   * @default './data'
   */
  dataDir?: string
  /**
   * A SillyTavern **profile** directory to read books from — `…/data/<user>`,
   * not the install root.
   *
   * Unset by default, and never guessed: without it the feature does not exist.
   * Read-only, and refused at startup if it overlaps `dataDir`, because the way
   * "Iris never writes to your install" breaks is the two being one tree.
   * Users with several profiles name the one they want; enumerating them is
   * deliberately not designed, since choosing on their behalf is the wrong part.
   */
  sillyTavernDir?: string
  /**
   * Which profile's data to open.
   *
   * Multi-profile is a founding decision: the storage layer is shaped for it
   * even though this build selects a profile by configuration rather than
   * offering a switcher. The default matches SillyTavern's own `data/<user>/`
   * layout, so pointing `dataDir` at an existing install finds its characters.
   * @default 'default-user'
   */
  profile?: string
  /** Provider route new chats generate with. @default 'default' */
  provider?: string
  /** Model id new chats generate with. @default 'local-model' */
  model?: string
  /** Name recorded for the user in new chats. @default 'User' */
  userName?: string
  /** Context window in tokens. @default 32768 */
  contextWindow?: number
  /** Tokens held back for the reply. @default 1024 */
  reserveTokens?: number
  /** Fixed per-request cost of the provider's chat template, in tokens. @default 0 */
  templateOverhead?: number
  /**
   * Drop the oldest floors in multiples of this many when a conversation
   * overflows its budget, so the oldest sent floor holds still for several
   * turns and a prefix cache keeps hitting.
   *
   * Absent takes `@iris/pipeline`'s `DEFAULT_TRIM_BLOCK_FLOORS` — the default
   * lives there, beside the trimmer it governs, rather than being restated
   * here. `0` is upstream's per-floor trim.
   */
  trimBlockFloors?: number
  /** A SillyTavern Chat Completion preset to assemble with. Absent uses a thin built-in. */
  presetPath?: string
  /** Pathname prefix the card avatars are served at. @default '/iris/avatar' */
  avatarPath?: string
  /**
   * Pathname the remote-script proxy is served at.
   *
   * A card's `import()` of a CDN bundle is rewritten to this route, so the bytes
   * are fetched once by the host instead of once per chat open by an
   * opaque-origin frame that shares no cache. @default '/iris/script-bundle'
   */
  scriptBundlePath?: string
  /**
   * How long a fetched bundle is served before asking upstream again, in seconds.
   * @default 604800
   */
  scriptBundleTtlSeconds?: number
  /**
   * `index.html` of the built interface, the same value the frontend row takes.
   *
   * Given here so the sandbox's own artifacts — `bootstrap.js`, `preset.js` —
   * can be served with a CORS header: they are loaded **by** an opaque-origin
   * frame, and the plugin that serves the rest of the dist takes the fallback
   * seat with no way to set one. Absent means the route is not registered, which
   * is what a checkout with no build should do.
   */
  webDistIndex?: string
  /** Pathname prefix the sandbox artifacts are served at. @default '/sandbox' */
  sandboxPath?: string
  /**
   * Trim the variable tables of old turns, the way MVU's auto-cleanup does.
   *
   * Off by default because **it deletes state and nothing restores it**. What it
   * buys is a growth curve: without it a long chat's stored variables rise with
   * its length, which the corpus measures at roughly 201 KiB per retained
   * snapshot; with it they rise with length over the snapshot interval.
   * @default false
   */
  pruneVariables?: boolean
  /**
   * Milliseconds to wait for a provider's response headers. `0` disables it.
   *
   * The three budgets below have **no SillyTavern equivalent** — upstream's
   * generation fetch runs with `timeout: 0` and an abort wired to the browser
   * socket closing, which works there because a hung request always has a
   * person and a Stop button at the other end. See `notes/packages/iris-app-service/DEVIATIONS.md`.
   * @default 30000
   */
  connectTimeoutMs?: number
  /** Milliseconds to wait for the stream's first payload. `0` disables it. @default 120000 */
  firstByteTimeoutMs?: number
  /** Milliseconds of provider silence mid-stream before giving up. `0` disables it. @default 120000 */
  idleTimeoutMs?: number
  /** Keep every table on a turn that is a multiple of this. @default 50 */
  pruneSnapshotInterval?: number
  /** Never trim the newest this many turns. @default 20 */
  pruneKeepRecent?: number
  /**
   * Run the cards' EJS prompt templates (the ST-Prompt-Template extension).
   *
   * Off by default, and the default is the honest one: evaluating a template is
   * running the card author's JavaScript. It runs in a child process with no
   * environment, no filesystem writes, a heap ceiling, one child at a time, and
   * a `vm` realm nothing of the child's own realm reaches into — the last of
   * those true since 2026-09-11, when the three functions EJS names in every
   * template's scope (`escapeFn`, `include`, `rethrow`) stopped crossing raw and
   * `escapeFn.constructor("return process")` stopped working. Containment is
   * still a containment argument, not a reason to opt a user in for them.
   * @default false
   */
  templates?: boolean
  /**
   * Wall clock for one prompt's whole batch of templates, in milliseconds.
   *
   * Enforced host-side: `vm`'s own timeout bounds only synchronous execution,
   * and the corpus awaits.
   * @default 2000
   */
  templateDeadlineMs?: number
  /**
   * Conversation snapshots kept per chat before the oldest is deleted.
   *
   * The retention for the copies the host takes before deleting messages, before
   * a card's replay batch becomes the stored file, and before a restore writes
   * over a conversation. Upstream keeps 50 by default (`backups.common
   * .numberOfBackups`); the floor is 1, because a retention of zero would turn
   * every protected operation into the loss it was meant to prevent.
   * @default 50
   */
  backupKeep?: number
  /**
   * Request bodies kept per conversation for cache attribution, or `0` for none.
   *
   * The record is what makes a cache miss answerable after the fact:
   * `cache-trace.ts` carries the argument and `CACHE-PREFIX.md` §5.3 the
   * measurement that asked for it. Bounded because a prompt is tens of
   * kilobytes — at this default, and measured against the user's own longest
   * conversation, one chat holds roughly 700 KB.
   *
   * A count rather than a boolean beside a count, so one knob cannot disagree
   * with itself about whether the record exists.
   * @default 8
   */
  cacheTraceKeep?: number
}

/** Runtime schema for the application row. */
export const Config: z<Config> = z.object({
  dataDir: z.string().default('./data'),
  sillyTavernDir: z.string(),
  profile: z.string().default(DEFAULT_PROFILE),
  provider: z.string().default('default'),
  model: z.string().default('local-model'),
  userName: z.string().default('User'),
  contextWindow: z.natural().default(32_768),
  reserveTokens: z.natural().default(1024),
  templateOverhead: z.natural().default(0),
  // **No `.default()` on purpose**: the number belongs to the trimmer, and a
  // default restated here would be a second place to change it (and would go
  // stale silently, since both spellings would keep parsing). Absent reaches
  // the service as absent, which is what makes the pipeline's own constant the
  // one decision. Capped at 64 floors — thirty-two exchanges given up in one
  // cut is already more conversation than any preset's window holds, and a
  // bound refused at boot beats a typo that quietly empties the history.
  trimBlockFloors: z.natural().max(64),
  presetPath: z.string(),
  avatarPath: z.string().default('/iris/avatar'),
  scriptBundlePath: z.string().default('/iris/script-bundle'),
  scriptBundleTtlSeconds: z.natural().default(604_800),
  webDistIndex: z.string(),
  sandboxPath: z.string().default('/sandbox'),
  templates: z.boolean().default(false),
  pruneVariables: z.boolean().default(false),
  // Defaults deferred to the adapter's own `DEFAULT_TIMEOUTS` rather than
  // restated: two schemas that each name 30000 are two places to change it.
  connectTimeoutMs: z.natural().default(DEFAULT_TIMEOUTS.connectMs),
  firstByteTimeoutMs: z.natural().default(DEFAULT_TIMEOUTS.firstByteMs),
  idleTimeoutMs: z.natural().default(DEFAULT_TIMEOUTS.idleMs),
  pruneSnapshotInterval: z.natural().default(50),
  pruneKeepRecent: z.natural().default(20),
  templateDeadlineMs: z.natural().default(2000),
  backupKeep: z.natural().default(DEFAULT_BACKUP_KEEP),
  cacheTraceKeep: z.natural().default(DEFAULT_CACHE_TRACE_KEEP),
})

/**
 * The directory a relative config path is resolved against.
 *
 * The loader sets `baseUrl` to the composition file's folder. It is read
 * defensively because this package does not depend on the loader plugin, and a
 * hand-built context in a test has no such field.
 * @param ctx - the plugin's context.
 * @returns an absolute directory.
 */
function rootOf(ctx: Context): string {
  const base = (ctx as { baseUrl?: unknown }).baseUrl
  if (typeof base !== 'string') return process.cwd()
  try {
    return fileURLToPath(base)
  } catch {
    return process.cwd()
  }
}

/**
 * Serve one card's file as its avatar.
 *
 * The card file is the picture — a V2/V3 PNG carries the character inside the
 * image — so there is nothing to extract and nothing to cache separately.
 * @param library - the character folder.
 * @param base - the route's pathname prefix.
 * @param req - the request.
 * @param res - the response.
 */
async function serveAvatar(
  library: CharacterLibrary,
  base: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://iris.invalid').pathname
  const rest = pathname.slice(base.length).replace(/^\/+/, '')
  let characterId: string
  try {
    characterId = decodeURIComponent(rest)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  let file: { data: Buffer, extension: string }
  try {
    // `bytes` validates the id against the library rather than trusting it as a
    // path; the route is otherwise a straight read of a browser-supplied name.
    file = await library.bytes(characterId)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }

  res.writeHead(200, {
    'content-type': file.extension === '.png'
      ? 'image/png'
      : file.extension === '.jpg' || file.extension === '.jpeg'
        ? 'image/jpeg'
        : 'application/json; charset=utf-8',
    'content-length': file.data.byteLength,
    // Re-importing a card reuses its id, so a cached avatar can go stale;
    // revalidation costs one conditional request and never shows the old face.
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(file.data)
}

/**
 * Read the configured preset, falling back to the built-in one.
 * @param path - the preset file, if configured.
 * @returns the preset to assemble with.
 */
async function loadPreset(path: string | undefined): Promise<ChatCompletionPreset> {
  if (path === undefined) return DEFAULT_PRESET
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text) as ChatCompletionPreset
  if (!Array.isArray(parsed.prompts)) {
    throw new Error(`${path} is not a SillyTavern Chat Completion preset: no "prompts" array`)
  }
  return parsed
}

/**
 * Say something when data is sitting in the pre-profile layout.
 *
 * Earlier builds wrote straight into `dataDir`. Moving it automatically would be
 * worse than saying so: a silent migration of someone's chats is unreviewable,
 * and the failure mode of saying nothing — an empty library where there used to
 * be one — reads as data loss.
 * @param ctx - the plugin context, for its logger.
 * @param dataDir - the root holding every profile.
 * @param profileRoot - where this profile's data is expected.
 */
function warnOnPreProfileLayout(ctx: Context, dataDir: string, profileRoot: string): void {
  if (existsSync(profileRoot)) return
  const legacy = join(dataDir, 'characters')
  if (!existsSync(legacy)) return
  ctx.logger.warn(
    `iris: found characters directly in ${dataDir}, which is the pre-profile layout. `
    + `This build reads ${profileRoot}. Move the contents there, or set the composition's `
    + '`profile` to the folder they are already in.',
  )
}

/**
 * Mount the application.
 * @param ctx - context carrying `irisRpc`, `llm` and `webServer`.
 * @param config - data folder, model route and budget.
 * @returns nothing; the registrations are owned by the fiber's effects.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = rootOf(ctx)
  const dataDir = resolve(root, config.dataDir ?? './data')
  const avatarPath = config.avatarPath ?? '/iris/avatar'

  /*
   * **The data directory is taken before anything reads or writes in it.**
   *
   * Every store here is a whole-file rewrite from in-memory state, so two hosts
   * on one directory are two copies of the same files and the second one's save
   * overwrites the first one's newer file whole — silently, on both sides. This
   * is the first statement in `apply` for the same reason
   * `refuseOverlappingInstall` is early: by the time a store has read a file the
   * damage is already possible, and the only honest place to refuse is before
   * the first read.
   *
   * The port recorded is `ctx.webServer.port`, the **bound** one. This plugin
   * injects `webServer`, so the carrier has finished listening by the time
   * `apply` runs and the value is the port a person would actually open —
   * which is what the refusal sentence has to name to be actionable.
   *
   * The release is a fiber effect rather than a `process.on('exit')` handler:
   * `bin.ts`'s SIGINT/SIGTERM path disposes the fiber, the tests dispose it,
   * and an effect is the one spelling that covers both. A crash releases
   * nothing, deliberately — see `host-lock.ts`.
   */
  const lock = await acquireHostLock(dataDir, { port: ctx.webServer.port })
  if (lock.takeover !== undefined) ctx.logger.warn(lock.takeover)
  // The disposer is `async` and its promise is returned, the way the carrier's
  // own listen effect is: a fire-and-forget release resolves `dispose()` before
  // the file is gone, so a supervisor that restarts the host the instant the old
  // one exits races its own lock — measured, as a failing assertion that the
  // file was gone after `fiber.dispose()`.
  ctx.effect(() => async () => {
    await lock.release().catch((error: unknown) => {
      ctx.logger.warn(error instanceof Error ? error.message : String(error))
    })
  }, 'irisApp.hostLock')

  // Every path comes from one derivation, so a profile is one segment rather
  // than a change in five places — and so a store added later cannot be the one
  // that forgot to be profile-scoped.
  const paths = profilePaths(dataDir, config.profile ?? DEFAULT_PROFILE)
  warnOnPreProfileLayout(ctx, dataDir, paths.root)
  // The profile root is created here, once, because boot itself writes into
  // it before any store's first save does: the system-plugin runtime's
  // `initialize` persists its boot-revision increment immediately, and every
  // store's mkdir is lazy (on first write), so on a fresh profile the write
  // raced nothing — the directory simply did not exist yet, and the host
  // died in `atomicWriteFile` before serving a single request.
  await mkdir(paths.root, { recursive: true })

  // Retention for the diagnostic bus. Reports already reached the logger and
  // stopped there, so a debug page had nothing to ask for; this keeps a bounded
  // window of them in memory. Not persisted deliberately — a restart empties it
  // and says so through `oldest`.
  //
  // **Constructed first**, before any store, because the stores now report
  // through it: a store's file is read on first use, which for most of them is
  // after boot, and a report that arrives then has to land in the same buffer
  // the service's own `#report` writes to or the debug page would be showing
  // two different histories of one host.
  const diagnostics = new DiagnosticBuffer()
  /**
   * What a store says when its file was there and could not be used.
   *
   * The service's `#report(message, { kind, grade })` in two lines, because
   * this runs before the service exists and the stores it belongs to are
   * constructed here. Same buffer, same logger, so the record reaches
   * `debug.reports` exactly as a fault raised inside a generation does.
   *
   * `grade: 'fault'` — the call that triggered the load was served, with
   * defaults, which is precisely the thing worth flagging. Not `irreversible`:
   * the bytes were set aside rather than lost, and that is the whole point of
   * quarantining them, so this waits to be asked for instead of interrupting
   * every open page.
   */
  const reportStoreProblem = (message: string): void => {
    diagnostics.record({ kind: 'host', grade: 'fault' }, message)
    ctx.logger.warn(message)
  }
  /**
   * What a store says when it **did** something on the user's behalf.
   *
   * `grade: 'note'` and `logger.info`, because the one caller today — the
   * connection keys being encrypted at rest on the first boot after 2026-09-11
   * (§75) — is a success. Filing it through `reportStoreProblem` would put a
   * completed upgrade in the same list as an unreadable key file, and telling
   * those two apart is the debug page's whole job.
   */
  const reportStoreNote = (message: string): void => {
    diagnostics.record({ kind: 'host', grade: 'note' }, message)
    ctx.logger.info(message)
  }

  const library = new CharacterLibrary(paths.characters, avatarPath)
  const scriptVariables = new ScriptVariableStore(paths.scriptVariables,
    error => { ctx.logger.warn(error instanceof Error ? error.message : String(error)) },
    reportStoreProblem)
  const extensionSettingsStore = new ExtensionSettingsStore(paths.extensionSettings, reportStoreProblem)
  // Loaded before the chats, because the `global` scope is read synchronously by
  // a card and a synchronous read cannot wait for a file.
  const globalScope = await openGlobalScope(extensionSettingsStore, error => { ctx.logger.warn(error.message) })
  const worldbooks = new WorldbookStore(paths.worlds)
  // Declared before `chats`, which closes over it. The closure is only called
  // when a chat opens, so the old order happened to work — but it left a
  // temporal-dead-zone hazard one refactor away from a `ReferenceError` that
  // would only appear if something ever opened a chat during construction.
  const settings = new SettingsStore(paths.settings, {
    provider: config.provider ?? 'default',
    model: config.model ?? 'local-model',
  }, reportStoreProblem)
  // Which named book each card's embedded book became. Beside the installation
  // rather than in the card, so a card exported back to SillyTavern is
  // unchanged — the same decision as `script-variables.json`.
  const worldbookBindings = new WorldbookBindingStore(
    paths.worldbookBindings, error => { ctx.logger.warn(error.message) }, reportStoreProblem)

  /**
   * Materialise a card's embedded book, once, however the card first arrives.
   *
   * The same function backs the import path and the open path, so an existing
   * profile migrates the first time each of its chats is opened rather than
   * needing an offline pass.
   */
  // Refused before anything reads or writes: discovering the overlap later is
  // not recoverable, because by then our writes have landed in their library.
  const overlap = config.sillyTavernDir === undefined
    ? undefined
    : refuseOverlappingInstall(config.sillyTavernDir, dataDir)
  if (overlap !== undefined) throw new Error(overlap)
  const stInstall = new StInstall(config.sillyTavernDir)

  const bookFor = async (
    characterId: string | undefined,
    card: CharacterCard | undefined,
  ): Promise<string | undefined> => {
    if (characterId === undefined || worldbooks === undefined) return undefined
    const done = await materialiseEmbeddedBook(
      characterId, card, worldbooks, worldbookBindings, stInstall)
    for (const line of done?.reports ?? []) ctx.logger.warn(`worldbook: ${line}`)
    return done?.name
  }

  // The pre-change copies: beside the chats they protect, one store shared by
  // the chat store (whose own backup arm writes through it) and the service
  // (whose dangerous-operation guards and backup.* methods read it).
  const backups = new BackupStore(paths.chats, {
    keep: config.backupKeep ?? DEFAULT_BACKUP_KEEP,
    onError: error => { ctx.logger.warn(`backups: ${error.message}`) },
  })

  // The bodies of the most recent requests, for cache attribution. Constructed
  // unconditionally and switched off by a retention of `0` — the store answers
  // `enabled: false` and every method becomes a no-op — so "off" is one
  // reading of one number rather than an absent object some call sites check
  // for and others do not.
  const cacheTrace = new CacheTraceStore(paths.cacheTrace, {
    keep: config.cacheTraceKeep ?? DEFAULT_CACHE_TRACE_KEEP,
    onError: error => { ctx.logger.warn(`cache trace: ${error.message}`) },
  })

  // Its own file, not a section of `settings.json`: sampling is a preference and
  // this is a permission record. Keeping them apart means a settings reset
  // cannot hand a card the page document.
  //
  // Constructed **before** the chat store, because the chat store composes each
  // conversation's regex from it: the user's allow switch for a card's own tier
  // and their switches over its individual rules.
  const scripts = new ScriptPolicyStore(paths.scriptPolicy, reportStoreProblem)
  // The user's own scripts. Beside the policy file rather than inside it, and
  // beside the cards rather than inside them — see `paths.scriptLibrary`.
  const scriptLibrary = new ScriptLibraryStore(paths.scriptLibrary, reportStoreProblem)

  /**
   * The last malformed-row report, so one preset is said once rather than on
   * every chat open.
   *
   * Keyed by preset **and count**: the same preset reporting a different number
   * is new information (its file changed under us), and the same pair twice is
   * the same fact read twice. Deduplicated rather than dropped, because the
   * durable channel for this number is the panel — `regex.presetList` carries
   * `malformed` — and the log line exists for the operator who is reading a
   * transcript rather than a drawer.
   */
  let reportedPresetRegex: string | undefined
  const reportMalformedPresetRegex = (tier: { presetName: string, malformed: number, scripts: readonly unknown[] }): void => {
    const key = `${tier.presetName}:${String(tier.malformed)}`
    if (reportedPresetRegex === key) return
    reportedPresetRegex = key
    ctx.logger.warn(
      `preset regex: "${tier.presetName}" carries ${String(tier.malformed)}`
      + ` unrunnable rule(s) (no pattern, or an empty one) — skipped;`
      + ` ${String(tier.scripts.length)} runnable`,
    )
  }

  const systemPlugins = new SystemPluginRuntime({
    context: ctx,
    file: join(paths.root, 'system-plugins.json'),
    definitions: BUILTIN_SYSTEM_PLUGIN_DEFINITIONS,
    onError: error => { reportStoreProblem(error.message) },
  })
  await systemPlugins.initialize()
  ctx.effect(
    () => async () => { await systemPlugins.dispose() },
    'irisApp.systemPlugins',
  )
  ctx.effect(
    () => systemPlugins.onChange(snapshot => {
      ctx.irisRpc.broadcast({ type: 'plugins.changed', snapshot })
    }),
    'irisApp.systemPlugins.changed',
  )

  const chats = new ChatStore(
    paths.chats, library, scriptVariables, globalScope, worldbooks,
    // Read through a closure rather than captured: the selection is a setting
    // the user can change at runtime, and a value read here would freeze it.
    () => settings.globalSelect(),
    bookFor,
    // The active persona description, read at expansion time — the same
    // closure reaches every chat, so a switch lands at the next expansion
    // without reopening anything. The store is primed below, before the first
    // chat can open, so the closure answers from memory.
    () => personas.activeSync() ?? '',
    // Same rule, same reason: the global regex list is edited at runtime, and
    // each open composes from whatever it says right now.
    () => extensionSettingsStore.globalRegex(),
    // The per-character extra bindings — upstream's `world_info.charLore`.
    // Edited at runtime like the two above, so the closure rather than a
    // captured value; a chat re-open is when a rebind reaches a conversation.
    characterId => settings.charBooks(characterId),
    // The snapshot store, shared with the service below — one retention
    // setting, one directory layout, wherever a copy is taken from.
    backups,
    // The user's decisions about the card's own regex tier, read at open time
    // and again on every `refreshRegex`. A closure for the reason the global
    // list above is one: both are edited while the host runs.
    characterId => scripts.scopedRegex(characterId),
    // The **active preset's** own regex tier — upstream's third tier, read
    // from the switched-in preset body's `extensions.regex_scripts` and gated
    // on the user having allow-listed that preset by name.
    //
    // A closure over the *persisted* selection, which is the same pair the
    // service's own panel projection reads (`activePresetRegexSource`), so the
    // list a reader switches and the list a conversation runs cannot come from
    // two different presets. Read fresh here for one more reason than the two
    // closures above have: which preset is active is itself runtime state, so a
    // value captured at boot would keep the launch preset's rewrites running
    // over prompts assembled from a different preset entirely.
    presetRegexSource(
      () => ({ name: settings.presetName(), body: settings.presetBody() }),
      presetName => scripts.presetRegex(presetName),
      reportMalformedPresetRegex,
    ),
    systemPlugins,
  )
  // Kept apart from `script-policy.json` because they answer to different
  // owners: the policy file is the user's decisions, this is data cards wrote.
  const extensionSettings = extensionSettingsStore
  // Runtime button tables, beside the installation rather than in the card —
  // the same decision as `script-variables.json`, and for the same reason.
  const scriptButtons = new ScriptButtonStore(
    paths.scriptButtons, error => { ctx.logger.warn(error.message) }, reportStoreProblem)
  // The keys in here are encrypted at rest (§75): the data key beside the file
  // is wrapped by the OS where there is a keystore to wrap it with, and the
  // first boot on an older profile migrates the plaintext away and says so
  // through `reportStoreNote`.
  const connections = new ConnectionStore(paths.connections, reportStoreProblem, { onNote: reportStoreNote })
  // The user's personas — who `{{user}}` is. Its own file, like the
  // connections beside it, for the same owner-separation reason.
  const personas = new PersonaStore(paths.personas, reportStoreProblem)
  // The characters this profile has starred. Profile-level rather than the
  // card's `fav`, on the standing rule that runtime state stays out of shared
  // card files — an exported card carries no trace of the stars it earned here.
  const favorites = new FavoriteStore(paths.favorites, reportStoreProblem)
  // The order the reader put their conversations in — beside the stars, for the
  // same reason: both are decisions about this profile's own shelf rather than
  // settings a chat is using. Upstream keeps no manual chat order at all, so
  // both the file and its name are Iris's (`chat-order.ts`), and a profile that
  // has never dragged a row never gets the file.
  const chatOrder = new ChatOrderStore(paths.chatOrder, reportStoreProblem)
  // Runtime adapter installs, one per provider route this plugin has claimed.
  //
  // `connection.activate` and boot-time restoration both come through here: a
  // profile carrying its own endpoint needs an adapter that can see that
  // endpoint and its key, and the composition's own registration — route
  // `default` — belongs to the `llm-openai-compat` row, which this runtime
  // neither owns nor may displace. Replacing a route we installed before is
  // how two profiles of one provider take turns; the in-flight stream of the
  // old one keeps its adapter object and finishes untouched.
  //
  // Each install is wrapped in its own `ctx.effect` (the same shape the
  // `llm-openai-compat` row uses), so the disposer is owned by this fiber:
  // unloading the app plugin takes its runtime adapters with it, and a
  // remount re-runs the boot restoration below — a hot reload can no longer
  // leave a stale `conn/<id>` route behind to trip `DUPLICATE_ADAPTER`. The
  // map is only the replacement index, not the lifetime owner.
  const installed = new Map<string, () => void>()
  const installConnection = (route: string, endpoint: { baseURL: string, apiKey?: string, apiKeyHeader?: string }): void => {
    installed.get(route)?.()
    installed.set(route, ctx.effect(
      () => ctx.llm.registerAdapter([route], new OpenAiCompatAdapter({
        provider: route,
        displayName: route,
        baseURL: endpoint.baseURL,
        ...endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey },
        ...endpoint.apiKeyHeader === undefined ? {} : { apiKeyHeader: endpoint.apiKeyHeader },
        models: [],
        // Absent stays absent — `exactOptionalPropertyTypes` is on, and the
        // adapter resolves a missing budget to its own default, so an explicit
        // `undefined` would be both a type error and a second way to say the
        // same thing. Per route because a self-hosted endpoint and a cloud one
        // are exactly the pair a profile distinguishes; the per-profile
        // override is a protocol change and is not this batch.
        ...config.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.connectTimeoutMs },
        ...config.firstByteTimeoutMs === undefined ? {} : { firstByteTimeoutMs: config.firstByteTimeoutMs },
        ...config.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: config.idleTimeoutMs },
      })),
      `irisApp: adapter ${route}`,
    ))
  }
  // Shared across the profile, matching upstream's one `localStorage` per
  // origin. Not partitioned per card, and deliberately not forgotten when a
  // card is deleted — see `character.delete`.
  const cardStorage = new CardStorageStore(
    paths.cardStorage, error => { ctx.logger.warn(error.message) }, reportStoreProblem)

  // The folders are created on first write, not on boot: a host that has never
  // been used should leave nothing behind, and both stores already tolerate a
  // directory that does not exist yet.
  await settings.load()
  // A brand-new profile takes its world-info scan knobs from the user's own
  // SillyTavern install, if one is configured — a migration convenience, once,
  // not a sync (DEVIATIONS.md §21). The store decides whether this is a first
  // run and only then asks the install, so an existing profile never has its
  // knobs re-read from someone else's settings file.
  for (const line of await settings.seedWorldbookSettings(() => stInstall.worldInfoSettings())) {
    ctx.logger.warn(`worldbook settings: ${line}`)
  }
  // Primed before any chat can open, so the persona closure the chats carry
  // answers from memory instead of racing a file read inside a macro.
  await personas.prime()

  // The profile's preset library — the files a switch reads and an import
  // fills. Beside the installation, like every other store here.
  const presets = new PresetStore(paths.presets)

  // What the host assembles with at boot: a selection the user made in a
  // previous run outranks the composition's file, because that is what
  // persisting the choice means — a restart that snapped back to `presetPath`
  // would make the picker a preference the host forgets. Absent (nothing ever
  // switched or edited), the configured file stands, so a config-driven host
  // stays config-driven.
  const storedPreset = settings.presetBody()
  const storedPresetName = settings.presetName()

  const service = new IrisAppService({
    stream: options => ctx.llm.stream(options),
    // **The product requires a provider in use.** The user's ruling of
    // 2026-09-10: 「宿主环境这个功能废弃了，以后都从在 Iris 中自己添加供应商来调用
    // 模型」. Hard-coded rather than a `Config` row, because it is not a
    // deployment preference — it is what the connection card now means, and a
    // row would invite a composition to turn the card's own promise off. The
    // service's default is the opposite (see its option's docblock): a host
    // composed without a `connections` store cannot have a provider in use and
    // must not be locked out of generating by a flag it cannot satisfy.
    requireProvider: true,
    library,
    chats,
    settings,
    plugins: systemPlugins,
    scripts,
    scriptLibrary,
    extensionSettings,
    scriptButtons,
    worldbooks,
    connections,
    personas,
    favorites,
    chatOrder,
    worldbookBindings,
    installConnection,
    scriptVariables,
    backups,
    cacheTrace,
    preset: storedPreset ?? await loadPreset(config.presetPath),
    ...storedPresetName === undefined ? {} : { presetName: storedPresetName },
    presets,
    ...config.sillyTavernDir === undefined ? {} : { sillyTavernDir: config.sillyTavernDir },
    broadcast: event => { ctx.irisRpc.broadcast(event) },
    diagnostics,
    cardStorage,
    ...config.userName === undefined ? {} : { userName: config.userName },
    ...config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow },
    ...config.reserveTokens === undefined ? {} : { reserveTokens: config.reserveTokens },
    ...config.templateOverhead === undefined ? {} : { templateOverhead: config.templateOverhead },
    ...config.trimBlockFloors === undefined ? {} : { trimBlockFloors: config.trimBlockFloors },
    // `templates: false` must produce no key at all: in the service, presence is
    // the switch, and a `{}` here would silently turn the feature on.
    ...config.templates !== true
      ? {}
      : { templates: config.templateDeadlineMs === undefined ? {} : { deadlineMs: config.templateDeadlineMs } },
    // Same rule as `templates` above: presence is the switch, so `false` must
    // produce no key. **This pass-through was missing from the commit that added
    // the feature** — the three settings were declared on the config and read by
    // nothing, so the cleanup could not run however it was configured. Declaring
    // an option and consuming an option are two edits, and the schema being right
    // is what makes the omission invisible.
    ...config.pruneVariables !== true
      ? {}
      : {
          pruneVariables: {
            snapshotInterval: config.pruneSnapshotInterval ?? DEFAULT_PRUNE.snapshotInterval,
            keepRecent: config.pruneKeepRecent ?? DEFAULT_PRUNE.keepRecent,
          },
        },
    // The message, not the Error, so the log line carries the text a reader
    // needs regardless of how any exporter renders objects.
    onError: error => { ctx.logger.warn(error instanceof Error ? error.message : String(error)) },
  })

  // A host whose provider list is empty while its environment names an endpoint
  // is a host that used to generate through that environment and now cannot
  // (`requireProvider` above). So the environment is copied into the list as an
  // ordinary provider, once, and applied — the first turn after the upgrade
  // goes where the last turn before it went. Before the restore below, so the
  // profile it just applied is the one that gets its adapter installed; on
  // every later start this does nothing and the restore does the work.
  await service.importLaunchConnection()
  // The last activated profile comes back the same way after a restart: its
  // adapter is in place before any handler is registered, because a persisted
  // route (`conn/<id>` or the profile's provider) in `settings.json` is a
  // promise the registry has to be able to keep on the first turn.
  //
  // Asked of the **service** rather than performed here, which is not tidying:
  // the service keeps the set of routes this process has installed, and an
  // install performed behind its back is one it cannot see — the boot-restored
  // route would read as "never installed" and the first generation on it would
  // install it a second time. Same installer, same effect wrapper, one owner.
  await service.restoreActiveConnection()

  const handlers = service.handlers()

  // Registered one by one rather than by iterating the table: `register` is
  // generic per method, and a loop would need a cast that throws away exactly
  // the check worth having here.
  ctx.effect(() => {
    const disposers = [
      ctx.irisRpc.register('plugin.list', handlers['plugin.list']),
      ctx.irisRpc.register('plugin.install', handlers['plugin.install']),
      ctx.irisRpc.register('plugin.uninstall', handlers['plugin.uninstall']),
      ctx.irisRpc.register('plugin.enable', handlers['plugin.enable']),
      ctx.irisRpc.register('plugin.disable', handlers['plugin.disable']),
      ctx.irisRpc.register('plugin.reload', handlers['plugin.reload']),
      ctx.irisRpc.register('debug.reports', handlers['debug.reports']),
      ctx.irisRpc.register('storage.set', handlers['storage.set']),
      ctx.irisRpc.register('storage.remove', handlers['storage.remove']),
      ctx.irisRpc.register('storage.clear', handlers['storage.clear']),
      ctx.irisRpc.register('chat.list', handlers['chat.list']),
      ctx.irisRpc.register('chat.create', handlers['chat.create']),
      ctx.irisRpc.register('chat.open', handlers['chat.open']),
      ctx.irisRpc.register('chat.delete', handlers['chat.delete']),
      ctx.irisRpc.register('chat.rename', handlers['chat.rename']),
      ctx.irisRpc.register('chat.reorder', handlers['chat.reorder']),
      ctx.irisRpc.register('chat.search', handlers['chat.search']),
      // Beside `chat.search` because it is the same file scan; it is not a
      // `chat.` method because it is not about a chat — it answers across every
      // conversation in the profile.
      ctx.irisRpc.register('usage.summary', handlers['usage.summary']),
      ctx.irisRpc.register('chat.answerCleanup', handlers['chat.answerCleanup']),
      ctx.irisRpc.register('chat.send', handlers['chat.send']),
      ctx.irisRpc.register('chat.regenerate', handlers['chat.regenerate']),
      ctx.irisRpc.register('chat.compact', handlers['chat.compact']),
      ctx.irisRpc.register('chat.abort', handlers['chat.abort']),
      ctx.irisRpc.register('chat.swipe', handlers['chat.swipe']),
      ctx.irisRpc.register('chat.editMessage', handlers['chat.editMessage']),
      ctx.irisRpc.register('chat.deleteMessage', handlers['chat.deleteMessage']),
      ctx.irisRpc.register('chat.branch', handlers['chat.branch']),
      ctx.irisRpc.register('chat.import', handlers['chat.import']),
      ctx.irisRpc.register('chat.export', handlers['chat.export']),
      ctx.irisRpc.register('backup.list', handlers['backup.list']),
      ctx.irisRpc.register('backup.preview', handlers['backup.preview']),
      ctx.irisRpc.register('backup.restore', handlers['backup.restore']),
      ctx.irisRpc.register('backup.delete', handlers['backup.delete']),
      ctx.irisRpc.register('prompt.itemize', handlers['prompt.itemize']),
      ctx.irisRpc.register('prompt.divergence', handlers['prompt.divergence']),
      ctx.irisRpc.register('script.getVariables', handlers['script.getVariables']),
      ctx.irisRpc.register('script.setVariables', handlers['script.setVariables']),
      ctx.irisRpc.register('script.swipeTo', handlers['script.swipeTo']),
      ctx.irisRpc.register('script.slash', handlers['script.slash']),
      ctx.irisRpc.register('connection.list', handlers['connection.list']),
      ctx.irisRpc.register('connection.save', handlers['connection.save']),
      ctx.irisRpc.register('connection.delete', handlers['connection.delete']),
      ctx.irisRpc.register('connection.activate', handlers['connection.activate']),
      ctx.irisRpc.register('connection.test', handlers['connection.test']),
      ctx.irisRpc.register('character.list', handlers['character.list']),
      ctx.irisRpc.register('character.import', handlers['character.import']),
      ctx.irisRpc.register('character.delete', handlers['character.delete']),
      ctx.irisRpc.register('character.duplicate', handlers['character.duplicate']),
      ctx.irisRpc.register('character.rename', handlers['character.rename']),
      ctx.irisRpc.register('character.export', handlers['character.export']),
      ctx.irisRpc.register('character.setTags', handlers['character.setTags']),
      ctx.irisRpc.register('character.favorite', handlers['character.favorite']),
      ctx.irisRpc.register('settings.get', handlers['settings.get']),
      ctx.irisRpc.register('settings.set', handlers['settings.set']),
      ctx.irisRpc.register('persona.list', handlers['persona.list']),
      ctx.irisRpc.register('persona.get', handlers['persona.get']),
      ctx.irisRpc.register('persona.set', handlers['persona.set']),
      ctx.irisRpc.register('persona.delete', handlers['persona.delete']),
      ctx.irisRpc.register('preset.list', handlers['preset.list']),
      ctx.irisRpc.register('preset.select', handlers['preset.select']),
      ctx.irisRpc.register('preset.view', handlers['preset.view']),
      ctx.irisRpc.register('preset.setEnabled', handlers['preset.setEnabled']),
      ctx.irisRpc.register('preset.move', handlers['preset.move']),
      ctx.irisRpc.register('preset.upsertPrompt', handlers['preset.upsertPrompt']),
      ctx.irisRpc.register('preset.removePrompt', handlers['preset.removePrompt']),
      ctx.irisRpc.register('preset.save', handlers['preset.save']),
      ctx.irisRpc.register('preset.delete', handlers['preset.delete']),
      ctx.irisRpc.register('preset.read', handlers['preset.read']),
      ctx.irisRpc.register('preset.import', handlers['preset.import']),
      ctx.irisRpc.register('preset.importFile', handlers['preset.importFile']),
      ctx.irisRpc.register('regex.list', handlers['regex.list']),
      ctx.irisRpc.register('regex.set', handlers['regex.set']),
      ctx.irisRpc.register('regex.scopedList', handlers['regex.scopedList']),
      ctx.irisRpc.register('regex.setScopedAllowed', handlers['regex.setScopedAllowed']),
      ctx.irisRpc.register('regex.setScopedEnabled', handlers['regex.setScopedEnabled']),
      ctx.irisRpc.register('regex.presetList', handlers['regex.presetList']),
      ctx.irisRpc.register('regex.setPresetAllowed', handlers['regex.setPresetAllowed']),
      ctx.irisRpc.register('regex.setPresetEnabled', handlers['regex.setPresetEnabled']),
      ctx.irisRpc.register('scriptLibrary.list', handlers['scriptLibrary.list']),
      ctx.irisRpc.register('scriptLibrary.read', handlers['scriptLibrary.read']),
      ctx.irisRpc.register('scriptLibrary.save', handlers['scriptLibrary.save']),
      ctx.irisRpc.register('scriptLibrary.delete', handlers['scriptLibrary.delete']),
      ctx.irisRpc.register('scriptLibrary.setEnabled', handlers['scriptLibrary.setEnabled']),
      ctx.irisRpc.register('script.list', handlers['script.list']),
      ctx.irisRpc.register('script.setEnabled', handlers['script.setEnabled']),
      ctx.irisRpc.register('script.body', handlers['script.body']),
      ctx.irisRpc.register('script.setDocumentGrant', handlers['script.setDocumentGrant']),
      ctx.irisRpc.register('script.setScriptsAllowed', handlers['script.setScriptsAllowed']),
      ctx.irisRpc.register('script.fetch', handlers['script.fetch']),
      ctx.irisRpc.register('script.context', handlers['script.context']),
      ctx.irisRpc.register('script.saveMetadata', handlers['script.saveMetadata']),
      ctx.irisRpc.register('script.saveChat', handlers['script.saveChat']),
      ctx.irisRpc.register('script.setExtensionPrompt', handlers['script.setExtensionPrompt']),
      ctx.irisRpc.register('script.runEnded', handlers['script.runEnded']),
      ctx.irisRpc.register('script.setExtensionSettings', handlers['script.setExtensionSettings']),
      ctx.irisRpc.register('script.generateRaw', handlers['script.generateRaw']),
      ctx.irisRpc.register('script.generate', handlers['script.generate']),
      ctx.irisRpc.register('script.setChatMessages', handlers['script.setChatMessages']),
      ctx.irisRpc.register('script.evalTemplate', handlers['script.evalTemplate']),
      ctx.irisRpc.register('script.replaceScriptButtons', handlers['script.replaceScriptButtons']),
      ctx.irisRpc.register('script.getPreset', handlers['script.getPreset']),
      ctx.irisRpc.register('script.createChatMessages', handlers['script.createChatMessages']),
      ctx.irisRpc.register('script.deleteChatMessages', handlers['script.deleteChatMessages']),
      ctx.irisRpc.register('worldbook.names', handlers['worldbook.names']),
      ctx.irisRpc.register('worldbook.get', handlers['worldbook.get']),
      ctx.irisRpc.register('worldbook.load', handlers['worldbook.load']),
      ctx.irisRpc.register('worldbook.charNames', handlers['worldbook.charNames']),
      ctx.irisRpc.register('worldbook.charDigest', handlers['worldbook.charDigest']),
      ctx.irisRpc.register('worldbook.replace', handlers['worldbook.replace']),
      ctx.irisRpc.register('worldbook.create', handlers['worldbook.create']),
      ctx.irisRpc.register('worldbook.globalSelect', handlers['worldbook.globalSelect']),
      ctx.irisRpc.register('worldbook.setGlobalSelect', handlers['worldbook.setGlobalSelect']),
      ctx.irisRpc.register('worldbook.bindChat', handlers['worldbook.bindChat']),
      ctx.irisRpc.register('worldbook.setCharBooks', handlers['worldbook.setCharBooks']),
      ctx.irisRpc.register('worldbook.settings', handlers['worldbook.settings']),
      ctx.irisRpc.register('worldbook.setSettings', handlers['worldbook.setSettings']),
      // —— family②: regex ——
      ctx.irisRpc.register('regex.tavernList', handlers['regex.tavernList']),
      ctx.irisRpc.register('regex.tavernReplace', handlers['regex.tavernReplace']),
      ctx.irisRpc.register('regex.tavernFormat', handlers['regex.tavernFormat']),

      // —— family④: lorebook / worldbook ——
      ctx.irisRpc.register('worldbook.delete', handlers['worldbook.delete']),
      // —— family①: identity & messages ——
      ctx.irisRpc.register('script.getCharacter', handlers['script.getCharacter']),
      ctx.irisRpc.register('script.chatHistoryBrief', handlers['script.chatHistoryBrief']),
      ctx.irisRpc.register('script.chatHistoryDetail', handlers['script.chatHistoryDetail']),
      ctx.irisRpc.register('script.rotateChatMessages', handlers['script.rotateChatMessages']),
      // —— family③: preset ——
      ctx.irisRpc.register('script.createOrReplacePreset', handlers['script.createOrReplacePreset']),
      ctx.irisRpc.register('script.deletePreset', handlers['script.deletePreset']),
      ctx.irisRpc.register('script.renamePreset', handlers['script.renamePreset']),
      ctx.irisRpc.register('script.loadPreset', handlers['script.loadPreset']),
      // —— family③ end ——
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
      // Drain the coalesced storage writes. Without this the debounce turns a
      // shutdown into "the last few hundred milliseconds of a card's state
      // never happened" — and a card cannot tell that apart from a write that
      // was refused, because neither says anything.
      void cardStorage.flush().catch((error: unknown) => {
        ctx.logger.warn(error instanceof Error ? error.message : String(error))
      })
    }
  }, 'irisApp.handlers')

  /*
   * **Every route below goes through `ctx.irisRpc.guard`.**
   *
   * The transport's `Host` allow-list is not about the RPC endpoint; it is
   * about this process. A page at `http://127.0.0.1.nip.io:8787` — public
   * wildcard DNS resolving to loopback — is a browser origin an attacker owns
   * that becomes same-origin with this host, and these four routes are as
   * readable to it as the RPC endpoint is: avatars are the user's character
   * library, the script bundle is the card code running in their sandbox, and
   * `/version` names the build. `guard` is the same predicate the RPC POST and
   * the event upgrade use, so there is one rule in one place
   * (`notes/packages/iris-rpc-host/DEVIATIONS.md` §1, and §70 below).
   *
   * Wrapped at the registration rather than inside each handler, so a handler
   * cannot forget it — and so the sandbox route keeps its `Origin: null` CORS
   * behaviour untouched, which the card frames depend on: `Origin` is not what
   * is being checked here.
   */
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: avatarPath,
      handler: ctx.irisRpc.guard((req, res) => serveAvatar(library, avatarPath, req, res)),
    }),
    `irisApp: GET ${avatarPath}`,
  )

  // The route object is built in `version.ts` so a test can hold the same one
  // the server gets; this line is the only part no test can reach.
  const version = versionRoute()
  ctx.effect(
    () => ctx.webServer.register({ ...version, handler: ctx.irisRpc.guard(version.handler) }),
    'irisApp: GET /version',
  )

  const bundlePath = config.scriptBundlePath ?? '/iris/script-bundle'
  const bundles = new ScriptCache({
    dir: paths.scriptBundles,
    onError: error => { ctx.logger.warn(error.message) },
    // Into the buffer as well as the log, because this is the channel a card
    // author reads when an overlay does not appear. Graded a fault: the bundle
    // was served, but the import inside it was not, and the page is missing a
    // module it asked for.
    onReport: message => {
      diagnostics.record({ kind: 'script', grade: 'fault' }, message)
      ctx.logger.warn(`script: ${message}`)
    },
    ...config.scriptBundleTtlSeconds === undefined ? {} : { ttlSeconds: config.scriptBundleTtlSeconds },
  })
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: bundlePath,
      handler: ctx.irisRpc.guard((req, res) => bundles.serve(req, res)),
    }),
    `irisApp: GET ${bundlePath}`,
  )

  // Claimed as a prefix so it is matched ahead of the frontend plugin, which
  // takes the webserver's fallback seat. Only registered when there is a build
  // to serve from: a route answering 404 for everything would be worse than no
  // route, because the fallback would no longer get a chance to answer.
  const sandboxPath = config.sandboxPath ?? '/sandbox'
  if (config.webDistIndex !== undefined && config.webDistIndex !== '') {
    const sandboxDir = join(dirname(config.webDistIndex), sandboxPath.replace(/^\/+/, ''))
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'prefix',
        path: sandboxPath,
        handler: ctx.irisRpc.guard((req, res) => serveSandboxAsset(sandboxDir, sandboxPath, req, res)),
      }),
      `irisApp: GET ${sandboxPath}`,
    )

    /*
     * The shell page's own Content-Security-Policy, written into the index the
     * fallback seat serves.
     *
     * Registered here rather than in the front-end row because this plugin is
     * the one that already holds `webDistIndex` — the same gate as the sandbox
     * route above, and for the same reason: with no build there is no index to
     * tap, and the carrier applies taps only through `renderIndex`, which only
     * the static seat calls. What goes in and why each directive earned its
     * place is `shell-csp.ts`; the short version is that a card interface is a
     * `srcdoc` frame, a `srcdoc` document **inherits the embedder's policy**,
     * and so every directive here is also a directive on every card.
     *
     * A refusal is warned once rather than per response: an index that already
     * carries a policy would otherwise print a line per page load, and the fact
     * does not change between two reads of the same file.
     */
    let policyRefusalSaid = false
    ctx.effect(
      () => ctx.webServer.tapIndex(html => {
        const stamped = stampShellIndex(html)
        if (stamped.refusal !== undefined && !policyRefusalSaid) {
          policyRefusalSaid = true
          ctx.logger.warn(`irisApp: ${stamped.refusal}`)
        }
        return stamped.html
      }),
      'irisApp: shell Content-Security-Policy',
    )
  }

  /*
   * The browser face of installed system plugins: the aggregate manifest at
   * `/plugins/manifest.json` and each enabled plugin's client bundle at
   * `/plugins/<id>/client.js` (`plugin-assets.ts`, which is where the URL
   * contract, the install-directory layout and their reasons live).
   *
   * Registered unconditionally, unlike the sandbox route above, for two
   * reasons: it serves profile data rather than a build — the plugin install
   * directory exists whenever the host does — and `/plugins/manifest.json` is
   * a real answer in every state (the current enabled set, possibly empty),
   * where a sandbox route without a dist would have nothing but 404s to say.
   * Nothing in the built dist lives under `/plugins`, so the fallback seat
   * loses nothing it could ever have served.
   *
   * The prefix is fixed by the contract package rather than configured, the
   * same way the meta name is: the frame's plugin tags and this route must
   * spell one URL, and a contract with a per-deployment override is two
   * contracts.
   *
   * Guarded like every route above, and for the same reason: these bytes are
   * plugin code this process did not author, and the `/plugins` prefix is as
   * readable to a hostile same-origin page as the RPC endpoint is.
   */
  const pluginAssets = new PluginAssetStore(join(dataDir, 'system-plugins'))
  // Read per request, never captured: the manifest and the bundle gate must
  // answer the enable state as it is *now*, and a disable that committed
  // after this plugin started is a fact the next request already carries. The
  // triple is the same one the browser's `sandboxPluginRuntime` reduces on —
  // installed, enabled, and the transition complete — restated per row rather
  // than reduced to booleans, because the asset plane is per-plugin flat:
  // MVU's implicit dependency on Tavern Helper is a capability-plane rule and
  // has no business hiding one plugin's bundle behind another's state.
  const pluginAssetState = (): PluginAssetState => {
    const snapshot = systemPlugins.snapshot()
    return {
      revision: snapshot.revision,
      enabled: new Set(snapshot.plugins
        .filter(plugin => plugin.installed && plugin.enabled && plugin.status === 'enabled')
        .map(plugin => plugin.id)),
    }
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: PLUGIN_ASSET_PREFIX,
      handler: ctx.irisRpc.guard((req, res) => pluginAssets.serve(req, res, pluginAssetState)),
    }),
    `irisApp: GET ${PLUGIN_ASSET_PREFIX}`,
  )
}
