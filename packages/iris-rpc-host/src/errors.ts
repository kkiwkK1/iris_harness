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

/** The codes the contract defines. Anything else is not a wire code. */
const CODES: ReadonlySet<string> = new Set<RpcError['code']>([
  'not-found',
  'invalid-request',
  'provider-error',
  'busy',
  'unsupported',
  'internal',
])

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
