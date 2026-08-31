/**
 * The Tavern Helper API as a card sees it, implemented over a snapshot.
 *
 * The host's `createTavernHelper` cannot run here. Its `TavernHelperHost` wants
 * a live `Session` and `VariableStore`, and neither crosses an opaque origin —
 * so this is a second implementation of the same surface, not a re-export of
 * the first. What the two share is the *vocabulary*: the event tables and the
 * bus come from `@iris/compat-tavernhelper-core`, because a card compares
 * against `tavern_events.MESSAGE_RECEIVED` by value and a table that drifted by
 * one character would make its listener silently never fire.
 *
 * The split between what is answered here and what travels is not a preference.
 * Measured against MVU's own source, the read family is called synchronously —
 * `deleteVariable(getLastMessageId(), ...)` passes the result straight in as an
 * argument, so it has to be a number and not a promise — while every write is
 * `await`ed. Reads therefore have to come from the pushed snapshot, and writes
 * are free to be what they already are: asynchronous calls to the host.
 *
 * @module iris-web/sandbox/tavern-helper
 */
import {
  EventBus,
  IFRAME_EVENTS,
  MVU_EVENTS,
  TAVERN_EVENTS,
  type Listener,
} from '@iris/compat-tavernhelper-core'
import type { ScriptChatMessage, ScriptContext } from '@iris/protocol'

import { UnsupportedApiError } from './errors.ts'

/** A scope selector, in the shape upstream's cards pass it. */
export interface VariableOption {
  type?: string
  message_id?: number | string
  script_id?: string
}

/** What the frame's Tavern Helper needs from the frame around it. */
export interface TavernHelperFrameHost {
  /**
   * The snapshot, read per call rather than captured.
   *
   * A later `context` message replaces it, and a member that closed over the
   * first one would keep answering from a chat the user has already left.
   */
  context: () => ScriptContext | undefined
  /** Which entry of `script.list` is running. */
  scriptId: () => string | undefined
  /** Ask the host to do something the frame cannot. */
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Run a slash command through the host's parser. */
  triggerSlash: (command: string) => Promise<string>
  /** The bus shared with the shell's forwarding. */
  events: EventBus
}

/**
 * Resolve upstream's message range against a chat length.
 *
 * Deliberately mirrors the host's `resolveRange`, including the clamping: a
 * card asking for message 500 of a 12-message chat gets the last one rather
 * than an error, because that is what it gets upstream.
 * @param range - an index, a `'start-end'` span, or `'all'`.
 * @param length - how many messages there are.
 * @returns the indices to return, in ascending order.
 */
export function resolveRange(range: string | number, length: number): number[] {
  const clamp = (value: number): number =>
    Math.min(Math.max(value < 0 ? length + value : value, 0), length - 1)

  if (typeof range === 'number') return length === 0 ? [] : [clamp(range)]
  if (range === 'all') return Array.from({ length }, (_unused, index) => index)

  // Scanned rather than matched with a pattern. The separator and the sign are
  // the same character, so the only interesting position is the first dash that
  // is not a leading sign — which an index finds directly.
  //
  // `isIndex` is what keeps this identical to the host's `-?\d+`. Testing with
  // `Number.isFinite` instead would quietly widen the grammar: `1.5-2` and
  // `1e2-3` both parse as finite numbers, and the host rejects both.
  const isIndex = (part: string): boolean => {
    const digits = part.startsWith('-') ? part.slice(1) : part
    return digits.length > 0 && [...digits].every(character => character >= '0' && character <= '9')
  }

  const text = range.trim()
  const dash = text.indexOf('-', text.startsWith('-') ? 1 : 0)
  if (dash > 0) {
    const lowText = text.slice(0, dash).trim()
    const highText = text.slice(dash + 1).trim()
    if (isIndex(lowText) && isIndex(highText)) {
      const low = Number(lowText)
      const high = Number(highText)
      if (length === 0) return []
      const from = clamp(low)
      const to = clamp(high)
      const [first, last] = from <= to ? [from, to] : [to, from]
      return Array.from({ length: last - first + 1 }, (_unused, index) => first + index)
    }
  }

  const single = Number(text)
  if (!Number.isFinite(single)) throw new Error(`getChatMessages: unrecognized range "${range}"`)
  return length === 0 ? [] : [clamp(single)]
}

