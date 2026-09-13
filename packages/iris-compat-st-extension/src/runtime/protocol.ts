/**
 * The wire shapes crossing the three boundaries the pilot stands up:
 *
 * 1. **host → shell** — the `st-compat.request` broadcast event (declared in
 *    `@iris/protocol` at wiring time) and the `stCompat.*` RPCs;
 * 2. **shell → extension iframe** — postMessage payloads on the
 *    `irisStExt` channel, always carrying the frame's token;
 * 3. **card iframe → shell** — the member-proxy call on the
 *    `irisStMemberProxy` channel.
 *
 * This module is imported by both the node side (the host bridge validates
 * payloads structurally) and the browser side (kernel + plane share the same
 * shapes), so a field rename breaks both ends at compile time instead of
 * drifting into a silent no-op roundtrip.
 */

/** One floor of the chat, as the upstream `chat` array members are read. */
export interface StFloorSnapshot {
  /** Floor text (`message.mes`). */
  mes: string
  /** Author display name. */
  name: string
  is_user: boolean
  is_system: boolean
  /** Active swipe index; the pilot floors carry one swipe. */
  swipe_id: number
  /** Message-scope variables (`chat[i].variables[swipe_id]`), when the floor has any. */
  variables?: Record<string, unknown> | undefined
  /** Upstream's own processed marker, hydrated so re-enable does not reprocess. */
  is_ejs_processed?: boolean[] | undefined
}

/** A prompt message as the generate bridge hands it over and takes it back. */
export interface StBridgeMessage {
  role: string
  content: string
}

/**
 * Everything the extension iframe needs to hydrate its facade state for one
 * bridge round. Shapes mirror the objects the upstream code mutates in place;
 * the kernel applies them onto stable identities so live bindings stay valid.
 */
export interface StBridgeContext {
  chatId: string
  /** All floors, indexed by position — the reply bridge needs absolute indices. */
  chat: StFloorSnapshot[]
  /** `chat_metadata.variables` — the local (chat) variable layer. */
  chatVariables: Record<string, unknown>
  /** The extension's namespaced settings blob: `{ EjsTemplate, variables: { global }, regex }`. */
  extensionSettings: Record<string, unknown>
  language: string
  userName: string
  characterName: string
  characterId: number | null
}

export interface StGeneratePayload extends StBridgeContext {
  kind: 'generate'
  generateType: string
  /** The assembled prompt, one message per contribution; mutated in place by the extension. */
  messages: StBridgeMessage[]
}

export interface StReplyPayload extends StBridgeContext {
  kind: 'reply'
  /** The floor index the reply is landing on (`turn`). */
  turn: number
  /** The reply text as stored-so-far (trimmed), before template processing. */
  text: string
}

export type StBridgePayload = StGeneratePayload | StReplyPayload

/** What the kernel sends back for a generate round. */
export interface StGenerateResult {
  kind: 'generate'
  /** The post-processed message list, read back from the emitted event payload. */
  messages: StBridgeMessage[]
  chatVariables: Record<string, unknown>
  globalVariables: Record<string, unknown>
}

/** What the kernel sends back for a reply round. */
export interface StReplyResult {
  kind: 'reply'
  turn: number
  /** `chat[turn].mes` after permanent evaluation — the floor text to store. */
  mes: string
  chatVariables: Record<string, unknown>
  globalVariables: Record<string, unknown>
  /**
   * The processed floor's OWN variable layer (`chat[turn].variables[swipe]`
   * upstream). The reply's render handler writes setvar results here — the
   * chat layer is untouched by that path — so the host must merge this back
   * onto the message scope or every reply-driven update is lost.
   */
  floorVariables: Record<string, unknown>
}

export type StBridgeResult = StGenerateResult | StReplyResult

/** Shell → iframe: one bridge round. */
export interface StBridgeMessage_Envelope {
  irisStExt: string
  type: 'bridge'
  token: string
  revision: number
  payload: StBridgePayload
}

/** Shell → iframe: chat opened or replaced (plane-initiated, no host roundtrip). */
export interface StChatOpenEnvelope {
  irisStExt: string
  type: 'chat-open'
  context: StBridgeContext
}

/** Iframe → shell: kernel is up and the facade surface is installed. */
export interface StReadyEnvelope {
  irisStExt: string
  type: 'ready'
}

/** Iframe → shell: the facade's saveSettingsDebounced fired; persist this blob. */
export interface StSettingsPersistEnvelope {
  irisStExt: string
  type: 'settings-persist'
  extensionSettings: Record<string, unknown>
}

/** Iframe → shell: toastr shim forwarding, so extension toasts reach the report surface. */
export interface StToastEnvelope {
  irisStExt: string
  type: 'toast'
  level: 'success' | 'warning' | 'error' | 'info'
  message: string
  detail?: string
}

