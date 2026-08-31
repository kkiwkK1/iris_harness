/**
 * The request/response surface, client → host.
 *
 * Requests carry zod schemas because they are the untrusted direction: the
 * browser is a separate trust domain, and a boundary that is only
 * type-checked is not checked at all once the page is open in devtools.
 * Responses and events are types only — the host is their author.
 *
 * Generation is deliberately NOT a response. `chat.send` returns as soon as the
 * turn is opened and the text arrives as events, because a request that
 * resolves with the finished reply cannot stream and cannot be interrupted.
 *
 * @module @iris/protocol/rpc
 */

import { z } from 'zod'

import type { ChatSummary, ChatView, CharacterSummary, GenerationSettings } from './views.ts'

/** Runtime schemas for every request body, keyed by method. */
export const requestSchemas = {
  'chat.list': z.object({}),
  'chat.create': z.object({ characterId: z.string().min(1) }),
  'chat.open': z.object({ chatId: z.string().min(1) }),
  'chat.delete': z.object({ chatId: z.string().min(1) }),
  'chat.rename': z.object({ chatId: z.string().min(1), title: z.string().max(200) }),

  'chat.send': z.object({
    chatId: z.string().min(1),
    // Bounded because it lands in a prompt; an unbounded field is a way to
    // burn someone's tokens from a page they were tricked into opening.
    text: z.string().min(1).max(32_000),
  }),
  'chat.regenerate': z.object({ chatId: z.string().min(1) }),
  'chat.abort': z.object({ chatId: z.string().min(1) }),
  'chat.swipe': z.object({
    chatId: z.string().min(1),
    turn: z.number().int().min(0),
    index: z.number().int().min(0),
  }),
  'chat.editMessage': z.object({
    chatId: z.string().min(1),
    id: z.number().int().min(0),
    text: z.string().max(32_000),
  }),
  'chat.deleteMessage': z.object({ chatId: z.string().min(1), id: z.number().int().min(0) }),

  'character.list': z.object({}),
  'character.import': z.object({
    filename: z.string().min(1).max(255),
    /** Base64 of a PNG card, a `.json` card, or a `.charx`. */
    content: z.string().min(1),
  }),
  'character.delete': z.object({ characterId: z.string().min(1) }),

  'settings.get': z.object({ chatId: z.string().min(1).optional() }),
  /**
   * A partial patch, with three cases the two halves must read alike:
   * an omitted key leaves that field alone, an explicit `null` clears the
   * optional field so the host's own default applies, and an unrecognized key
   * is dropped rather than stored — a typo must not look supported.
   *
   * `null` carries that meaning because omission is already spoken for: a patch
   * has no other way to say "stop overriding this".
   */
  'settings.set': z.object({
    chatId: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()),
  }),
} as const

/** Every callable method. */
export type RpcMethod = keyof typeof requestSchemas

/** The validated request body of one method. */
export type RpcRequest<M extends RpcMethod> = z.infer<(typeof requestSchemas)[M]>

/** What each method resolves with. */
export interface RpcResponseMap {
  'chat.list': { chats: ChatSummary[] }
  'chat.create': { view: ChatView }
  'chat.open': { view: ChatView }
  'chat.delete': Record<string, never>
  'chat.rename': { chats: ChatSummary[] }

  /** Resolves when the turn is open, not when the reply is finished. */
  'chat.send': { turn: number }
  /**
   * Produces another candidate for the LAST turn only.
   *
   * Regenerating an earlier turn would mean discarding everything after it,
   * which is a different operation with different consequences; it is
   * deliberately absent rather than implied.
   */
  'chat.regenerate': { turn: number }
  'chat.abort': Record<string, never>
  'chat.swipe': { view: ChatView }
  'chat.editMessage': { view: ChatView }
  'chat.deleteMessage': { view: ChatView }

  'character.list': { characters: CharacterSummary[] }
  'character.import': { character: CharacterSummary }
  'character.delete': Record<string, never>

  'settings.get': { settings: GenerationSettings }
  'settings.set': { settings: GenerationSettings }
}

/** The response of one method. */
export type RpcResponse<M extends RpcMethod> = RpcResponseMap[M]

/** A failure the client can render. */
export interface RpcError {
  /** Stable machine-readable reason. */
  code:
    | 'not-found'
    | 'invalid-request'
    | 'provider-error'
    | 'busy'
    | 'unsupported'
    | 'internal'
  /** Human-readable detail. Safe to show; must not carry a credential. */
  message: string
}

/**
 * The rejection `IrisClient.call` produces.
 *
 * A real `Error`, not a bare shape: a promise rejected with a plain object
 * loses its stack and every tool that formats errors — the console, a test
 * runner, an error boundary — degrades to printing `[object Object]`. The
 * machine-readable half rides alongside so a caller can still branch on
 * `code` without parsing prose.
 */
export class RpcCallError extends Error implements RpcError {
  readonly code: RpcError['code']

  /**
   * @param error - the failure the host reported.
   */
  constructor(error: RpcError) {
    super(error.message)
    this.name = 'RpcCallError'
    this.code = error.code
  }
}

/** One request frame on the wire. */
export interface RpcRequestFrame<M extends RpcMethod = RpcMethod> {
  /** Correlates the response. */
  id: string
  method: M
  params: RpcRequest<M>
}

/** One response frame on the wire. */
export type RpcResponseFrame<M extends RpcMethod = RpcMethod> =
  | { id: string, ok: true, result: RpcResponse<M> }
  | { id: string, ok: false, error: RpcError }

/**
 * Validate an incoming request body.
 *
 * The single place the host is allowed to trust a browser payload. Returns a
 * discriminated result rather than throwing, so the transport answers with an
 * `invalid-request` frame instead of tearing down the connection — a malformed
 * frame from one page must not disconnect the others.
 * @param method - the requested method.
 * @param params - the raw body.
 * @returns the parsed params, or the reason they were refused.
 */
export function parseRequest<M extends RpcMethod>(
  method: M,
  params: unknown,
): { ok: true, params: RpcRequest<M> } | { ok: false, error: RpcError } {
  // Widened to `unknown` rather than to `RpcRequest<M>`: the map's value type is
  // a union of concrete schemas, and asserting it into the per-method schema
  // type is the cast TypeScript rightly refuses. The narrowing happens once, on
  // the parsed result, where the schema has already proved the shape.
  const schema = requestSchemas[method] as z.ZodType<unknown> | undefined
  if (schema === undefined) {
    return { ok: false, error: { code: 'unsupported', message: `unknown method "${String(method)}"` } }
  }
  const result = schema.safeParse(params)
  if (!result.success) {
    return { ok: false, error: { code: 'invalid-request', message: result.error.issues[0]?.message ?? 'invalid params' } }
  }
  return { ok: true, params: result.data as RpcRequest<M> }
}
