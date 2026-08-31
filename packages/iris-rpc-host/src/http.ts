/**
 * The request half of the transport: one POST endpoint carrying RPC frames.
 *
 * `dsh-host-webserver` ships no TLS and no authentication, and this package does
 * not pretend otherwise — it binds to loopback and trusts the machine. What it
 * does defend is the one attack a loopback server is still exposed to: a page on
 * an unrelated origin firing a cross-site request at it. A POST whose
 * `content-type` is `application/json` is not a CORS *simple* request, so the
 * browser must preflight it, and no `access-control-allow-origin` is ever sent.
 * Requiring that content type is therefore what stops a hostile page from blind
 * firing a method with side effects.
 *
 * @module @iris/rpc-host/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Outcome of reading a request body under a cap. */
export type BodyResult =
  | { ok: true, text: string }
  | { ok: false, reason: 'too-large' }

/**
 * Whether a `content-type` header names JSON.
 *
 * Parameters are tolerated (`application/json; charset=utf-8`) because browsers
 * and fetch add them; the media type itself must match exactly, since a
 * near-miss like `text/plain` is precisely what a cross-site simple request
 * would carry.
 * @param header - the raw header value, if any.
 * @returns true when the body claims to be JSON.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false
  const type = header.split(';', 1)[0]?.trim().toLowerCase()
  return type === 'application/json'
}

/**
 * Read a request body, refusing anything past `limit` bytes.
 *
 * The cap is counted on the wire bytes rather than trusting `content-length`,
 * which a client is free to lie about.
 * @param req - the incoming request.
 * @param limit - largest body accepted, in bytes.
 * @returns the decoded text, or the reason it was refused.
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return { ok: false, reason: 'too-large' }
    chunks.push(buffer)
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * Write one JSON response.
 *
 * `no-store` because every RPC answer is conversation state: a cached reply
 * replayed after a swipe would show the user a message that no longer exists.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the value to serialize.
 */
export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}
