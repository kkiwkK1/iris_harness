/**
 * One fake transport for both callers of `fetchAllowedRemote`.
 *
 * The point of the 2026-09-11 change is that `ScriptCache` and `script.fetch`
 * fetch through one executor, so their tests inject one transport: a second fake
 * with its own idea of what a redirect or a body is would let the two drift
 * apart again in exactly the place the drift last happened.
 *
 * It answers from a table and records three things a refusal has to be argued
 * from — what was asked, what init the executor passed, and **how much of each
 * body was actually pulled**, which is how a size refusal is distinguished from
 * a completed download that was thrown away afterwards.
 *
 * @module @iris/app-service/tests/support/fake-remote
 */

import type { FetchLike, RemoteFetchInit } from '../../src/remote-fetch.ts'

/** One upstream answer. */
export interface Route {
  status: number
  /** The body, served in `chunkBytes`-sized pieces. */
  body?: string
  /** The `location` header, for a 3xx. */
  location?: string
  /** The `content-type` header. */
  contentType?: string
}

/** What a fake transport records about the requests it served. */
export interface FakeRemote {
  fetch: FetchLike
  /** Every URL requested, in order. */
  asked: string[]
  /** The init each request carried. */
  inits: RemoteFetchInit[]
  /** Bytes actually pulled out of each body, in request order. */
  pulled: number[]
  /** Whether each body was iterated to its end. */
  drained: boolean[]
}

/**
 * A transport answering from a table.
 * @param routes - URL to answer.
 * @param chunkBytes - how large each body chunk is. Small on purpose: a cap that
 *   can only stop between chunks is only tested by a body of several.
 * @returns the transport and what it recorded.
 */
export function fakeRemote(routes: Record<string, Route>, chunkBytes = 16): FakeRemote {
  const asked: string[] = []
  const inits: RemoteFetchInit[] = []
  const pulled: number[] = []
  const drained: boolean[] = []

  const fetch: FetchLike = async (url, init) => {
    const at = asked.length
    asked.push(url)
    inits.push(init)
    pulled.push(0)
    drained.push(false)
    const route = routes[url] ?? { status: 404 }
    const text = route.body ?? ''
    const bytes = Buffer.from(text, 'utf8')
    return {
      status: route.status,
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase()
          if (key === 'location') return route.location ?? null
          if (key === 'content-type') return route.contentType ?? null
          return null
        },
      },
      body: (async function* body() {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          const piece = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength))
          // Counted before the yield, because the consumer may never come back:
          // what this records is what the far side actually handed over.
          pulled[at] = (pulled[at] ?? 0) + piece.byteLength
          yield new Uint8Array(piece)
        }
        drained[at] = true
      }()),
    }
  }

  return { fetch, asked, inits, pulled, drained }
}
