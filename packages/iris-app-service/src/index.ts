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

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatCompletionPreset } from '@iris/preset'

import { ChatStore } from './chats.ts'
import { CharacterLibrary } from './library.ts'
import { DEFAULT_PRESET } from './prompt.ts'
import { IrisAppService } from './service.ts'
import { ScriptPolicyStore } from './scripts.ts'
import { SettingsStore } from './settings.ts'

export { ChatStore, formatCreateDate, seedGreeting } from './chats.ts'
export { ChatEntry, lineTurns, metadataBackend, readMeta, type IrisChatMeta } from './entry.ts'
export { AppError, busy, invalid, notFound } from './errors.ts'
export { CharacterLibrary, type CardFileRef } from './library.ts'
export { fileFor, isSafeId, toId, uniqueId } from './paths.ts'
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
export { SettingsStore, sanitize, type SettingsPatch } from './settings.ts'
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
}

/** Runtime schema for the application row. */
export const Config: z<Config> = z.object({
  dataDir: z.string().default('./data'),
  provider: z.string().default('default'),
  model: z.string().default('local-model'),
  userName: z.string().default('User'),
  contextWindow: z.natural().default(32_768),
  reserveTokens: z.natural().default(1024),
  templateOverhead: z.natural().default(0),
  presetPath: z.string(),
  avatarPath: z.string().default('/iris/avatar'),
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
 * Mount the application.
 * @param ctx - context carrying `irisRpc`, `llm` and `webServer`.
 * @param config - data folder, model route and budget.
 * @returns nothing; the registrations are owned by the fiber's effects.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = rootOf(ctx)
  const dataDir = resolve(root, config.dataDir ?? './data')
  const avatarPath = config.avatarPath ?? '/iris/avatar'

  const library = new CharacterLibrary(join(dataDir, 'characters'), avatarPath)
  const chats = new ChatStore(join(dataDir, 'chats'), library)
  const settings = new SettingsStore(join(dataDir, 'settings.json'), {
    provider: config.provider ?? 'default',
    model: config.model ?? 'local-model',
  })
  // Its own file, not a section of `settings.json`: sampling is a preference and
  // this is a permission record. Keeping them apart means a settings reset
  // cannot hand a card the page document.
  const scripts = new ScriptPolicyStore(join(dataDir, 'script-policy.json'))

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
    preset: await loadPreset(config.presetPath),
    broadcast: event => { ctx.irisRpc.broadcast(event) },
    ...config.userName === undefined ? {} : { userName: config.userName },
    ...config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow },
    ...config.reserveTokens === undefined ? {} : { reserveTokens: config.reserveTokens },
    ...config.templateOverhead === undefined ? {} : { templateOverhead: config.templateOverhead },
    onError: error => { ctx.logger.warn(error) },
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
      ctx.irisRpc.register('character.list', handlers['character.list']),
      ctx.irisRpc.register('character.import', handlers['character.import']),
      ctx.irisRpc.register('character.delete', handlers['character.delete']),
      ctx.irisRpc.register('settings.get', handlers['settings.get']),
      ctx.irisRpc.register('settings.set', handlers['settings.set']),
      ctx.irisRpc.register('script.list', handlers['script.list']),
      ctx.irisRpc.register('script.setEnabled', handlers['script.setEnabled']),
      ctx.irisRpc.register('script.setDocumentGrant', handlers['script.setDocumentGrant']),
      ctx.irisRpc.register('script.fetch', handlers['script.fetch']),
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