/**
 * Build the flattened Tavern Helper surface for one frame.
 * @param host - what the frame can offer.
 * @returns every name a card expects, ready to publish.
 */
export function createFrameTavernHelper(host: TavernHelperFrameHost): Record<string, unknown> {
  /** The snapshot, or a refusal naming the member that needed it. */
  const snapshot = (member: string): ScriptContext => {
    const context = host.context()
    if (context === undefined) {
      throw new UnsupportedApiError(member, 'The host snapshot has not arrived yet.')
    }
    return context
  }

  const chatOf = (member: string): ScriptChatMessage[] => snapshot(member).chat

  /**
   * Reads are answered from the snapshot, which holds one scope: the current
   * message's variables. Anything else is refused by name rather than answered
   * with an empty object — empty reads as "nothing set yet", and MVU responds to
   * that by re-initialising, which would overwrite live state with defaults.
   */
  const readVariables = (member: string, option?: VariableOption): Record<string, unknown> => {
    const type = option?.type ?? 'message'
    if (type !== 'message') {
      throw new UnsupportedApiError(
        `${member}({type:'${type}'})`,
        'The frame snapshot carries the message scope only.',
      )
    }
    return snapshot(member).variables
  }

  /**
   * Every write goes to the host and nowhere else.
   *
   * Not applied to a local copy first. An optimistic copy would answer the next
   * read with a value the host may have rejected, and a card that writes then
   * reads — which MVU does within one turn — would be told its write succeeded
   * before anyone had agreed to it.
   */
  const write = async (member: string, params: Record<string, unknown>): Promise<void> => {
    // Card-facing name, not a wire method: the shell owns that mapping and is the
    // side that enforces it. `setVariables` is not in `CARD_METHODS` yet because
    // the protocol has no `script.setVariables`, so this refuses — by name, from
    // the shell, saying which member a card reached for.
    //
    // Deliberately not caught and reworded. A hint invented here would claim to
    // know why the call failed, and would go on claiming it after the method
    // exists and the failure means something else.
    await host.call('setVariables', { member, ...params })
  }

  const events = host.events

  /**
   * Refuse an event name that is not a string.
   *
   * `eventOn(tavern_events.SOMETHING_MISSING, fn)` passes `undefined` when the
   * table has no such key, and a bus keyed by string would register that under
   * `"undefined"` — a listener that is live, reachable, and can never fire. That
   * is the exact failure the shared vocabulary exists to prevent, so it is worth
   * catching even when the table is right: a card may name an event the table
   * never claimed to carry.
   * @param member - the member being called, for the message.
   * @param event - whatever the card passed as an event name.
   * @returns the event name, once it is known to be one.
   */
  const eventName = (member: string, event: unknown): string => {
    if (typeof event !== 'string' || event.length === 0) {
      throw new UnsupportedApiError(
        `${member}(${String(event)})`,
        'An event name must be a non-empty string. A missing table entry reads as undefined here.',
      )
    }
    return event
  }

  const api: Record<string, unknown> = {
    // ── reads, answered here because their callers do not await ──────────
    getVariables: (option?: VariableOption) => readVariables('getVariables', option),
    getAllVariables: (option?: VariableOption) => readVariables('getAllVariables', option),
    getLastMessageId: (): number => chatOf('getLastMessageId').length - 1,
    /**
     * Which message this frame belongs to.
     *
     * The last one, until cards render inside a message rather than in the
     * probe. Upstream answers with the frame's own floor, so this needs
     * revisiting when that pipeline lands.
     */
    getCurrentMessageId: (): number => chatOf('getCurrentMessageId').length - 1,
    getScriptId: (): string | undefined => host.scriptId(),
    getChatMessages: (
      range: string | number,
      options?: { include_swipes?: boolean },
    ): ScriptChatMessage[] => {
      const chat = chatOf('getChatMessages')
      return resolveRange(range, chat.length).flatMap(index => {
        const message = chat[index]
        if (message === undefined) return []
        if (options?.include_swipes !== true) return [message]
        // One entry per swipe when asked, not one entry carrying an array:
        // cards index the result directly.
        const swipes = message.swipes
        if (swipes === undefined) return [message]
        return swipes.map(text => ({ ...message, mes: text }))
      })
    },
    getSwipes: (messageId?: number): string[] => {
      const chat = chatOf('getSwipes')
      const at = messageId ?? chat.length - 1
      return chat[at]?.swipes ?? []
    },

    // ── writes, which their callers already await ────────────────────────
    replaceVariables: async (variables: Record<string, unknown>, option?: VariableOption) =>
      write('replaceVariables', { variables, option: option ?? {} }),
    insertOrAssignVariables: async (variables: Record<string, unknown>, option?: VariableOption) =>
      write('insertOrAssignVariables', { variables, option: option ?? {} }),
    insertVariables: async (variables: Record<string, unknown>, option?: VariableOption) =>
      write('insertVariables', { variables, option: option ?? {} }),
    deleteVariable: async (path: unknown, option?: VariableOption) =>
      write('deleteVariable', { path, option: option ?? {} }),
    /**
     * The updater is a function, so it cannot travel. It runs here against the
     * snapshot and the *result* is what the host is asked to store — which is
     * how MVU uses it anyway: every call is awaited, and the value it builds is
     * the whole variable tree rather than a delta.
     */
    updateVariablesWith: async (
      updater: (variables: Record<string, unknown>) => Record<string, unknown>,
      option?: VariableOption,
    ) => {
      const next = updater(structuredClone(readVariables('updateVariablesWith', option)))
      return write('replaceVariables', { variables: next, option: option ?? {} })
    },
    swipeTo: async (messageId: number, swipeId: number) =>
      host.call('swipeTo', { messageId, swipeId }),

    // ── host capabilities that were already asynchronous ─────────────────
    generate: async (config: Record<string, unknown>): Promise<unknown> =>
      host.call('generateRaw', config),
    triggerSlash: async (command: string): Promise<string> => host.triggerSlash(command),
    /**
     * Upstream's spelling, kept wrong on purpose — cards call it.
     *
     * Returns the text unexpanded. The macro engine is host-side and this member
     * is synchronous, so there is nothing to expand with; the host's own
     * implementation falls back to exactly this when no engine is wired, which is
     * the behaviour to match rather than invent a second one.
     */
    substidudeMacros: (text: string): string => text,

    // ── the event family, on the bus the shell forwards into ─────────────
    eventOn: (event: string, listener: Listener) =>
      events.eventOn(eventName('eventOn', event), listener),
    eventOnce: (event: string, listener: Listener) =>
      events.eventOnce(eventName('eventOnce', event), listener),
    eventMakeFirst: (event: string, listener: Listener) =>
      events.eventMakeFirst(eventName('eventMakeFirst', event), listener),
    eventMakeLast: (event: string, listener: Listener) =>
      events.eventMakeLast(eventName('eventMakeLast', event), listener),
    eventEmit: async (event: string, ...args: unknown[]) =>
      events.eventEmit(eventName('eventEmit', event), ...args),
    eventRemoveListener: (event: string, listener: Listener) =>
      events.eventRemoveListener(eventName('eventRemoveListener', event), listener),
    eventClearEvent: (event: string) => events.eventClearEvent(eventName('eventClearEvent', event)),
    eventClearListener: (listener: Listener) => events.eventClearListener(listener),
    eventClearAll: () => events.eventClearAll(),
    iframe_events: IFRAME_EVENTS,
    tavern_events: TAVERN_EVENTS,
    mvu_events: MVU_EVENTS,
  }

  // Upstream exposes the same members twice: bare, and under `TavernHelper`.
  // Both spellings appear in real cards, so both have to resolve.
  api['TavernHelper'] = { ...api }
  return api
}
