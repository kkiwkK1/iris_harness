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

import type { Language, StringKey } from '../app/i18n/strings.ts'
import { translate } from '../app/i18n/strings.ts'

/**
 * The dictionary key carrying each failure code's reader-facing copy.
 *
 * The sentences live in `app/i18n/strings.ts` so the Chinese column is held to
 * the same key set as the English one by the type system; the per-code lookup
 * is what belongs here. `provider-error`, `internal` **and `unsupported`** are
 * absent on purpose: for those the host's own detail **is** the information,
 * and `describeError` passes it through unrewritten.
 *
 * `unsupported` joined them after a founding-console failure reached its reader
 * as "This build of Iris cannot do that yet." while the host's own answer said
 * exactly which commands exist and which one arrived — the difference between a
 * dead end and a diagnosis. Every `unsupported` raise names the capability and
 * the reason it is not there, so the general sentence could only lose facts.
 */
const COPY: Record<RpcError['code'], StringKey | undefined> = {
  'not-found': 'errNotFound',
  'invalid-request': 'errInvalidRequest',
  'provider-error': undefined,
  busy: 'errBusy',
  unsupported: undefined,
  /*
   * A card filled the shared card storage, and the shared part is what a reader
   * has to be told: the store is one profile-wide store, as `localStorage` is
   * one store per origin upstream, so the card that hit the ceiling is not
   * necessarily the card that filled it. A message naming only "this card"
   * would send a reader to delete the wrong thing.
   */
  'quota-exceeded': 'errQuota',
  internal: 'errInternal',
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
 * @param lang - the language for the fallback copy.
 * @returns a code and a message safe to render.
 */
export function asRpcError(error: unknown, lang: Language = 'en'): RpcError {
  if (hasCode(error)) {
    const detail = typeof error.message === 'string' && error.message.trim() !== '' ? error.message : undefined
    const key = COPY[error.code]
    return { code: error.code, message: detail ?? (key === undefined ? '' : translate(lang, key)) }
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
 * @param lang - the language to read the explanation in.
 * @returns one sentence, active voice, no apology.
 */
export function describeError(error: unknown, lang: Language = 'en'): string {
  const rpc = asRpcError(error, lang)
  if (rpc.code === 'provider-error' || rpc.code === 'internal') return rpc.message
  const key = COPY[rpc.code]
  return key === undefined ? rpc.message : translate(lang, key)
}
