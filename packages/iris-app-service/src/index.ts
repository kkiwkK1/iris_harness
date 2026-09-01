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

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatCompletionPreset } from '@iris/preset'

import { ChatStore } from './chats.ts'
import { CharacterLibrary } from './library.ts'
import { DEFAULT_PRESET } from './prompt.ts'
import { IrisAppService } from './service.ts'
import { ConnectionStore } from './connections.ts'
import { ExtensionSettingsStore } from './context.ts'
import { DEFAULT_PROFILE, profilePaths } from './paths.ts'
import { ScriptPolicyStore } from './scripts.ts'
import { ScriptVariableStore } from './script-variables.ts'
import { SettingsStore } from './settings.ts'

export { ChatStore, formatCreateDate, seedGreeting } from './chats.ts'
export { ConnectionStore, summarize, type ProfileInput } from './connections.ts'
export {
  assertStorable,
  buildCardContext,
  commitChatMetadata,
  ExtensionSettingsStore,
  type ScriptContext,
} from './context.ts'
export { ChatEntry, lineTurns, metadataBackend, readMeta, type IrisChatMeta } from './entry.ts'
export { AppError, busy, invalid, notFound } from './errors.ts'
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
  applyCardOverrides,
  buildPrompt,
  DEFAULT_PRESET,
  scanEntriesOf,
  type PromptInput,
  type PromptResult,
} from './prompt.ts'
export { placementFor, runScripts, scriptsOf, substituteFor } from './regex.ts'
export { IrisAppService, samplingOf, type AppServiceOptions, type Handlers } from './service.ts'
export { ScriptPolicyStore } from './scripts.ts'
export { ScriptVariableStore, scriptIdOf } from './script-variables.ts'
export { SettingsStore, sanitize, type SettingsPatch } from './settings.ts'
export { applyOps, buildSnapshot, scalarsOf, worldInfoOf, writePath } from './template.ts'
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
  /** A SillyTavern Chat Completion preset to assemble with. Absent uses a thin built-in. */
  presetPath?: string
  /** Pathname prefix the card avatars are served at. @default '/iris/avatar' */
  avatarPath?: string
  /**
   * Run the cards' EJS prompt templates (the ST-Prompt-Template extension).
   *
   * Off by default, and the default is the honest one: evaluating a template is
   * running the card author's JavaScript. It runs in a child process with no
   * environment, no filesystem writes and no host objects in reach, but that is
   * a containment argument, not a reason to opt a user in for them.
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
}

/** Runtime schema for the application row. */
export const Config: z<Config> = z.object({
  dataDir: z.string().default('./data'),
  profile: z.string().default(DEFAULT_PROFILE),
  provider: z.string().default('default'),
  model: z.string().default('local-model'),
  userName: z.string().default('User'),
  contextWindow: z.natural().default(32_768),
  reserveTokens: z.natural().default(1024),
  templateOverhead: z.natural().default(0),
  presetPath: z.string(),
  avatarPath: z.string().default('/iris/avatar'),
  templates: z.boolean().default(false),
  templateDeadlineMs: z.natural().default(2000),
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
    'content-type': file.extension === '.png' ? 'image/png' : 'application/json; charset=utf-8',
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

  // Every path comes from one derivation, so a profile is one segment rather
  // than a change in five places — and so a store added later cannot be the one
  // that forgot to be profile-scoped.
  const paths = profilePaths(dataDir, config.profile ?? DEFAULT_PROFILE)
  warnOnPreProfileLayout(ctx, dataDir, paths.root)

  const library = new CharacterLibrary(paths.characters, avatarPath)
  const scriptVariables = new ScriptVariableStore(paths.scriptVariables,
    error => { ctx.logger.warn(error instanceof Error ? error.message : String(error)) })
  const chats = new ChatStore(paths.chats, library, scriptVariables)
  const settings = new SettingsStore(paths.settings, {
    provider: config.provider ?? 'default',
    model: config.model ?? 'local-model',
  })
  // Its own file, not a section of `settings.json`: sampling is a preference and
  // this is a permission record. Keeping them apart means a settings reset
  // cannot hand a card the page document.
  const scripts = new ScriptPolicyStore(paths.scriptPolicy)
  // Kept apart from `script-policy.json` because they answer to different
  // owners: the policy file is the user's decisions, this is data cards wrote.
  const extensionSettings = new ExtensionSettingsStore(paths.extensionSettings)
  const connections = new ConnectionStore(paths.connections)

  // The folders are created on first write, not on boot: a host that has never
  // been used should leave nothing behind, and both stores already tolerate a
  // directory that does not exist yet.
  await settings.load()

  const service = new IrisAppService({
    stream: options => ctx.llm.stream(options),
    library,
    chats,
    settings,
    scripts,
    extensionSettings,
    connections,
    scriptVariables,
    preset: await loadPreset(config.presetPath),
    broadcast: event => { ctx.irisRpc.broadcast(event) },
    ...config.userName === undefined ? {} : { userName: config.userName },
    ...config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow },
    ...config.reserveTokens === undefined ? {} : { reserveTokens: config.reserveTokens },
    ...config.templateOverhead === undefined ? {} : { templateOverhead: config.templateOverhead },
    // `templates: false` must produce no key at all: in the service, presence is
    // the switch, and a `{}` here would silently turn the feature on.
    ...config.templates !== true
      ? {}
      : { templates: config.templateDeadlineMs === undefined ? {} : { deadlineMs: config.templateDeadlineMs } },
    // The message, not the Error, so the log line carries the text a reader
    // needs regardless of how any exporter renders objects.
    onError: error => { ctx.logger.warn(error instanceof Error ? error.message : String(error)) },
  })

  const handlers = service.handlers()

  // Registered one by one rather than by iterating the table: `register` is
  // generic per method, and a loop would need a cast that throws away exactly
  // the check worth having here.
  ctx.effect(() => {
    const disposers = [
      ctx.irisRpc.register('chat.list', handlers['chat.list']),
      ctx.irisRpc.register('chat.create', handlers['chat.create']),
      ctx.irisRpc.register('chat.open', handlers['chat.open']),
      ctx.irisRpc.register('chat.delete', handlers['chat.delete']),
      ctx.irisRpc.register('chat.rename', handlers['chat.rename']),
      ctx.irisRpc.register('chat.send', handlers['chat.send']),
      ctx.irisRpc.register('chat.regenerate', handlers['chat.regenerate']),
      ctx.irisRpc.register('chat.abort', handlers['chat.abort']),
      ctx.irisRpc.register('chat.swipe', handlers['chat.swipe']),
      ctx.irisRpc.register('chat.editMessage', handlers['chat.editMessage']),
      ctx.irisRpc.register('chat.deleteMessage', handlers['chat.deleteMessage']),
      ctx.irisRpc.register('chat.branch', handlers['chat.branch']),
      ctx.irisRpc.register('prompt.itemize', handlers['prompt.itemize']),
      ctx.irisRpc.register('script.getVariables', handlers['script.getVariables']),
      ctx.irisRpc.register('script.setVariables', handlers['script.setVariables']),
      ctx.irisRpc.register('script.swipeTo', handlers['script.swipeTo']),
      ctx.irisRpc.register('script.slash', handlers['script.slash']),
      ctx.irisRpc.register('connection.list', handlers['connection.list']),
      ctx.irisRpc.register('connection.save', handlers['connection.save']),
      ctx.irisRpc.register('connection.delete', handlers['connection.delete']),
      ctx.irisRpc.register('connection.activate', handlers['connection.activate']),
      ctx.irisRpc.register('character.list', handlers['character.list']),
      ctx.irisRpc.register('character.import', handlers['character.import']),
      ctx.irisRpc.register('character.delete', handlers['character.delete']),
      ctx.irisRpc.register('settings.get', handlers['settings.get']),
      ctx.irisRpc.register('settings.set', handlers['settings.set']),
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
      ctx.irisRpc.register('script.setExtensionSettings', handlers['script.setExtensionSettings']),
      ctx.irisRpc.register('script.generateRaw', handlers['script.generateRaw']),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'irisApp.handlers')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: avatarPath,
      handler: (req, res) => serveAvatar(library, avatarPath, req, res),
    }),
    `irisApp: GET ${avatarPath}`,
  )
}
