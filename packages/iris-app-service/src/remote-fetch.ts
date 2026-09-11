/**
 * The one way this host fetches a URL a card proposed.
 *
 * Two places used to do this. `ScriptCache` followed redirects by hand, checked
 * every hop against `checkScriptFetch`, stopped at five hops and refused a body
 * over its limit; the `script.fetch` RPC handler checked the **first hop only**
 * and then handed the URL to a plain `fetch`, which follows redirects itself and
 * never looks at where it landed. So an allow-listed host answering `302
 * Location: https://evil.example/payload.js` had its allowance transferred to
 * `evil.example`, whose body came back to the card as text — and a card turns
 * text into a `blob:` URL and runs it, which the frame's `script-src` permits.
 * The body was also read with `response.text()` and no limit at all, so an
 * allow-listed host serving a large file was a host-memory question.
 *
 * Two executions of one rule is the defect, not either execution: the allowlist
 * is only as strong as its weakest evaluator, and nothing made the weak one
 * visible — both called `checkScriptFetch`, both looked right at their own call
 * site. This module is the single executor. `ScriptCache` fetches through it and
 * stores what comes back; `script.fetch` fetches through it and does not.
 *
 * What it guarantees, and what the callers therefore do not implement:
 *
 * - **Every hop is checked**, the first and each redirect, with the same
 *   `checkScriptFetch` — so the allowlist describes where bytes came *from*,
 *   not where a request was aimed.
 * - **Redirects are followed by this code**, `redirect: 'manual'`, never by the
 *   runtime. A followed redirect is a hop nobody checked.
 * - **The body is read in chunks against the cap** and the read is abandoned the
 *   moment it is exceeded. `content-length` is the far side's claim about itself
 *   and is not consulted; a cap enforced after `arrayBuffer()` has already
 *   bought the bytes it was meant to refuse.
 * - **`credentials: 'omit'`**, and it travels in the init the transport
 *   receives rather than being set inside the default adapter, so a test at the
 *   injection point can see it. A card's dependency is public code from a public
 *   CDN; sending the user's cookies would make the host a confused deputy.
 * - **Refusals name what was refused** — the hop number and the host for a
 *   redirect off the list, the hop count for a redirect loop, the cap and where
 *   reading stopped for an oversized body — and carry no part of the body.
 *
 * @module @iris/app-service/remote-fetch
 */

import { checkScriptFetch } from '@iris/script'

/**
 * What the transport is told, on every request this module makes.
 *
 * All three fields are fixed values rather than options: they are the policy,
 * and a caller able to vary them would be a second execution of the rule again.
 */
export interface RemoteFetchInit {
  /** Never `follow`. A redirect the runtime takes is a hop nothing checked. */
  redirect: 'manual'
  /** Nothing of the user's identity crosses to a CDN. */
  credentials: 'omit'
  /** Request headers. Today only `accept`. */
  headers: Record<string, string>
}

/**
 * The response shape this module needs.
 *
 * `body` is an async iterable of chunks rather than a `arrayBuffer()` promise,
 * and that is the size cap's whole mechanism: a promise for the complete body
 * cannot be refused halfway. Node's `fetch` gives a `ReadableStream`, which is
 * async-iterable; a test gives an async generator and can count how many chunks
 * were pulled.
 */
export interface RemoteResponse {
  status: number
  headers: { get: (name: string) => string | null }
  /** The bytes, in arrival order. `null` for a response with no body. */
  body: AsyncIterable<Uint8Array> | null
}

/** The minimal fetch surface this needs, so tests can supply an upstream. */
export interface FetchLike {
  (url: string, init: RemoteFetchInit): Promise<RemoteResponse>
}

