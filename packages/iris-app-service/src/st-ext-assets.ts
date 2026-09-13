/**
 * The `/iris-st-ext` route: the ST-compat pilot's browser payload.
 *
 * One URL root carries everything an extension frame loads, all under one
 * revision segment `<extensionId>/<rev>` (rev = twelve hex of the installed
 * lock's artifact hash, the plugin route's rev discipline):
 *
 * - `scripts/extensions/third-party/<dir>/…` — **real files**, straight from
 *   the installer's `installed/<id>/content/` tree. Upstream bytes, upstream
 *   layout; the route never rewrites them.
 * - `script.js`, `scripts/events.js`, `chunks/…` — **facades**, from the web
 *   build's `st-ext/facades` directory. The facade for an ST module path sits
 *   exactly where that module's relative import resolves to, which is what
 *   lets the unmodified bundle import Iris instead of SillyTavern.
 * - `vendor/…` — jQuery and lodash, served from the web build's
 *   `st-ext/vendor`, so the frame's globals come from one mount.
 * - `manifest.json` (no rev segment) — the composed manifest the plane mounts
 *   its frame from: dir name, entry, rev, display name.
 *
 * A disabled (or absent) extension answers 404 on every path, manifest
 * included: the asset plane's own half of the stale-frame refusal, next to
 * the RPC face's revision check.
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'

import { normalizeManifest } from '@iris/compat-st-extension'

export const ST_EXT_PREFIX = '/iris-st-ext'
export const ST_EXT_FACADE_DIR = 'st-ext/facades'
export const ST_EXT_VENDOR_DIR = 'st-ext/vendor'

const UPSTREAM_TREE = 'scripts/extensions/third-party/'

const SHARED_HEADERS = {
  'access-control-allow-origin': '*',
  'timing-allow-origin': '*',
  vary: 'Origin',
} as const

const IMMUTABLE = 'public, max-age=31536000, immutable'

/** What the route needs to know per request, read fresh from the runtime. */
export interface StExtStateView {
  /** The extension ids enabled right now. */
  enabled: Set<string>
}

export class StExtensionAssetStore {
  readonly #root: string
  readonly #webDistDir: string
  readonly #facadeFiles: ReadonlyMap<string, string>

  /**
   * @param root - the installer layout root (`<profile>/st-extensions`); files
   *   are served from `installed/<id>/content/…` under it.
   * @param webDistDir - the built web app's directory (the one holding
   *   `index.html`); facades and vendor assets are read from `st-ext/` under it.
   * @param facadeFiles - the built facade entries by their URL path
   *   (`script.js` → absolute file), so a facade's presence is declared
   *   instead of guessed from a directory scan.
   */
  constructor(root: string, webDistDir: string, facadeFiles: ReadonlyMap<string, string>) {
    this.#root = root
    this.#webDistDir = webDistDir
    this.#facadeFiles = facadeFiles
  }

  #installedDir(extensionId: string): string {
    return join(this.#root, 'installed', extensionId)
  }

