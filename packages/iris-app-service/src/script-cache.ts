/**
 * Fetching a card's remote script bundles through the host, once.
 *
 * The problem is not bandwidth, it is **cache partitioning**. A card script's
 * `import()` runs inside an opaque-origin frame, so the browser's HTTP cache
 * gives it its own partition and every chat open is a cold fetch. Measured in
 * production: MVU's bundle is 307,765 B and takes 9–12 s from jsDelivr, against
 * a 15 s import ceiling — four of six chat opens timed out. Upstream does not
 * have this problem because its frames are same-origin and share the page's warm
 * cache; ours cannot be, for the reasons in `SANDBOX.md`.
 *
 * So the host fetches it once and serves it from disk afterwards. The route is
 * same-origin with the frame's existing `script-src`, so no CSP changes.
 *
 * **The URL arriving here is a proposal from the untrusted side.** It is checked
 * with `checkScriptFetch` — the same function `script.fetch` uses, not a second
 * copy of the rule — and so is every redirect target, because a whitelist that
 * stops at the first hop only checks where a request was aimed, not where it
 * lands.
 *
 * @module @iris/app-service/script-cache
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkScriptFetch } from '@iris/script'

/** How a fetch through this route can fail, in the words the browser is given. */
export type CacheFailure =
  | { status: 400, reason: string }
  | { status: 403, reason: string }
  | { status: 413, reason: string }
  | { status: 502, reason: string }

/** The minimal fetch surface this needs, so tests can supply an upstream. */
export interface FetchLike {
  (url: string, init: { redirect: 'manual', headers: Record<string, string> }): Promise<{
    status: number
    headers: { get: (name: string) => string | null }
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
}

/** Host-side tuning. */
export interface ScriptCacheOptions {
  /** Where cached bodies live. Under `data/`, which is gitignored. */
  dir: string
  /** Fetches upstream. Defaults to global `fetch`. */
  fetchRemote?: FetchLike
  /**
   * How long a cached body is served without asking upstream again.
   *
   * One TTL for everything, deliberately. A version-pinned URL — jsDelivr's
   * `@1.2.3`, a raw.githubusercontent commit — never changes content, so the TTL
   * costs nothing there; a moving tag like `@beta` refreshes at most once per
   * window. The alternative is a heuristic that decides which URLs are pinned,
   * and that heuristic is wrong silently: a branch name that looks like a tag
   * would be cached forever with no way to notice.
   * @default 604800 (7 days)
   */
  ttlSeconds?: number
  /**
   * Largest body accepted, in bytes.
   *
   * Enforced while reading rather than by trusting `content-length`, which the
   * far side controls. The corpus's largest bundle is 307,765 B.
   * @default 8388608 (8 MiB)
   */
  maxBytes?: number
  /** Reports a fetch that failed, for the host's log. */
  onError?: (error: Error) => void
}

/**
 * The default upstream: Node's own `fetch`, narrowed to what this needs.
 *
 * Exported so it can be tested. It is the **only** part of this module that a
 * test with an injected upstream never exercises, and it is the part that runs
 * in production — a mismatch between what `FetchLike` promises and what undici
 * does would show up nowhere else. Two assumptions in particular are somebody
 * else's runtime rather than this code's: that `redirect: 'manual'` yields the
 * real 3xx with a readable `location` (a browser would hand back an opaque
 * response instead), and that `credentials: 'omit'` is accepted at all.
 * @param url - the URL to fetch.
 * @param init - redirect policy and headers.
 * @returns the response, narrowed to status, headers and bytes.
 */
export const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    redirect: init.redirect,
    headers: init.headers,
    // Nothing of the user's identity crosses. A card's dependency is public code
    // from a public CDN; sending credentials would make the host a confused
    // deputy for whatever the URL points at.
    credentials: 'omit',
  })
  return {
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    arrayBuffer: () => response.arrayBuffer(),
  }
}

/** Redirect hops followed before giving up. jsDelivr uses one. */
const MAX_HOPS = 5