/**
 * The default upstream: Node's own `fetch`, narrowed to what this needs.
 *
 * Exported so it can be tested. It is the **only** part of this module that a
 * test with an injected upstream never exercises, and it is the part that runs
 * in production — a mismatch between what `FetchLike` promises and what undici
 * does would show up nowhere else. Three assumptions in particular are somebody
 * else's runtime rather than this code's: that `redirect: 'manual'` yields the
 * real 3xx with a readable `location` (a browser would hand back an opaque
 * response instead), that `credentials: 'omit'` is accepted at all, and that
 * `response.body` is async-iterable so the cap can stop a read.
 * @param url - the URL to fetch.
 * @param init - redirect policy, credentials and headers.
 * @returns the response, narrowed to status, headers and a body stream.
 */
export const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    redirect: init.redirect,
    headers: init.headers,
    credentials: init.credentials,
  })
  return {
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    body: response.body as AsyncIterable<Uint8Array> | null,
  }
}

/** Redirect hops followed before giving up. jsDelivr uses one. */
export const MAX_HOPS = 5

/**
 * Eight mebibytes, the cap both callers use.
 *
 * Measured 2026-09-11 across both corpora (1,694 deduplicated code bodies, the
 * population `card-surface-census.mjs` walks): 28 distinct allow-listed URLs
 * appear in card code, the largest fetched body on record is MagVarUpdate's
 * bundle at 307,765 B, and **no** card reaches an allow-listed host through the
 * `fetch` bridge at all — the corpus's only remote `fetch()` calls are to
 * user-typed LLM endpoints, which the allowlist refuses before any request. So
 * there is no measured traffic arguing for a smaller number on the `script.fetch`
 * side, and one number for both callers is the point of this module: two limits
 * would be the two executions again, in a smaller form.
 */
export const DEFAULT_MAX_BYTES = 8_388_608

/** How a fetch through this module failed. */
export interface RemoteFetchFailure {
  ok: false
  /**
   * Which rule refused, so a caller can map it to its own vocabulary without
   * reading the prose. `not-allowed` is the allowlist (first hop or a redirect
   * target), `too-many-hops` and `too-large` are this host's limits, and
   * `unreachable` and `bad-status` are the far side's.
   */
  kind: 'not-allowed' | 'too-many-hops' | 'too-large' | 'unreachable' | 'bad-status'
  /** Why, in the words the browser or the card is given. Never any body. */
  reason: string
  /** The far side's status, when there was one. */
  status?: number
}

/** What a fetch through this module answered. */
export type RemoteFetchOutcome =
  | { ok: true, url: string, bytes: Buffer, contentType: string | null }
  | RemoteFetchFailure

/** Where a fetch goes and what it may cost. */
export interface RemoteFetchOptions {
  /** The transport. The one injection seam; defaults to {@link nodeFetch}. */
  fetch?: FetchLike
  /** Largest body accepted. @default DEFAULT_MAX_BYTES */
  maxBytes?: number
  /** Redirect hops followed. @default MAX_HOPS */
  maxHops?: number
  /** Told about every refusal, for the host's log. */
  onError?: (error: Error) => void
}

/**
 * Read a body in chunks, stopping the moment it passes the cap.
 *
 * Breaking out of the `for await` calls the iterator's `return`, which cancels a
 * `ReadableStream` and finishes an async generator — so the refusal is a stopped
 * read, not a completed download that is then thrown away.
 * @param body - the response's chunks, or `null` for no body.
 * @param maxBytes - the cap; a body of exactly this many bytes is accepted.
 * @returns the bytes, or how far reading got before the cap was passed.
 */