/** Iframe → shell: a bridge or init failure the shell should surface. */
export interface StErrorEnvelope {
  irisStExt: string
  type: 'error'
  where: string
  message: string
}

/** Iframe → shell: answer for one bridge round. */
export interface StBridgeResultEnvelope {
  irisStExt: string
  type: 'bridge-result'
  token: string
  result: StBridgeResult
  error?: { message: string, stack?: string }
}

/** Shell → iframe: re-apply the locale table to the facade DOM. */
export interface StLocaleEnvelope {
  irisStExt: string
  type: 'locale'
  language: string
}

/** Shell → iframe: serialize the settings panel DOM for the settings-slot projection. */
export interface StSettingsProjectEnvelope {
  irisStExt: string
  type: 'settings-project'
}

/** Iframe → shell: the serialized `#extensions_settings` subtree, translated. */
export interface StSettingsHtmlEnvelope {
  irisStExt: string
  type: 'settings-html'
  html: string
  language: string
}

/** Shell → iframe: replay a projected interaction onto the real settings DOM. */
export interface StReplayEventEnvelope {
  irisStExt: string
  type: 'replay-event'
  path: string
  eventType: 'click' | 'change' | 'input'
  value?: string
}

/** Card → shell: a member-proxy call for the extension's own API. */
export interface StMemberCallEnvelope {
  irisStMemberProxy: string
  callId: string
  method: string
  args: unknown[]
}

/** Shell → iframe: run a member call against `globalThis.EjsTemplate`. */
export interface StMemberDispatchEnvelope {
  irisStExt: string
  type: 'member-call'
  callId: string
  method: string
  args: unknown[]
}

/** Iframe → shell: the member call's outcome. */
export interface StMemberResultEnvelope {
  irisStExt: string
  type: 'member-result'
  callId: string
  result?: unknown
  error?: string
}

/** Every shell→iframe message the kernel accepts, discriminated on `type`. */
export type StShellToFrame =
  | StBridgeMessage_Envelope
  | StChatOpenEnvelope
  | StLocaleEnvelope
  | StSettingsProjectEnvelope
  | StReplayEventEnvelope
  | StMemberDispatchEnvelope

/** Every iframe→shell message the plane accepts. */
export type StFrameToShell =
  | StReadyEnvelope
  | StSettingsPersistEnvelope
  | StSettingsHtmlEnvelope
  | StToastEnvelope
  | StErrorEnvelope
  | StBridgeResultEnvelope
  | StMemberResultEnvelope

/** True when `value` claims the pilot's postMessage channel with this token. */
export function isStFrameToShell(value: unknown, token: string): value is StFrameToShell {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['irisStExt'] === token && typeof record['type'] === 'string'
}

/** True when `value` claims the member-proxy channel with this token. */
export function isStMemberCall(value: unknown, token: string): value is StMemberCallEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['irisStMemberProxy'] === token
    && typeof record['callId'] === 'string'
    && typeof record['method'] === 'string'
    && Array.isArray(record['args'])
}

/**
 * The structural check the host bridge runs on every submitted generate
 * result. A shape that cannot be mapped back onto contributions is refused
 * with its reason rather than applied partially — a half-applied prompt
 * rewrite is worse than an unexpanded one because it is silent.
 */
export function validateGenerateResult(value: unknown, expectedCount: number): { ok: true } | { ok: false, why: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, why: 'result is not an object' }
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'generate') return { ok: false, why: 'result kind is not "generate"' }
  const messages = record['messages']
  if (!Array.isArray(messages)) return { ok: false, why: 'messages is not an array' }
  if (messages.length !== expectedCount) {
    return { ok: false, why: `messages length ${messages.length} does not match the ${expectedCount} contributions sent` }
  }
  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'object' || message === null) return { ok: false, why: `messages[${index}] is not an object` }
    const entry = message as Record<string, unknown>
    if (typeof entry['content'] !== 'string') return { ok: false, why: `messages[${index}].content is not a string` }
  }
  return { ok: true }
}

/** The reply-result check: a processed floor text plus the two variable layers. */
export function validateReplyResult(value: unknown): { ok: true } | { ok: false, why: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, why: 'result is not an object' }
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'reply') return { ok: false, why: 'result kind is not "reply"' }
  if (typeof record['mes'] !== 'string') return { ok: false, why: 'mes is not a string' }
  if (typeof record['chatVariables'] !== 'object' || record['chatVariables'] === null) {
    return { ok: false, why: 'chatVariables is not an object' }
  }
  if (typeof record['floorVariables'] !== 'object' || record['floorVariables'] === null) {
    return { ok: false, why: 'floorVariables is not an object' }
  }
  return { ok: true }
}
