/**
 * Turning a rejection into something a reader can act on.
 *
 * The protocol says `IrisClient.call` rejects with an `RpcError` shape but does
 * not say whether that value is also an `Error`, and the two halves of this
 * product are being built in parallel — so the browser normalizes here rather
 * than assuming. Everything the UI shows a reader goes through this function.
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
  internal: 'Something broke on the host side.',
}

/** Whether a value carries a recognizable `RpcError` code. */
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
