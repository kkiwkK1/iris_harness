/**
 * The event vocabulary card scripts listen on.
 *
 * Every string here is copied verbatim from the upstream tables, because a card
 * subscribes by literal name. Two of them are traps worth calling out: the
 * SillyTavern value of `GENERATION_AFTER_COMMANDS` is **uppercase**, unlike
 * every neighbour, and `CHARACTER_DELETED` / `CHARACTER_MANAGEMENT_DROPDOWN`
 * are camelCase. Normalizing any of them would silently break the cards that
 * depend on them.
 *
 * @module @iris/compat-tavernhelper/events
 */

/** Tavern Helper's own events, the ones it emits rather than relays. */
export const IFRAME_EVENTS = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
} as const

/** The SillyTavern events cards rely on most. */
export const TAVERN_EVENTS = {
  APP_READY: 'app_ready',
  CHAT_CHANGED: 'chat_id_changed',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_SWIPED: 'message_swiped',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  /** Uppercase on the wire — an upstream inconsistency that cards depend on. */
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATE_AFTER_DATA: 'generate_after_data',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  PERSONA_CHANGED: 'persona_changed',
  /** camelCase on the wire, unlike its neighbours. */
  CHARACTER_DELETED: 'characterDeleted',
  /** camelCase on the wire, unlike its neighbours. */
  CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
} as const

/** MVU's events. The shipped bundle emits these spellings. */
export const MVU_EVENTS = {
  /**
   * Note the spelling. Tavern Helper's type declaration says
   * `mag_variable_initiailized`; the published MVU bundle emits
   * `mag_variable_initialized`. The bundle is what actually fires, so it wins.
   */
  VARIABLE_INITIALIZED: 'mag_variable_initialized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
  /** Deprecated upstream, still listened for by older cards. */
  VARIABLE_UPDATED: 'mag_variable_updated',
  INVOKE_MVU_PROCESS: 'mag_invoke_mvu',
  UPDATE_VARIABLE: 'mag_update_variable',
} as const

/** A listener, whose arguments depend on the event. */
export type Listener = (...args: never[]) => unknown

/** What `eventOn` hands back. */
export interface Subscription {
  stop(): void
}

/**
 * The event bus card scripts see.
 *
 * Emission awaits each listener in registration order. Cards use this to
 * *repair* data mid-flight — the canonical example is a `mag_command_parsed`
 * listener rewriting the command array to undo a model's mangling of CJK
 * names — so listeners must be able to mutate the arguments they are given and
 * must not run concurrently.
 */
export class EventBus {
  readonly #listeners = new Map<string, Listener[]>()

  /** Listeners for one event, created on demand. */
  #slot(event: string): Listener[] {
    const existing = this.#listeners.get(event)
    if (existing !== undefined) return existing
    const created: Listener[] = []
    this.#listeners.set(event, created)
    return created
  }

  /**
   * Subscribe.
   * @param event - event name.
   * @param listener - called with the event's arguments.
   * @returns a handle that removes the subscription.
   */
  eventOn(event: string, listener: Listener): Subscription {
    this.#slot(event).push(listener)
    return { stop: () => this.eventRemoveListener(event, listener) }
  }

  /**
   * Subscribe for one emission.
   * @param event - event name.
   * @param listener - called at most once.
   * @returns a handle that removes the subscription.
   */
  eventOnce(event: string, listener: Listener): Subscription {
    const wrapper: Listener = (...args) => {
      this.eventRemoveListener(event, wrapper)
      return listener(...args)
    }
    return this.eventOn(event, wrapper)
  }

  /**
   * Subscribe ahead of everyone already listening.
   * @param event - event name.
   * @param listener - called first.
   * @returns a handle that removes the subscription.
   */
  eventMakeFirst(event: string, listener: Listener): Subscription {
    this.#slot(event).unshift(listener)
    return { stop: () => this.eventRemoveListener(event, listener) }
  }

  /**
   * Subscribe behind everyone already listening.
   * @param event - event name.
   * @param listener - called last.
   * @returns a handle that removes the subscription.
   */
  eventMakeLast(event: string, listener: Listener): Subscription {
    return this.eventOn(event, listener)
  }

  /**
   * Emit, awaiting each listener in turn.
   * @param event - event name.
   * @param args - listener arguments; a listener may mutate them in place.
   */
  async eventEmit(event: string, ...args: unknown[]): Promise<void> {
    // A copy, so a listener unsubscribing mid-emission cannot skip its neighbour.
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      await (listener as (...values: unknown[]) => unknown)(...args)
    }
  }

  /**
   * Remove one subscription.
   * @param event - event name.
   * @param listener - the function originally registered.
   */
  eventRemoveListener(event: string, listener: Listener): void {
    const slot = this.#listeners.get(event)
    if (slot === undefined) return
    const index = slot.indexOf(listener)
    if (index >= 0) slot.splice(index, 1)
  }

  /**
   * Remove every subscription for one event.
   * @param event - event name.
   */
  eventClearEvent(event: string): void {
    this.#listeners.delete(event)
  }

  /**
   * Remove one function from every event it listens to.
   * @param listener - the function to unregister.
   */
  eventClearListener(listener: Listener): void {
    for (const event of this.#listeners.keys()) this.eventRemoveListener(event, listener)
  }

  /**
   * Remove everything.
   *
   * A card's iframe calls this on `pagehide`; Iris calls it when the script's
   * plugin unloads, which is the guarantee SillyTavern cannot make.
   */
  eventClearAll(): void {
    this.#listeners.clear()
  }
}
