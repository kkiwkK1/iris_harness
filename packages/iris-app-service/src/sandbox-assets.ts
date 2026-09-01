/**
 * Serving the sandbox's own build artifacts with a CORS header.
 *
 * `bootstrap.js` and `preset.js` are loaded **by** the card frame, which is an
 * opaque origin, so every request for them is cross-origin to this host. The
 * frontend plugin that otherwise serves the dist takes the webserver's fallback
 * seat and has no way to add headers, so this route claims the prefix ahead of
 * it.
 *
 * The consumer is specific and worth naming: `preset.js` is loaded as a
 * **classic** script, and a classic script without `crossorigin` reports every
 * error it throws as the bare string `Script error.` — the browser withholds the
 * message, the file and the line. With this header the frame can carry
 * `crossorigin` on that tag, and the errors it schedules get their names back.
 * The two halves have to move together: `crossorigin` without this header is a
 * blocked load, and this header without `crossorigin` changes nothing.
 *
 * `*` rather than an echoed origin, for the reason the bundle route gives: a
 * sandboxed frame's origin is the string `null`, so there is nothing to echo,
 * and these are public build artifacts served without credentials.
 *
 * @module @iris/app-service/sandbox-assets
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * What every answer on this route carries.
 *
 * `access-control-allow-origin` is the reason the route exists apart from the
 * frontend plugin. `timing-allow-origin` is what lets an opaque-origin frame
 * read a real Resource Timing entry instead of the zeroes a cross-origin fetch
 * reports — the difference between "the request was sent" and "the request
 * finished", which is the whole question when a card stops loading. `vary` is a
 * net: nothing varies by origin while the allowance is a constant `*`, and a
 * cache that had not been told to key on it would be wrong the moment that
 * changed.
 */
const SHARED_HEADERS = {
  'access-control-allow-origin': '*',
  'timing-allow-origin': '*',
  vary: 'Origin',
} as const

/** Content types for what this directory actually holds. */
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serve one file from the sandbox asset directory.
 * @param dir - the directory holding the artifacts.
 * @param base - the route's pathname prefix.
 * @param req - the request.
 * @param res - the response.
 */
export async function serveSandboxAsset(
  dir: string,
  base: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SHARED_HEADERS, allow: 'GET, HEAD' })
    res.end()
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://iris.invalid').pathname
  // Checked, not assumed. The URL parser collapses `.` and `..` — and `%2e%2e`
  // with them — so `/sandbox/../secret.txt` arrives here as `/secret.txt`, which
  // no longer starts with the prefix. Slicing regardless would take the last
  // three characters of an unrelated path and look *that* up: it happens to miss,
  // but by arithmetic rather than by a rule.
  if (!pathname.startsWith(base)) {
    res.writeHead(404, SHARED_HEADERS)
    res.end()
    return
  }

  let rest: string
  try {
    rest = decodeURIComponent(pathname.slice(base.length)).replace(/^\/+/, '')
  } catch {
    res.writeHead(400, SHARED_HEADERS)
    res.end()
    return
  }

  // Resolved and then checked for containment. This is not redundant with the
  // prefix check above: the two catch **different spellings**. `..` and `%2e%2e`
  // are removed by the URL parser and fail the prefix test; `..%2f` survives
  // normalization intact, reaches `decodeURIComponent` as `../`, and would climb
  // out of the directory — this is the check that stops it.
  const root = resolve(dir)
  const file = resolve(join(root, rest))
  if (file !== root && !file.startsWith(root + sep)) {
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

  const dot = file.lastIndexOf('.')
  res.writeHead(200, {
    ...SHARED_HEADERS,
    'content-type': TYPES[file.slice(dot).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    // Revalidated, not held. These are build artifacts that change whenever the
    // interface is rebuilt, and `script-cache.ts` records what a long TTL costs
    // when a header goes out wrong: the bad copy outlives the deployment inside
    // a cache only the browser can see.
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}
