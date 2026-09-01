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
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
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
   * Largest the whole cache directory may grow, in bytes.
   *
   * This route is the first thing in the host a page on another origin can make
   * write to disk: the RPC endpoint refuses cross-site requests by requiring a
   * content type that forces a preflight, but a `GET` needs no preflight, so any
   * local page can ask this host to fetch and store a whitelisted URL. The bytes
   * are public CDN code and the host binds to loopback, so the exposure is a
   * disk-fill rather than a disclosure — but unbounded growth caused by someone
   * else's page is not a thing to leave unbounded.
   *
   * Over budget, fetching still works and serving still works; only new entries
   * stop being written, and the refusal is reported. Refusing to store is
   * strictly better than evicting: eviction would let a hostile page push out
   * the bundle a real card depends on.
   * @default 268435456 (256 MiB)
   */
  maxCacheBytes?: number
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

/**
 * What every response on this route carries so a module fetch can read it.
 *
 * **A module fetch is always a CORS fetch.** `import()` and
 * `<script type="module">` use request mode `cors` unconditionally — unlike a
 * classic script, which is `no-cors` — and the card's frame is opaque-origin, so
 * its requests arrive with `Origin: null` and are cross-origin to this host.
 * Without this header the browser has the bytes and refuses to hand them to the
 * module system, reporting only `Failed to fetch dynamically imported module`
 * against the outer blob URL rather than the dependency that was blocked.
 *
 * This is why fetching straight from jsDelivr worked: jsDelivr sends
 * `access-control-allow-origin: *`. Proxying moved the fetch to a host that sent
 * none.
 *
 * **`*`, not `null`.** `null` looks tighter and is not: *every* sandboxed frame
 * has origin `null`, so it names no one in particular while merely appearing to.
 *
 * **A response header is cache content.** This route answers with a long
 * `max-age`, so a wrong header does not end when the process restarts — it lives
 * in the browser's cache for the full TTL. That is not hypothetical: an early
 * version answered `200` with `max-age=604800` and **no** CORS header, Chrome
 * kept that response under its top-site partition, and every later frame import
 * hit the poisoned copy and failed its CORS check in silence. `curl` never sees
 * it, because `curl` has no browser cache — so the host looked healthy from
 * every angle the host can see itself from. It took a `fetch(url, {cache:
 * 'reload'})` from the shell to replace the entry.
 *
 * The rule that follows: **on a route with a long TTL, a header deployed wrong
 * outlives the deployment.** Widen the headers before shipping a cacheable
 * response, not after, and when one has already gone out, remember that the
 * evidence of the bad copy exists only inside the browser.
 *
 * This route deliberately diverges from the RPC endpoint, which sends no CORS
 * header at all and relies on that (see `rpc-host/src/http.ts`). The two are not
 * comparable: RPC methods change the user's data, while this serves public CDN
 * bytes that already carry `*` from their origin, so reading them here grants a
 * page nothing it could not get by fetching the CDN directly. Note also that a
 * CORS header governs whether a response may be **read**, never whether the
 * request happens — so it adds no ability to cause a fetch.
 *
 * **What it does not buy:** this exposes the *body* cross-origin, not the
 * headers. A custom response header stays invisible to a cross-origin reader
 * without `access-control-expose-headers`, so the frame still cannot read
 * `x-iris-reason` — and it is deliberately not exposed, because the reader of
 * that header is the shell, which is same-origin and needs no exemption. Anyone
 * concluding from "failures carry CORS too" that the frame can now fetch its own
 * reason would be wrong, and would be tempted to delete the shell's path for
 * doing it. `SANDBOX.md` carries the same warning; it is repeated here because
 * this is where someone editing the header is standing.
 */
const CORS_HEADER = { 'access-control-allow-origin': '*' } as const

/** Seven days. See {@link ScriptCacheOptions.ttlSeconds}. */
const DEFAULT_TTL_SECONDS = 604_800

/** Eight mebibytes. See {@link ScriptCacheOptions.maxBytes}. */
const DEFAULT_MAX_BYTES = 8_388_608

/** 256 mebibytes. See {@link ScriptCacheOptions.maxCacheBytes}. */
const DEFAULT_MAX_CACHE_BYTES = 268_435_456

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
  readonly #maxCacheBytes: number
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
    this.#maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES
    this.#onError = options.onError ?? (() => {})
  }

  /**
   * Serve one request.
   * @param req - the request; the upstream URL is its `url` query parameter.
   * @param res - the response.
   */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...CORS_HEADER, allow: 'GET, HEAD' })
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
      ...CORS_HEADER,
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
    } catch (error: unknown) {
      // Refetching is the right action for all three of absent, half-written and
      // unreadable — but they are not the same event, and merging them into one
      // silent return hides the third. A cache directory this host cannot read
      // fetches everything from upstream on every request, forever, which is
      // exactly the cost this module was built to remove and looks from outside
      // like the cache simply not working.
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.#onError(new Error(
          `could not read the cached copy of ${url} (${error instanceof Error ? error.message : String(error)});`
          + ' refetching, and this will repeat until the cache directory is readable',
        ))
      }
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
        // "could not reach" would assert a fact about the network, and this
        // catch is not homogeneous: a `fetch` that throws is usually the far
        // side being unreachable, but a fault in `nodeFetch` — the one part of
        // this module a test with an injected upstream never runs — throws here
        // too and would arrive wearing the network's clothes. Somebody chasing
        // an upstream outage would never look at our adapter.
        //
        // So the message says what happened rather than why, and names both
        // readings. Guessing between them from the error's shape would be a
        // heuristic that is wrong silently, which is the thing being avoided.
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        const reason = `fetching ${target} threw (${detail}) — either the far side is unreachable`
          + ' or the host’s own fetch adapter faulted; the adapter is nodeFetch in script-cache.ts'
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
      if (await this.#overBudget(body.byteLength)) {
        this.#onError(new Error(
          `not caching ${url}: the bundle cache is at its ${String(this.#maxCacheBytes)} byte budget`,
        ))
        return
      }
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

  /**
   * Whether storing one more body would exceed the directory's budget.
   * @param incoming - the body's size.
   * @returns whether to skip the write.
   */
  async #overBudget(incoming: number): Promise<boolean> {
    let total = incoming
    try {
      for (const name of await readdir(this.#dir)) {
        total += (await stat(join(this.#dir, name))).size
        if (total > this.#maxCacheBytes) return true
      }
    } catch {
      // An unreadable directory is not a reason to refuse the write; the write
      // itself will report if it also fails.
      return false
    }
    return false
  }

  /** Answer with the reason, in the body and in a header. */
  #fail(res: ServerResponse, failure: CacheFailure): void {
    const body = Buffer.from(`${failure.reason}\n`, 'utf8')
    res.writeHead(failure.status, {
      // On failures too. A route whose CORS behaviour depends on the outcome is
      // a route where "what does failure look like" depends on who is asking,
      // and the reasons carry nothing private — the URL in them came from the
      // caller.
      ...CORS_HEADER,
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