/**
 * How long a failure is remembered, in milliseconds.
 *
 * Short on purpose. It exists so that **reading why something failed does not
 * cost what failing cost**: a failed `import()` hands its caller no response, so
 * the reason is read by asking this route again from the shell — and without
 * this window, diagnosing a 502 would repeat the whole unreachable-upstream
 * attempt, which is the 9–12 s this module was built to stop paying.
 *
 * Thirty seconds covers a follow-up that happens immediately and expires long
 * before a person retries by hand, so a CDN that comes back is not locked out.
 */
const FAILURE_MEMORY_MS = 30_000

/** Seven days. See {@link ScriptCacheOptions.ttlSeconds}. */
const DEFAULT_TTL_SECONDS = 604_800

/** Eight mebibytes. See {@link ScriptCacheOptions.maxBytes}. */
const DEFAULT_MAX_BYTES = 8_388_608

/**
 * The cache file name for one URL.
 *
 * Hashed rather than derived from the URL's path: a name built from
 * browser-supplied text is a path-traversal question every time it is read, and
 * a hash has no such question to answer. The URL itself is kept in the sidecar
 * so a cache directory is still explicable to whoever opens it.
 * @param url - the upstream URL.
 * @returns the base name, without extension.
 */
export function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** What the sidecar records about one cached body. */
interface CacheMeta {
  url: string
  fetchedAt: number
  bytes: number
}

/** Fetches remote script bundles once and serves them from disk. */
export class ScriptCache {
  readonly #dir: string
  readonly #fetch: FetchLike
  readonly #ttlMs: number
  readonly #maxBytes: number
  readonly #onError: (error: Error) => void
  /** In-flight fetches, so ten frames opening at once cause one request. */
  readonly #inflight = new Map<string, Promise<Buffer | CacheFailure>>()
  /** Recent failures, so asking why costs less than failing did. */
  readonly #failures = new Map<string, { failure: CacheFailure, at: number }>()

  /**
   * @param options - where to cache, how to fetch, and the limits.
   */
  constructor(options: ScriptCacheOptions) {
    this.#dir = options.dir
    this.#fetch = options.fetchRemote ?? nodeFetch
    this.#ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.#onError = options.onError ?? (() => {})
  }

  /**
   * Serve one request.
   * @param req - the request; the upstream URL is its `url` query parameter.
   * @param res - the response.
   */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const requested = new URL(req.url ?? '/', 'http://iris.invalid').searchParams.get('url')
    if (requested === null || requested === '') {
      this.#fail(res, { status: 400, reason: 'this route needs a ?url= parameter naming the module to fetch' })
      return
    }

    const body = await this.load(requested)
    if (!Buffer.isBuffer(body)) {
      this.#fail(res, body)
      return
    }

