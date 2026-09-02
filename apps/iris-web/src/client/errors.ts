/**
 * Turning a rejection into something a reader can act on.
 *
 * The contract now settles this: `call` rejects with `RpcCallError`, which is an
 * `Error` and carries a `code`. The duck-typed check below is kept anyway, and
 * not out of distrust of the transport — it costs three lines and it is what
 * keeps a bare-object rejection from reaching the reader as "[object Object]",
 * which is the worst possible failure for the one surface whose whole job is to
 * explain a failure. Deliberately NOT an `instanceof RpcCallError` check: that
 * would add a value import from `@iris/protocol` to this module, and `store.ts`
 * imports it — which is what would cost the streaming state machine its ability
 * to run under plain `node --test`.
 *
 * Everything the UI shows a reader goes through this function.
 *
 * @module iris-web/client/errors
 */

import type { RpcError } from '@iris/protocol'

/** Reader-facing copy per failure code. */
const COPY: Record<RpcError['code'], string> = {
  'not-found': 'That is not there any more. The sidebar may be out of date — reload to catch up.',
  'invalid-request': 'Iris would not send that.',
  'provider-error': 'The model refused the request.',
  busy: 'This chat is still generating. Stop it first.',
  unsupported: 'This build of Iris cannot do that yet.',
  /*
   * A card filled the shared card storage, and the shared part is what a reader
   * has to be told: the store is one profile-wide store, as `localStorage` is
   * one store per origin upstream, so the card that hit the ceiling is not
   * necessarily the card that filled it. A message naming only "this card"
   * would send a reader to delete the wrong thing.
   */
  'quota-exceeded': 'The cards’ shared storage is full. Its contents are shared across every'
    + ' card in this profile, so the one that ran out may not be the one that filled it.',
  internal: 'Something broke on the host side.',
}

/** Whether a value carries a recognizable `RpcError` code. */
/**
 * Whether a failure came from the host at all.
 *
 * The distinction exists here and used to be discarded one line later: a host
 * error arrives carrying a code, while a bug in Iris's own callback arrives as a
 * plain `Error` and is then relabelled `internal` — which is *also* a real host
 * code. Two different origins rendered as one sentence, so a fault of ours read
 * as the host answering.
 * @param error - whatever was thrown.
 * @returns true when the host said this, false when Iris did.
 */
export function isHostError(error: unknown): boolean {
  return hasCode(error)
}

function hasCode(value: unknown): value is { code: RpcError['code'], message?: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code in COPY
}

/**
 * Normalize any rejection into an `RpcError`.
 * @param error - whatever was thrown or rejected.
 * @returns a code and a message safe to render.
 */
export function asRpcError(error: unknown): RpcError {
  if (hasCode(error)) {
    const detail = typeof error.message === 'string' && error.message.trim() !== '' ? error.message : undefined
    return { code: error.code, message: detail ?? COPY[error.code] }
  }
  if (error instanceof Error) return { code: 'internal', message: error.message }
  return { code: 'internal', message: String(error) }
}

/**
 * The sentence to put in front of a reader.
 *
 * Prefers the general explanation over the host's detail for the codes where
 * the detail is an identifier ("no chat \"chat-7\""), and keeps the detail where
 * it is the actual information (a provider's refusal reason).
 * @param error - whatever was thrown or rejected.
 * @returns one sentence, active voice, no apology.
 */
export function describeError(error: unknown): string {
  const rpc = asRpcError(error)
  if (rpc.code === 'provider-error' || rpc.code === 'internal') return rpc.message
  return COPY[rpc.code]
}
