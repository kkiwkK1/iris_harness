/**
 * The `TavernHelper` object a card script sees.
 *
 * Names, argument shapes and misspellings are compatibility surface, not
 * design. `substitudeMacros` is spelled that way upstream and cards call it
 * that way, so it is spelled that way here; "fixing" it would break them.
 *
 * What Iris changes is not the API but where it runs. Upstream flattens this
 * object onto a same-origin iframe's `window`, which means a card script has
 * unrestricted access to the parent page. Iris keeps the same names and hands
 * them to a sandbox, so the surface a card sees is identical while what it can
 * reach is not.
 *
 * @module @iris/compat-tavernhelper/api
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { listCandidates, selectCandidate, selectedCandidate } from '@iris/chat'
import type { DeleteResult, VariableOption, Variables, VariableStore } from '@iris/variables'

import {
  chatMessages,
  selectMessages,
  type ChatMessage,
  type ChatMessageSwiped,
  type GetChatMessagesOptions,
  type SpeakerNames,
} from './chat-messages.ts'
import { EventBus, IFRAME_EVENTS, MVU_EVENTS, TAVERN_EVENTS, type Listener, type Subscription } from './events.ts'

/** What a generation request carries. */
export interface GenerateConfig {
  user_input?: string
  should_stream?: boolean
  [key: string]: unknown
}

/** Capabilities the host supplies; anything absent becomes an honest refusal. */
export interface TavernHelperHost {
  session: Session
  variables: VariableStore
  names: SpeakerNames
  events?: EventBus
  /** Run a generation on the card's behalf. */
  generate?: (config: GenerateConfig) => Promise<string>
  /** Run a slash command; returns the piped result. */
  triggerSlash?: (command: string) => Promise<string>
  /** Expand `{{macros}}` in text. */
  substituteMacros?: (text: string) => string
  /** Identity of the script calling in, when there is one. */
  scriptId?: string
  /** The message a card's iframe is rendering inside, when there is one. */
  currentMessageId?: () => number
}

/** Raised when a card reaches for something Iris does not implement yet. */
export class UnsupportedApiError extends Error {
  constructor(name: string) {
    super(`TavernHelper.${name} is not implemented in Iris yet`)
    this.name = 'UnsupportedApiError'
  }
}

/** The API object plus the pieces the sandbox binds per call site. */
export interface TavernHelperApi {
  /** Context-free members, copied onto a card's global scope as-is. */
  api: Record<string, unknown>
  /**
   * Members whose behaviour depends on *who* is calling.
   *
   * Upstream keeps these under `TavernHelper._bind` with an underscore prefix,
   * binds each to the calling window and re-exposes it without the prefix.
   * That indirection is how `getVariables({type:'script'})` knows which script
   * asked, and it has to be reproduced for scoped calls to resolve.
   */
  bound: Record<string, unknown>
  events: EventBus
}

/**
 * Build the Tavern Helper API over one chat.
 * @param host - the capabilities this deployment can offer a card.
 * @returns the API object, the context-bound half, and the event bus.
 */