  #safeId(id: string): boolean {
    return id.length >= 1 && id.length <= 200 && id !== '.' && id !== '..'
      && !/[/\\\u0000-\u001f]/u.test(id)
  }

  /** The rev for an installed extension: twelve hex from its lock's artifact hash. */
  async #rev(extensionId: string): Promise<string | undefined> {
    try {
      const lock = JSON.parse(await readFile(join(this.#installedDir(extensionId), 'lock.json'), 'utf8')) as { artifactSha256?: unknown }
      if (typeof lock.artifactSha256 !== 'string' || lock.artifactSha256.length < 12) return undefined
      return lock.artifactSha256.slice(0, 12)
    } catch {
      return undefined
    }
  }

  /** The composed manifest the plane mounts its frame from. */
  async manifest(extensionId: string): Promise<Record<string, unknown> | undefined> {
    const dir = this.#installedDir(extensionId)
    const rev = await this.#rev(extensionId)
    if (rev === undefined) return undefined
    try {
      const raw = JSON.parse(await readFile(join(dir, 'content', 'manifest.json'), 'utf8')) as unknown
      const parsed = normalizeManifest(raw)
      if (!parsed.ok) return undefined
      return {
        id: extensionId,
        rev,
        displayName: parsed.manifest.displayName,
        version: parsed.manifest.version,
        dirName: dirNameOf(extensionId, raw),
        entry: parsed.manifest.js,
      }
    } catch {
      return undefined
    }
  }

  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    view: () => StExtStateView,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SHARED_HEADERS, allow: 'GET, HEAD' })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://iris.invalid')
    const pathname = url.pathname
    if (!pathname.startsWith(`${ST_EXT_PREFIX}/`)) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    let rest: string
    try {
      rest = decodeURIComponent(pathname.slice(ST_EXT_PREFIX.length + 1))
    } catch {
      res.writeHead(400, SHARED_HEADERS)
      res.end()
      return
    }

    // The enable gate, before anything is read: a disabled extension's whole
    // tree goes dark, manifest first. This is what makes "disable" true even
    // for a frame that cached its URLs.
    const state = view()
    if (!state.enabled.has(rest.split('/')[0] ?? '')) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    const id = rest.split('/')[0] ?? ''
    if (!this.#safeId(id)) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    if (rest === `${id}/manifest.json`) {
      const manifest = await this.manifest(id)
      const body = JSON.stringify(manifest ?? { error: 'not installed' })
      res.writeHead(200, {
        ...SHARED_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-cache',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }

    const segments = rest.split('/')
    const askedRev = segments[1] ?? ''
    const rev = await this.#rev(id)
    if (rev === undefined || askedRev !== rev) {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }
    const subPath = segments.slice(2).join('/')

    let file: string | undefined
    let immutable = true
    if (subPath.startsWith(UPSTREAM_TREE)) {
      // Real upstream bytes. The path under `third-party/` is the extension's
      // own tree, containment-checked against the installed content root.
      const rel = subPath.slice(UPSTREAM_TREE.length)
      if (rel === '' || rel.includes('..')) {
        res.writeHead(404, SHARED_HEADERS)
        res.end()
        return
      }
      const contentRoot = resolve(join(this.#installedDir(id), 'content'))
      file = resolve(join(contentRoot, rel))
      if (!file.startsWith(contentRoot + sep)) {
        res.writeHead(403, SHARED_HEADERS)
        res.end()
        return
      }
    } else if (subPath.startsWith('vendor/')) {
      const vendorRoot = resolve(join(this.#webDistDir, ST_EXT_VENDOR_DIR))
      file = resolve(vendorRoot, subPath.slice('vendor/'.length))
      if (!file.startsWith(vendorRoot + sep)) {
        res.writeHead(403, SHARED_HEADERS)
        res.end()
        return
      }
    } else if (this.#facadeFiles.has(subPath)) {
      file = this.#facadeFiles.get(subPath)
    } else if (subPath.startsWith('chunks/') && !subPath.includes('..')) {
      const chunkRoot = resolve(join(this.#webDistDir, ST_EXT_FACADE_DIR))
      file = resolve(chunkRoot, subPath)
      if (!file.startsWith(chunkRoot + sep)) {
        res.writeHead(403, SHARED_HEADERS)
        res.end()
        return
      }
    } else {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    let body: Buffer
    try {
      const info = await stat(file!)
      if (!info.isFile()) throw new Error('not a file')
      body = await readFile(file!)
    } catch {
      res.writeHead(404, SHARED_HEADERS)
      res.end()
      return
    }

    res.writeHead(200, {
      ...SHARED_HEADERS,
      'content-type': contentTypeFor(file!),
      'content-length': body.byteLength,
      // Everything under the revision segment is content-pinned by the rev in
      // the URL: an address that named the current bytes may be held for a
      // year, and a stale rev 404s above instead of serving old bytes.
      'cache-control': immutable ? IMMUTABLE : 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

function dirNameOf(fallbackId: string, raw: unknown): string {
  // The pilot's install layout keeps the upstream directory name; derive it
  // from the manifest's display name, which the upstream build fixed as the
  // repo name, and fall back to the installer id.
  const slug = typeof raw === 'object' && raw !== null
    && typeof (raw as { display_name?: unknown }).display_name === 'string'
    ? (raw as { display_name: string }).display_name
    : fallbackId
  return slug.replace(/[^A-Za-z0-9_-]/gu, '') || fallbackId
}

function contentTypeFor(file: string): string {
  const lower = file.toLowerCase()
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.ttf')) return 'font/ttf'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}
