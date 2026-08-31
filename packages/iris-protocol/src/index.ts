/**
 * The Iris host/browser contract.
 *
 * Frozen on purpose: the transport and the interface are built in parallel
 * against it, so a change here is a change to two work streams at once. Treat
 * additions as cheap and edits to existing shapes as expensive.
 *
 * @module @iris/protocol
 */

export {
  isEvent,
  type IrisEvent,
  type IrisEventType,
} from './events.ts'

export {
  parseRequest,
  requestSchemas,
  RpcCallError,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcRequestFrame,
  type RpcResponse,
  type RpcResponseFrame,
  type RpcResponseMap,
} from './rpc.ts'

export type {
  ChatSummary,
  ChatView,
  CharacterSummary,
  GenerationSettings,
  MessageView,
  PromptItemEntry,
  PromptItemization,
  ScriptChatMessage,
  ScriptContext,
  ScriptPromptPosition,
  ScriptView,
  ViewRole,
} from './views.ts'

/**
 * The client-side facade both halves agree on.
 *
 * The interface UI code depends on. The real implementation talks over
 * WebSocket; a test or a design pass supplies an in-memory one, which is what
 * lets the interface be built before the transport exists.
 */
export interface IrisClient {
  /**
   * Call one method.
   * @param method - the method name.
   * @param params - its validated params.
   * @returns the method's response.
   * @throws {RpcError} shaped rejection when the host refuses.
   */
  call<M extends import('./rpc.ts').RpcMethod>(
    method: M,
    params: import('./rpc.ts').RpcRequest<M>,
  ): Promise<import('./rpc.ts').RpcResponse<M>>

  /**
   * Subscribe to pushed frames.
   * @param listener - receives every event, in arrival order.
   * @returns a disposer; Iris is plugin-based, so every registration is reversible.
   */
  subscribe(listener: (event: import('./events.ts').IrisEvent) => void): () => void

  /** Whether the transport currently has a live connection. */
  readonly connected: boolean

  /**
   * Observe connection changes.
   *
   * Deliberately here and not in {@link import('./events.ts').IrisEvent}: that
   * union is what the HOST sends, and a connection change is the one fact the
   * host cannot report — it is least able to speak exactly when the news
   * matters. A locally synthesized frame in that union would misstate its own
   * provenance, and without this an offline banner can only appear once some
   * unrelated traffic arrives to be counted.
   * @param listener - called with the new state on every change, not on subscribe.
   * @returns a disposer.
   */
  onConnectionChange(listener: (connected: boolean) => void): () => void
}