export function createTavernHelper(host: TavernHelperHost): TavernHelperApi {
  const events = host.events ?? new EventBus()
  const { session, variables, names } = host

  /** Every message, rebuilt per call — the log is the source of truth. */
  const allMessages = (): ChatMessageSwiped[] => chatMessages(session, variables, names)

  /** Default a scope selector to the calling script when it omits one. */
  const withScript = (option: VariableOption): VariableOption =>
    (option.type === 'script' && option.script_id === undefined && host.scriptId !== undefined
      ? { ...option, script_id: host.scriptId }
      : option)

  const api: Record<string, unknown> = {
    // ── variables ────────────────────────────────────────────────────────
    replaceVariables: (values: Variables, option: VariableOption): void =>
      variables.replaceVariables(values, withScript(option)),
    updateVariablesWith: (updater: (values: Variables) => Variables, option: VariableOption): Variables =>
      variables.updateVariablesWith(updater, withScript(option)),
    insertOrAssignVariables: (values: Variables, option: VariableOption): Variables =>
      variables.insertOrAssignVariables(values, withScript(option)),
    insertVariables: (values: Variables, option: VariableOption): Variables =>
      variables.insertVariables(values, withScript(option)),
    deleteVariable: (path: string, option: VariableOption): DeleteResult =>
      variables.deleteVariable(path, withScript(option)),

    // ── chat messages ────────────────────────────────────────────────────
    getChatMessages: (
      range: string | number,
      options?: GetChatMessagesOptions,
    ): (ChatMessage | ChatMessageSwiped)[] => selectMessages(allMessages(), range, options),
    getLastMessageId: (): number => allMessages().length - 1,

    // ── swipes ───────────────────────────────────────────────────────────
    getSwipes: (turn: number) => ({
      swipes: listCandidates(session, turn).map(candidate => candidate.message),
      swipe_id: selectedCandidate(session, turn)?.index ?? 0,
    }),
    swipeTo: (turn: number, index: number) => selectCandidate(session, turn, index),

    // ── events ───────────────────────────────────────────────────────────
    eventOn: (event: string, listener: Listener): Subscription => events.eventOn(event, listener),
    eventOnce: (event: string, listener: Listener): Subscription => events.eventOnce(event, listener),
    eventMakeFirst: (event: string, listener: Listener): Subscription => events.eventMakeFirst(event, listener),
    eventMakeLast: (event: string, listener: Listener): Subscription => events.eventMakeLast(event, listener),
    eventEmit: (event: string, ...args: unknown[]): Promise<void> => events.eventEmit(event, ...args),
    eventRemoveListener: (event: string, listener: Listener): void => events.eventRemoveListener(event, listener),
    eventClearEvent: (event: string): void => events.eventClearEvent(event),
    eventClearListener: (listener: Listener): void => events.eventClearListener(listener),
    eventClearAll: (): void => events.eventClearAll(),

    // ── name tables ──────────────────────────────────────────────────────
    iframe_events: IFRAME_EVENTS,
    tavern_events: TAVERN_EVENTS,
    mvu_events: MVU_EVENTS,

    // ── host-provided, refused when this deployment cannot offer them ────
    generate: (config: GenerateConfig): Promise<string> => {
      if (host.generate === undefined) throw new UnsupportedApiError('generate')
      return host.generate(config)
    },
    triggerSlash: (command: string): Promise<string> => {
      if (host.triggerSlash === undefined) throw new UnsupportedApiError('triggerSlash')
      return host.triggerSlash(command)
    },
    /** Upstream's spelling. Cards call it; it stays misspelled on purpose. */
    substitudeMacros: (text: string): string => host.substituteMacros?.(text) ?? text,
  }

  const bound: Record<string, unknown> = {
    /**
     * Scope-aware read. Bound rather than plain because a bare
     * `getVariables({type:'script'})` has to resolve to the caller's own store.
     */
    getVariables: (option: VariableOption): Variables => variables.getVariables(withScript(option)),
    getAllVariables: (option?: VariableOption): Variables => variables.getAllVariables(option),
    getScriptId: (): string | undefined => host.scriptId,
    getCurrentMessageId: (): number => host.currentMessageId?.() ?? allMessages().length - 1,
  }

  return { api, bound, events }
}

/**
 * Flatten the API onto one scope object, the way a card sees it.
 *
 * Upstream copies every `TavernHelper` member onto the iframe's `window` and
 * strips the `_` prefix from the bound half. A card therefore calls
 * `getVariables(...)` bare, not `TavernHelper.getVariables(...)`, and both
 * spellings have to work.
 * @param helper - the built API.
 * @returns one object carrying every global a card expects.
 */
export function flattenForCard(helper: TavernHelperApi): Record<string, unknown> {
  return { ...helper.api, ...helper.bound, TavernHelper: { ...helper.api, _bind: helper.bound } }
}
