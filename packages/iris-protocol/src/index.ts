/**
 * The Iris host/browser contract.
 *
 * Frozen on purpose: the transport and the interface are built in parallel
 * against it, so a change here is a change to two work streams at once. Treat
 * additions as cheap and edits to existing shapes as expensive.
 *
 * @module @iris/protocol
 */

/*
 * The bundle route and the specifier walker.
 *
 * In the contract because **both** halves rewrite specifiers and they have to
 * agree on the route: the browser rewrites a card's remote imports onto it, and
 * the host rewrites the specifiers inside the bodies it serves — a jsDelivr
 * `+esm` bundle's dependencies are root-relative and would otherwise resolve
 * against us. Two implementations of that would eventually disagree about the
 * encoding, and the symptom of disagreeing is a 404 that `import()` reports
 * without naming anything.
 */
export {
  BUNDLE_PROXY_PATH,
  fromProxied,
  rewriteSpecifiers,
  specifierSpans,
  toProxied,
} from './bundle-specifiers.ts'

export {
  isEvent,
  type IrisEvent,
  type IrisEventType,
} from './events.ts'

/*
 * The entry-listing mapper, in the contract for the reason the specifier walker
 * above is: the host derives digests from real books and the fake client from
 * its own seeded ones, and a page reading both must not be able to tell them
 * apart by which fields arrived.
 */
export { toEntryDigest } from './digests.ts'

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
  BackupPreview,
  BackupPreviewFloor,
  BackupReason,
  BackupSummary,
  CardBookDigest,
  CardBookRole,
  WorldbookEntryDigest,
  ChatCompaction,
  ChatSearchHit,
  ChatSearchMatch,
  ChatSummary,
  ChatView,
  CardWorldbookView,
  CharacterSummary,
  ConnectionKeySource,
  ConnectionProfile,
  ConnectionTestError,
  ConnectionTestErrorCode,
  DebugReport,
  HostDefaultConnection,
  ReportGrade,
  ContinuePostfix,
  GenerationSettings,
  InsertionStrategy,
  LorebookSettings,
  MessageView,
  TurnUsage,
  PersonaView,
  PresetManagerView,
  PresetPromptView,
  PresetSummary,
  PromptItemEntry,
  PromptItemization,
  ReasoningEffort,
  RegexScriptView,
  ScopedRegexView,
  ScriptChatMessage,
  ScriptContext,
  ScriptPromptPosition,
  ScriptSource,
  ScriptView,
  SecondaryLogic,
  UsageBucket,
  UsageChat,
  UsageGranularity,
  UsageSummary,
  UsageTotals,
  UserScript,
  UserScriptView,
  ViewRole,
  WorldbookEntry,
  WorldbookPosition,
  WorldbookSettingsView,
  WorldbookSummary,
} from './views.ts'

export {
  PROVIDER_PRESETS,
  providerPreset,
  type ProviderPreset,
} from './providers.ts'

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
