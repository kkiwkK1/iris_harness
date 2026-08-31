/**
 * Refusals the application raises on purpose.
 *
 * The transport reads the `code` structurally rather than by class, so this
 * package never has to depend on `@iris/rpc-host`. That is the point: the
 * application and the wire are separate composition rows, and a shared error
 * class would tie them together for no gain.
 *
 * @module @iris/app-service/errors
 */

import type { RpcError } from '@iris/protocol'

/** A deliberate refusal, carrying the wire code it should be reported as. */
export class AppError extends Error {
  /** The protocol code this failure reports. */
  readonly code: RpcError['code']

  /**
   * @param code - the wire code.
   * @param message - detail safe to show a user.
   */
  constructor(code: RpcError['code'], message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

/**
 * Nothing by that identity exists.
 * @param what - what was looked for.
 * @returns the refusal to throw.
 */
export function notFound(what: string): AppError {
  return new AppError('not-found', what)
}

/**
 * The chat is already doing something that cannot be interleaved.
 * @param what - what is in progress.
 * @returns the refusal to throw.
 */
export function busy(what: string): AppError {
  return new AppError('busy', what)
}

/**
 * The request was well-formed but asks for something impossible.
 * @param why - the reason.
 * @returns the refusal to throw.
 */
export function invalid(why: string): AppError {
  return new AppError('invalid-request', why)
}
