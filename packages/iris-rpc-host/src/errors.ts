/**
 * Turning thrown values into wire errors.
 *
 * The mapping is deliberately structural rather than nominal: `@iris/app-service`
 * must not depend on this package to raise a well-formed failure, because the
 * transport and the application are separate composition rows and a shared error
 * class would couple them. Anything carrying a `code` from the protocol's fixed
 * set is honoured; everything else becomes `internal`.
 *
 * @module @iris/rpc-host/errors
 */

import type { RpcError } from '@iris/protocol'

/**
 * The codes the contract defines. Anything else is not a wire code.
 *
 * **Written as a `Record` so the compiler requires every member.** This was a
 * `new Set<RpcError['code']>([...])`, which type-checks each element without
 * demanding all of them — so adding a code to the contract compiled cleanly
 * while this list silently lacked it, and `toWireError` downgraded the new code
 * to `internal`. That failure is invisible from either end: the thrower sees
 * its own code, the reader sees a generic internal error, and the frame's copy
 * for the real code never appears. It happened once, with `quota-exceeded`.
 *
 * A `Record` keyed by the union cannot be short a key.
 */
const CODES_BY_NAME: Record<RpcError['code'], true> = {
  'not-found': true,
  'invalid-request': true,
  'provider-error': true,
  busy: true,
  unsupported: true,
  'quota-exceeded': true,
  'no-provider': true,
  internal: true,
}

const CODES: ReadonlySet<string> = new Set(Object.keys(CODES_BY_NAME))

/**
 * A failure a handler raises on purpose, with the wire code it should carry.
 *
 * Exported for callers that do depend on this package; the transport does not
 * require it, see the module note.
 */
export class RpcFailure extends Error {
  /** The wire code this failure reports. */
  readonly code: RpcError['code']

  /**
   * @param code - the wire code.
   * @param message - detail safe to show a user; must not carry a credential.
   */
  constructor(code: RpcError['code'], message: string) {
    super(message)
    this.name = 'RpcFailure'
    this.code = code
  }
}

/**
 * Whether a value is one of the protocol's error codes.
 * @param value - the candidate.
 * @returns true when the contract defines it.
 */
export function isRpcErrorCode(value: unknown): value is RpcError['code'] {
  return typeof value === 'string' && CODES.has(value)
}

/**
 * Project a thrown value onto a wire error.
 *
 * The message is passed through rather than replaced by a generic one: every
 * throw site reachable from here is Iris's own code or a domain package's, none
 * of which put credentials in messages, and a local-first app that hides why a
 * turn failed is worse than useless to debug.
 * @param error - whatever the handler threw.
 * @returns the frame's error body.
 */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (isRpcErrorCode(code)) return { code, message: error.message }
    return { code: 'internal', message: error.message }
  }
  return { code: 'internal', message: String(error) }
}

/**
 * Render anything a sink is handed into a line a log can carry.
 *
 * Extracted so it can be tested. The judgment used to live inline in the plugin
 * as `error.message`, which is correct for an `Error` and throws for anything
 * else — and a **reporting** path that throws converts a logged warning into a
 * dead host, at the moment something is already going wrong. That is not a
 * hypothetical: the hub once reported `null` (the value `ws.send` passes on
 * success) as an error, and this line reading `.message` off it is what took the
 * process down mid-generation.
 *
 * The guard at the source is the fix; this is the seatbelt. It was added as a
 * one-line defence and never pinned, so its correctness rested on the same
 * reading that had produced the crash — which is the thing being corrected here.
 * @param error - whatever reached the sink.
 * @returns a string, for every input.
 */
export function describeHubError(error: unknown): string {
  if (error instanceof Error) return error.message
  // Not `String(error)` alone: `String(null)` is `"null"`, which is exactly the
  // text that made the original bug look like a logger fault rather than a
  // success being reported as a failure. Naming the type keeps that readable.
  if (error === null || error === undefined) return `a non-error value reached the error sink: ${String(error)}`
  return String(error)
}