async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: true, bytes: Buffer } | { ok: false, read: number }> {
  if (body === null) return { ok: true, bytes: Buffer.alloc(0) }
  const chunks: Buffer[] = []
  let read = 0
  for await (const chunk of body) {
    const piece = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    read += piece.byteLength
    if (read > maxBytes) return { ok: false, read }
    chunks.push(piece)
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}

/**
 * Fetch a URL a card proposed, checking the allowlist at every hop.
 *
 * @param requested - the URL, exactly as the untrusted side wrote it.
 * @param options - the transport and the limits.
 * @returns the bytes and the far side's content type, or a named refusal.
 */
export async function fetchAllowedRemote(
  requested: string,
  options: RemoteFetchOptions = {},
): Promise<RemoteFetchOutcome> {
  const transport = options.fetch ?? nodeFetch
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxHops = options.maxHops ?? MAX_HOPS
  const onError = options.onError ?? ((): void => {})
  /** Reported and returned in one act, so no refusal can reach a caller unlogged. */
  const refuse = (kind: RemoteFetchFailure['kind'], reason: string, status?: number): RemoteFetchFailure => {
    onError(new Error(reason))
    return { ok: false, kind, reason, ...status === undefined ? {} : { status } }
  }

  const first = checkScriptFetch(requested)
  // Not through `refuse`: the first-hop verdict already names the host, and this
  // is the one refusal that costs nothing and happens before any request — the
  // callers report it themselves where they have the context to.
  if (!first.allowed) return { ok: false, kind: 'not-allowed', reason: first.reason }

  let target = first.url
  for (let hop = 0; hop <= maxHops; hop += 1) {
    let response: RemoteResponse
    try {
      response = await transport(target, {
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: '*/*' },
      })
    } catch (error: unknown) {
      // "could not reach" would assert a fact about the network, and this catch
      // is not homogeneous: a `fetch` that throws is usually the far side being
      // unreachable, but a fault in `nodeFetch` — the one part of this module a
      // test with an injected upstream never runs — throws here too and would
      // arrive wearing the network's clothes. Somebody chasing an upstream
      // outage would never look at our adapter.
      //
      // So the message says what happened rather than why, and names both
      // readings. Guessing between them from the error's shape would be a
      // heuristic that is wrong silently, which is the thing being avoided.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      return refuse(
        'unreachable',
        `fetching ${target} threw (${detail}) — either the far side is unreachable`
        + ' or the host’s own fetch adapter faulted; the adapter is nodeFetch in remote-fetch.ts',
      )
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) return refuse('bad-status', `${target} redirected without a location`, response.status)
      let next: string
      try {
        next = new URL(location, target).toString()
      } catch {
        return refuse('bad-status', `${target} redirected to a location that is not a URL`, response.status)
      }
      // The hop is checked like the first request was. A whitelist that only
      // sees where a request was aimed does not know where it landed, and the
      // far side chooses the landing.
      const allowed = checkScriptFetch(next)
      if (!allowed.allowed) {
        // The refused host by name and which hop it was, because "blocked" with
        // neither is indistinguishable from a network fault — and because a
        // redirect chain that goes off the list at hop 3 is a different story
        // about the CDN than one that does it immediately. The refused URL's
        // *path* is not repeated beyond what the verdict says, and none of the
        // body is read.
        return refuse(
          'not-allowed',
          `${target} redirected to a host that is not allowed:`
          + ` hop ${String(hop + 1)} would have gone to ${hostOf(next)}, and ${allowed.reason}`,
        )
      }
      target = allowed.url
      continue
    }

    if (response.status !== 200) {
      return refuse('bad-status', `${target} answered ${String(response.status)}`, response.status)
    }

    const read = await readCapped(response.body, maxBytes)
    if (!read.ok) {
      return refuse(
        'too-large',
        `${target} is over the ${String(maxBytes)} byte limit:`
        + ` reading stopped after ${String(read.read)} bytes`,
      )
    }
    return { ok: true, url: target, bytes: read.bytes, contentType: response.headers.get('content-type') }
  }

  return refuse(
    'too-many-hops',
    `${requested} redirected more than ${String(maxHops)} times; the last hop was ${target}`,
  )
}

/**
 * A URL's host, for a message, without throwing on something unparseable.
 * @param url - the URL.
 * @returns the hostname, or the URL itself when it will not parse.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 120)
  }
}
