/**
 * Serving the browser face of installed system plugins.
 *
 * The control plane (`system-plugins.ts`) owns what a plugin **is**; this
 * module owns where its **bytes** answer HTTP. Two URL shapes, both under the
 * `/plugins` prefix whose literal lives in `@iris/plugin-web-api` so the
 * frame-side tags (the member-merge landing) cannot spell it differently:
 *
 * - `/plugins/manifest.json` — the aggregate manifest: every **enabled**
 *   plugin that has a client bundle, with the content rev of each, at the
 *   runtime revision the enabled set was read at.
 * - `/plugins/<id>/client.js` (and its `.map`) — one plugin's client bundle,
 *   from the host-level install directory: `<dataDir>/system-plugins/<id>/
 *   client/client.js`.
 *
 * Why Iris owns this route rather than mounting dsh's `client-modules` service
 * (`@deepseek-ai/dsh-client-modules`), whose `/plugins` route, revved URLs
 * and manifest scan already exist: that service registers its route from its
 * own constructor and does not pass `irisRpc.guard`, while every route Iris
 * owns goes through the one guard — the rule stated above the route block in
 * `index.ts`, which buys the Host allow-list and `nosniff` on every answer.
 * It also scans the *composition's* loader entries, while Iris's catalog is a
 * control plane over an install directory; the scan target is different even
 * where the URL shape is the same. The rev shape — sha1, first 12 hex,
 * carried as the `?rev=` cache-busting query — is the one thing copied from
 * it, so bundles composed by either half interoperate.
 *
 * The header set and the cache failure direction are `sandbox-assets.ts`'s,
 * restated rather than imported: the card frame is an opaque origin, so every
 * asset it loads is cross-origin and `crossorigin` without the header is a
 * blocked load, not a weaker error; and a response may promise immutability
 * only when its address is content-derived — here the `?rev=` query is that
 * address, so an unrevved or stale-revved request revalidates. The manifest
 * itself is the one fixed path whose bytes change with every enable, disable
 * and install: it revalidates always, for the reason the sandbox manifest
 * does (`sandbox-assets.ts`, the "poisoned cache" note).
 *
 * @module @iris/app-service/plugin-assets
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { PLUGIN_ASSET_MANIFEST_PATH, PLUGIN_ASSET_PREFIX, type PluginAssetManifest } from '@iris/plugin-web-api'

/**
 * What every answer on this route carries. The same trio, for the same
 * reasons, as `sandbox-assets.ts` states its own: the allowance is a constant
 * `*` because an opaque-origin frame has no origin to echo; timing access is
 * the difference between "the request was sent" and "it finished"; and the
 * `vary` net costs nothing while the allowance stays constant and guards the
 * day it stops being one.
 */
const SHARED_HEADERS = {
  'access-control-allow-origin': '*',
  'timing-allow-origin': '*',
  vary: 'Origin',
} as const

/**
 * How long a revved bundle may be held: one year, the conventional cap, and
 * correct only because a `?rev=` that matches the current content hash makes
 * the URL content-addressed — a change of bytes is a change of address.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** The one fixed path this route serves; its name is the contract's, not ours. */
const MANIFEST_NAME = PLUGIN_ASSET_MANIFEST_PATH.slice(PLUGIN_ASSET_PREFIX.length + 1)

/** The bundle filename under `<install dir>/<id>/client/`. */
const CLIENT_BUNDLE = 'client.js'

/**
 * Whether a path segment may name a plugin directory.
 *
 * The catalog's own rule (`system-plugins.ts`: ids of 1 to 200 characters) plus
 * the two this route adds because the id becomes a path segment: no path
 * separators, and no control characters. dsh's registry keys bundles by package
 * name, slashes included; Iris's catalog ids have never needed one, and
 * admitting separators here would make `/plugins/<id>/client.js` a
 * multi-segment path whose id the install directory could not mirror without
 * the same traversal questions this check exists to close.
 */
function safePluginId(id: string): boolean {
  if (id.length === 0 || id.length > 200) return false
  if (id === '.' || id === '..') return false
  return !id.includes('/') && !id.includes('\\') && !/[\p{Cc}\p{Cf}]/u.test(id)
}

/** The enable state the manifest and the bundle gate read, at one revision. */
export interface PluginAssetState {
  /** The runtime revision this enabled set was read at. */
  revision: number
  /** Ids whose current incarnation is enabled and running. */
  enabled: ReadonlySet<string>
}

/** Read the state per request, so enable and disable answer immediately. */
export type PluginAssetStateView = () => PluginAssetState | undefined

/**
 * The install directory's browser half: revs, manifest and route in one place.
 *
 * The rev of a bundle is expensive to compute and stable while the file is
 * unchanged, so it is memoised against the file's own `(mtime, size)` — the
 * standard cache key for "bytes I already hashed" — and recomputed the moment
 * either moves. A same-size rewrite inside the stat clock's resolution is the
 * one blind spot; the failure is a stale `?rev=` holding the *new* bytes under
 * the *old* address, which revalidation (the default here) absorbs.
 */
export class PluginAssetStore {
  readonly #dir: string
  readonly #revs = new Map<string, { mtimeMs: number, size: number, rev: string }>()

  /** @param dir - the host-level plugin install directory (`<dataDir>/system-plugins`). */
  constructor(dir: string) {
    this.#dir = resolve(dir)
  }

