/**
 * One script's view of its card's event bus.
 *
 * A card's scripts share a bus — that is how one script's work becomes another's
 * input, and `eventEmit` reaching every sibling is the point. What they must not
 * share is **teardown**. Upstream keys its listener registry by iframe name and
 * `eventClearAll` deletes only that frame's entry, fired on `pagehide`, so a
 * script's listeners die with the script and can never touch a sibling's. With
 * one frame per card that guarantee is gone unless it is rebuilt here.
 *
 * The failure it prevents is quiet in the worst way: a script calling
 * `eventClearAll` would silently unhook its siblings, and the only symptom is an
 * event that stops arriving — which reads as an event that was never emitted.
 *
 * The shared `EventBus` has no owners and is not this package's to change, so
 * ownership lives in the wrapper: every registration is recorded against the
 * script that made it, and every clearing operation is intersected with that
 * record before it reaches the bus.
 *
 * @module iris-web/sandbox/scoped-events
 */
import type { EventBus, Listener, Subscription } from '@iris/compat-tavernhelper-core'

/** The event members, bound to one script. */
export interface ScopedEvents {
  eventOn: (event: string, listener: Listener) => Subscription
  eventOnce: (event: string, listener: Listener) => Subscription
  eventMakeFirst: (event: string, listener: Listener) => Subscription
  eventMakeLast: (event: string, listener: Listener) => Subscription
  eventRemoveListener: (event: string, listener: Listener) => void
  eventClearEvent: (event: string) => void
  eventClearListener: (listener: Listener) => void
  eventClearAll: () => void
}

/**
 * Give one script its own registration and teardown over a shared bus.
 *
 * @param events - the card's bus, shared by every script.
 * @param guard - validates an event name, so a missing table entry is refused
 *   rather than registered under the string `"undefined"`.
 * @returns the eight members whose reach must stop at this script.
 */
export function scopedEvents(
  events: EventBus,
  guard: (member: string, event: unknown) => string,
): ScopedEvents {
  /** What this script registered, so teardown can be limited to it. */
  const mine = new Map<string, Set<Listener>>()

  /**
   * The bus's own handles for what this script registered, so a clear can
   * remove what the bus actually holds.
   *
   * Needed for `eventOnce`, and found by the sandbox-plugin teardown test: the
   * bus registers a **wrapper** for a once-listener, so removing by the card's
   * own function finds nothing, and `eventClearAll` left every unfired
   * once-listener on the bus. Upstream's `pagehide` clear takes everything the
   * iframe registered, once-listeners included, so the clears here stop each
   * registration's bus handle rather than removing by function.
   */
  const handles = new Map<string, Map<Listener, Subscription[]>>()

  const remember = (event: string, listener: Listener, handle?: Subscription): void => {
    const slot = mine.get(event) ?? new Set<Listener>()
    slot.add(listener)
    mine.set(event, slot)
    if (handle === undefined) return
    const byListener = handles.get(event) ?? new Map<Listener, Subscription[]>()
    byListener.set(listener, [...byListener.get(listener) ?? [], handle])
    handles.set(event, byListener)
  }

  /**
   * Remove one of this script's listeners from the bus, through each of its
   * registrations' handles.
   * @param event - the event.
   * @param listener - the card's own function.
   */
  const detach = (event: string, listener: Listener): void => {
    const byListener = handles.get(event)
    const held = byListener?.get(listener) ?? []
    // One removal per registration, through its own handle. Removing by
    // function as well would take a sibling's registration of the same
    // function object, since the bus removes the first match it finds.
    if (held.length === 0) events.eventRemoveListener(event, listener)
    for (const handle of held) handle.stop()
    byListener?.delete(listener)
    if (byListener?.size === 0) handles.delete(event)
  }

  const forget = (event: string, listener: Listener): void => {
    const slot = mine.get(event)
    if (slot === undefined) return
    slot.delete(listener)
    if (slot.size === 0) mine.delete(event)
    // The handles go with the record, so a later clear cannot stop a handle
    // whose removal (by function, on the bus) would now hit a sibling.
    const byListener = handles.get(event)
    byListener?.delete(listener)
    if (byListener?.size === 0) handles.delete(event)
  }

  const register = (
    member: string,
    add: (event: string, listener: Listener) => Subscription,
  ): ((event: string, listener: Listener) => Subscription) => {
    return (event, listener) => {
      const name = guard(member, event)
      const subscription = add(name, listener)
      remember(name, listener, subscription)
      // The handle also forgets, so a card that stops its own subscription does
      // not leave this record claiming a listener the bus no longer holds.
      return {
        stop: () => {
          forget(name, listener)
          subscription.stop()
        },
      }
    }
  }

  return {
    eventOn: register('eventOn', (event, listener) => events.eventOn(event, listener)),
    /*
     * `eventOnce` is recorded like any other, and deliberately not un-recorded
     * when it fires. A stale entry costs one wasted removal at teardown.
     *
     * The bus itself already wraps a once-listener, so the function it holds
     * is not the card's. The clears reach that wrapper through the bus's own
     * handle (`detach`). `eventRemoveListener(event, listener)` still removes
     * by the card's function only and so misses an unfired once-listener, as
     * the bus always has; that member is left as it was (a parity question,
     * not a teardown one).
     */
    eventOnce: register('eventOnce', (event, listener) => events.eventOnce(event, listener)),
    eventMakeFirst: register('eventMakeFirst', (event, listener) =>
      events.eventMakeFirst(event, listener),
    ),
    eventMakeLast: register('eventMakeLast', (event, listener) =>
      events.eventMakeLast(event, listener),
    ),

    eventRemoveListener: (event, listener) => {
      const name = guard('eventRemoveListener', event)
      forget(name, listener)
      events.eventRemoveListener(name, listener)
    },

    /**
     * Clear this script's listeners for one event, not the card's.
     *
     * The bus's own `eventClearEvent` deletes the whole slot, which would take
     * every sibling's listener with it.
     */
    eventClearEvent: event => {
      const name = guard('eventClearEvent', event)
      for (const listener of mine.get(name) ?? []) detach(name, listener)
      mine.delete(name)
    },

    eventClearListener: listener => {
      for (const [event, listeners] of [...mine]) {
        if (!listeners.has(listener)) continue
        detach(event, listener)
        forget(event, listener)
      }
    },

    /** What upstream fires on `pagehide`: everything *this* script registered. */
    eventClearAll: () => {
      for (const [event, listeners] of [...mine]) {
        for (const listener of listeners) detach(event, listener)
      }
      mine.clear()
    },
  }
}
