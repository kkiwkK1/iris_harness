import { RPC_METHODS, type RpcMethod, type RpcRequest, type RpcResponse } from '@iris/protocol'

import type { Handlers } from './service.ts'

/**
 * The transport's `register`, as this module needs it: generic per method, so
 * a name can only be paired with a handler of that same method's types.
 */
export type RegisterMethod = <M extends RpcMethod>(
  method: M,
  handler: (params: RpcRequest<M>) => Promise<RpcResponse<M>>,
) => () => void

/**
 * Registers every contract method's handler on the transport, and returns one
 * disposer that revokes them in reverse registration order.
 *
 * **A loop, and no cast on the handler.** This replaced 146 hand-written
 * `ctx.irisRpc.register('m', handlers['m'])` lines (2026-09-25). The decision
 * it reverses was recorded as "`register` is generic per method, and a loop
 * would need a cast that throws away exactly the check worth having". That is
 * true of a naive `for (const m of methods) register(m, handlers[m])`: `m` is
 * the whole `RpcMethod` union there, `handlers[m]` is the union of every
 * handler, and TypeScript cannot correlate the two (TS2345). It is false of a
 * generic per-method helper: inside `registerOne<M>`, `handlers[method]` is
 * `Handlers[M]`, which is exactly the `register<M>` parameter, so the pair
 * compiles with no cast and a mismatched pair (`register('chat.list',
 * handlers['chat.open'])`) still fails. The per-method check itself was never
 * in the register call — it is `Handlers`, a total mapped type the service's
 * one literal is checked against — and a loop over names cannot mis-pair at
 * all, which the hand list could.
 *
 * The method list is {@link RPC_METHODS}, the protocol's own closed key list,
 * so a method added to the contract is registered by the same edit that adds
 * its schema and its handler; there is no third list to forget.
 * @param register - the transport's registration call.
 * @param handlers - the service's total handler table.
 * @returns a disposer that unregisters every method, last-registered first.
 */
export function registerHandlers(register: RegisterMethod, handlers: Handlers): () => void {
  const registerOne = <M extends RpcMethod>(method: M): (() => void) => register(method, handlers[method])
  const disposers = RPC_METHODS.map(registerOne)
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