    res.writeHead(200, {
      // Always JavaScript. The far side's own content-type is not echoed: this
      // route exists to be imported as a module, and letting upstream choose the
      // type would let it choose what the browser does with the bytes.
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': body.byteLength,
      // The body is keyed by the full URL and a pinned URL never changes, so the
      // browser may hold it as long as the host does.
      'cache-control': `public, max-age=${String(Math.floor(this.#ttlMs / 1000))}`,
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * The body for one URL, from disk when it is there.
   * @param requested - the URL the browser proposed.
   * @returns the bytes, or why they could not be had.
   */
  async load(requested: string): Promise<Buffer | CacheFailure> {
    const verdict = checkScriptFetch(requested)
    if (!verdict.allowed) return { status: 403, reason: verdict.reason }
    const url = verdict.url

    const cached = await this.#readCached(url)
    if (cached !== undefined) return cached

    // A failure the shell is coming back to read. It has to be answered from
    // memory: the browser gives a failed `import()` no response to inspect, so
    // the only way to learn the reason is a second request, and re-running an
    // unreachable fetch to produce an error message costs exactly what the error
    // cost in the first place.
    const remembered = this.#failures.get(url)
    if (remembered !== undefined) {
      if (Date.now() - remembered.at < FAILURE_MEMORY_MS) return remembered.failure
      this.#failures.delete(url)
    }

    // One request per URL even when several frames open together: without this
    // the first chat open after a restart fetches the same 300 KB bundle once
    // per script that imports it.
    const existing = this.#inflight.get(url)
    if (existing !== undefined) return existing

    const work = this.#fetchAndStore(url).then((result) => {
      if (!Buffer.isBuffer(result)) this.#failures.set(url, { failure: result, at: Date.now() })
      return result
    }).finally(() => { this.#inflight.delete(url) })
    this.#inflight.set(url, work)
    return work
  }

  /** The cached body, when one is present and still inside its window. */
  async #readCached(url: string): Promise<Buffer | undefined> {
    const base = join(this.#dir, cacheKey(url))
    try {
      const meta = JSON.parse(await readFile(`${base}.json`, 'utf8')) as CacheMeta
      // `>=`, not `>`: a TTL of zero has to mean "never fresh", and with `>` an
      // entry written and read inside the same millisecond is served from a
      // window of length zero. The difference is one millisecond at seven days
      // and the whole meaning at zero — and it showed up as a test that passed
      // most of the time, which is worse than one that fails.
      if (Date.now() - meta.fetchedAt >= this.#ttlMs) return undefined
      const body = await readFile(`${base}.js`)
      await stat(`${base}.js`)
      return body
    } catch {
      // Absent, unreadable, or half-written. Fetching again is always safe.
      return undefined
    }
  }

  /** Fetch, following only redirects the whitelist also allows, then store. */
  async #fetchAndStore(url: string): Promise<Buffer | CacheFailure> {
    let target = url
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      let response: Awaited<ReturnType<FetchLike>>
      try {
        response = await this.#fetch(target, { redirect: 'manual', headers: { accept: '*/*' } })
      } catch (error: unknown) {
        const reason = `could not reach ${target}: ${error instanceof Error ? error.message : String(error)}`
        this.#onError(new Error(reason))
        return { status: 502, reason }
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) return { status: 502, reason: `${target} redirected without a location` }
        const next = new URL(location, target).toString()
        // The hop is checked like the first request was. A whitelist that only
        // sees where a request was aimed does not know where it landed, and the
        // far side chooses the landing.
        const allowed = checkScriptFetch(next)
        if (!allowed.allowed) {
          const reason = `${target} redirected to a host that is not allowed: ${allowed.reason}`
          this.#onError(new Error(reason))
          return { status: 403, reason }
        }
        target = allowed.url
        continue
      }

      if (response.status !== 200) {
        const reason = `${target} answered ${String(response.status)}`
        this.#onError(new Error(reason))
        return { status: 502, reason }
      }

      const body = Buffer.from(await response.arrayBuffer())
      if (body.byteLength > this.#maxBytes) {
        const reason = `${target} is ${String(body.byteLength)} bytes, over the ${String(this.#maxBytes)} byte limit`
        this.#onError(new Error(reason))
        return { status: 413, reason }
      }

      await this.#store(url, body)
      return body
    }

    const reason = `${url} redirected more than ${String(MAX_HOPS)} times`
    this.#onError(new Error(reason))
    return { status: 502, reason }
  }

  /** Write the body and its sidecar. */
  async #store(url: string, body: Buffer): Promise<void> {
    const base = join(this.#dir, cacheKey(url))
    try {
      await mkdir(this.#dir, { recursive: true })
      // Body first, sidecar second: a reader requires the sidecar, so a crash
      // between the two leaves a body nobody will serve rather than a sidecar
      // pointing at bytes that are not there.
      await writeFile(`${base}.js`, body)
      const meta: CacheMeta = { url, fetchedAt: Date.now(), bytes: body.byteLength }
      await writeFile(`${base}.json`, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    } catch (error: unknown) {
      // A cache that cannot write still serves what it fetched. Reported, so a
      // permanently unwritable directory is not a silent per-open refetch.
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Answer with the reason, in the body and in a header. */
  #fail(res: ServerResponse, failure: CacheFailure): void {
    const body = Buffer.from(`${failure.reason}\n`, 'utf8')
    res.writeHead(failure.status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': body.byteLength,
      // Readable without consuming the body, which a failed `import()` never
      // gives its caller. The diagnosis chain reads this.
      'x-iris-reason': encodeURIComponent(failure.reason),
      'cache-control': 'no-store',
    })
    res.end(body)
  }
}
