/**
 * How a window event dispatched in one card frame reaches the others.
 *
 * Upstream's page window is the shared event target: any of a card's frames can
 * `addEventListener` on it, any can `dispatchEvent` onto it, and both see the
 * same traffic because there is exactly one page. Iris's frames each hold a
 * stand-in for that window, and no opaque origin can reach into another — so the
 * road between them runs through the shell, which talks to every frame already.
 *
 * A module-scope holder, for the reason `card-bus.ts` is: the frame families are
 * owned by hooks that re-render constantly, and a live fan-out point cannot be
 * state or a prop without going stale in one of them. The set holds one sink per
 * family — the card's script frames, and the chat's message frames — so a
 * dispatch from either half reaches both, which is what one page meant.
 *
 * @module iris-web/app/window-events
 */

/** Deliver one window event to every frame a sink owns. */
export type WindowEventSink = (event: string, args: readonly unknown[]) => void

/** The sinks currently attached, in registration order. */
const sinks = new Set<WindowEventSink>()

/**
 * Register one family's sink.
 * @param sink - how to reach the family's frames.
 * @returns a disposer that removes exactly this sink; a stale teardown from a
 *   replaced family must not silence the one that succeeded it.
 */
export function registerWindowEventSink(sink: WindowEventSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/**
 * Fan one dispatched event out to every frame of the card.
 *
 * The listener-facing shape is built here rather than at the sender, so every
 * dispatch — whatever frame it came from — hands listeners the same one
 * argument: an object carrying the `type` and `detail` a DOM `CustomEvent`
 * reader expects.
 * @param event - the event's `type`, as the dispatching card named it.
 * @param detail - the `detail` the dispatching card attached, if any.
 */
export function broadcastWindowEvent(event: string, detail: unknown): void {
  const args = [{ type: event, detail }] as const
  for (const sink of [...sinks]) sink(event, args)
}
