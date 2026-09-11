/**
 * The request half of the transport: one POST endpoint carrying RPC frames.
 *
 * `dsh-host-webserver` ships no TLS and no authentication, and this package does
 * not pretend otherwise — it binds to loopback and trusts the machine. Two
 * things defend that bind, and the order matters because the second one only
 * works while the first holds:
 *
 *  1. **The `Host` allow-list** (`host-guard.ts`), checked before anything else
 *     on every request this package or the application answers. A loopback bind
 *     is not an access control: public wildcard DNS (`127.0.0.1.nip.io`,
 *     `*.sslip.io`) hands an attacker a *browser origin they own* that resolves
 *     to this machine, and once the browser believes that name is loopback the
 *     page is same-origin with the host.
 *  2. **The JSON content type.** A POST whose `content-type` is
 *     `application/json` is not a CORS *simple* request, so the browser must
 *     preflight it, and no `access-control-allow-origin` is ever sent. That is
 *     what stops a page on an *unrelated* origin from blind-firing a method
 *     with side effects.
 *
 * Before 2026-09-11 only (2) existed, and this docblock claimed it was "the one
 * attack a loopback server is still exposed to". It was not: a rebound page is
 * not cross-site by the time it fires, so the preflight it would have needed is
 * never required. See `notes/packages/iris-rpc-host/DEVIATIONS.md` §1.
 *
 * @module @iris/rpc-host/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The body of a `Host` refusal: one line, naming the rule and where it is set.
 *
 * Deliberately says nothing about *which* value was refused. Echoing an
 * attacker-chosen header back into a response body is a habit worth not having,
 * and the operator who needs that value has it in the log line instead.
 */
export const HOST_REFUSAL_BODY
  = 'iris: refused — this host answers only requests whose Host header is in its allow-list'
    + ' (loopback on the bound port, plus rpc-host `allowedHosts` / IRIS_ALLOWED_HOSTS).\n'

/**
 * Refuse one request whose `Host` is not in the allow-list.
 *
 * `text/plain` and `no-store`: a refusal is not a protocol frame — the caller
 * never got far enough to have a request id — and it must not be cached against
 * an origin the allow-list may admit tomorrow.
 * @param res - the response to write.
 */
export function respondHostRefused(res: ServerResponse): void {
  res.writeHead(403, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(HOST_REFUSAL_BODY),
    'cache-control': 'no-store',
  })
  res.end(HOST_REFUSAL_BODY)
}

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