  /** One plugin's client directory, resolved inside the install root. */
  #clientDir(id: string): string {
    return resolve(join(this.#dir, id, 'client'))
  }

  /**
   * The current content rev of one plugin's bundle.
   * @param id - the plugin id, already known safe.
   * @returns the 12-hex rev, or `undefined` when there is no readable bundle.
   */
  async #rev(id: string): Promise<string | undefined> {
    const file = join(this.#clientDir(id), CLIENT_BUNDLE)
    let info
    try {
      info = await stat(file)
    } catch {
      this.#revs.delete(id)
      return undefined
    }
    if (!info.isFile()) {
      this.#revs.delete(id)
      return undefined
    }
    const held = this.#revs.get(id)
    if (held !== undefined && held.mtimeMs === info.mtimeMs && held.size === info.size) return held.rev
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch {
      return undefined
    }
    const rev = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
    this.#revs.set(id, { mtimeMs: info.mtimeMs, size: info.size, rev })
    return rev
  }

  /**
   * Compose the aggregate manifest for one state of the runtime.
   *
   * Only enabled plugins with a bundle on disk get a row: the manifest is the
   * enable state made fetchable, not the install directory's index. Keys are
   * emitted sorted so the same state serialises to the same bytes — a cache
   * that revalidates this path deserves a stable answer for a stable world.
   * @param state - the enable state, or `undefined` when there is no runtime.
   * @returns the manifest to serve.
   */
  async manifest(state: PluginAssetState | undefined): Promise<PluginAssetManifest> {
    if (state === undefined) return { revision: 0, plugins: {} }
    const plugins: PluginAssetManifest['plugins'] = {}
    for (const id of [...state.enabled].sort()) {
      const rev = await this.#rev(id)
      if (rev === undefined) continue
      plugins[id] = { rev, client: `${PLUGIN_ASSET_PREFIX}/${id}/${CLIENT_BUNDLE}?rev=${rev}` }
    }
    return { revision: state.revision, plugins }
  }

  /**
   * Serve one request under the plugins prefix.
   * @param req - the request.
   * @param res - the response.
   * @param view - reads the current enable state; called per request so a
   *   disable that committed after the frame was built is refused here too.
   */
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    view: PluginAssetStateView,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SHARED_HEADERS, allow: 'GET, HEAD' })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://iris.invalid')
    const pathname = url.pathname
    // Checked, not assumed, for the reason `sandbox-assets.ts` gives at the
    // same spot: the URL parser collapses `..` before this code sees it, so a
    // climbing path arrives as something that simply no longer starts with
    // the prefix.
    if (!pathname.startsWith(`${PLUGIN_ASSET_PREFIX}/`)) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    let rest: string
    try {
      rest = decodeURIComponent(pathname.slice(PLUGIN_ASSET_PREFIX.length + 1))
    } catch {
      res.writeHead(400, SHARED_HEADERS)
      res.end()
      return
    }

    if (rest === MANIFEST_NAME) {
      const body = JSON.stringify(await this.manifest(view()))
      res.writeHead(200, {
        ...SHARED_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        // The one fixed path whose bytes change with every enable and disable;
        // holding it would rebuild exactly the poisoned-cache failure the
        // revving exists to prevent.
        'cache-control': 'no-cache',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    const forMap = rest.endsWith(`/${CLIENT_BUNDLE}.map`)
    const forBundle = !forMap && rest.endsWith(`/${CLIENT_BUNDLE}`)
    if (!forMap && !forBundle) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }
    const id = rest.slice(0, rest.length - (forMap ? `/${CLIENT_BUNDLE}.map`.length : `/${CLIENT_BUNDLE}`.length))
    // 404 rather than 400: a malformed id names no plugin, the same answer an
    // unknown one gets, and nothing about the request's *shape* was wrong.
    if (!safePluginId(id)) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    // The gate that makes the manifest and the bundle route agree: a disabled
    // plugin has no row in the manifest, so it has no URL either. A frame
    // built before the disable holds the old manifest, and the old address
    // must stop answering — the RPC face refuses stale incarnations
    // (`assertCurrent`), and this is the asset plane's own refusal.
    const state = view()
    if (state === undefined || !state.enabled.has(id)) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    const rev = await this.#rev(id)
    if (rev === undefined) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    const name = forMap ? `${CLIENT_BUNDLE}.map` : CLIENT_BUNDLE
    const file = resolve(join(this.#clientDir(id), name))
    // Belt and braces, the `sandbox-assets.ts` containment check: `safePluginId`
    // already refuses separators, so this cannot fire today — it stands guard
    // over the day that check is relaxed for some future id shape.
    if (file !== this.#dir && !file.startsWith(this.#dir + sep)) {
      res.writeHead(403, SHARED_HEADERS)
      res.end()
      return
    }

    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    // The rev query is the cache decision, read from the build's own
    // declaration rather than guessed from the filename's shape: an address
    // that names the current bytes may be held for a year, and any other
    // address — none, or a rev the content has moved past — revalidates. The
    // failure direction is the sandbox manifest's: nothing is immutable on
    // evidence that can be stale.
    const asked = url.searchParams.get('rev')
    res.writeHead(200, {
      ...SHARED_HEADERS,
      'content-type': forMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
      'content-length': body.byteLength,
      'cache-control': asked === rev ? IMMUTABLE : 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}
