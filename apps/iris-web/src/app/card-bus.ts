/**
 * How the interface reaches the card's running scripts.
 *
 * Everything else in this direction flows the other way — the host pushes events
 * at the frames and the frames ask the host for things. A button press is the
 * first case of the **interface itself** needing to say something to a card, and
 * it has no existing road: the running set is owned by `useCardScripts`, and the
 * composer that renders the buttons is nowhere near it.
 *
 * A module-scope holder rather than a prop threaded down or a field on the
 * store. Threading it would mean carrying a live handle through a component that
 * re-renders on every keystroke, which is how a stale closure gets to emit into
 * a frame that has already been torn down. Putting it in the store would make it
 * state, and it is not state — it is an object with a lifetime exactly equal to
 * one run of one card's scripts, which is precisely the lifetime the hook
 * already manages.
 *
 * **One at a time, deliberately.** Iris runs one card's scripts — the foreground
 * chat's — so a second registration means the first set is gone, not that two
 * sets are live. Registering returns the disposer, and the hook calls it on
 * teardown so a press after a chat closes reaches nothing rather than reaching
 * the previous card.
 *
 * @module iris-web/app/card-bus
 */

/** Send an event to every frame of the running card. */
export type CardEmitter = (event: string, args: readonly unknown[]) => void

/** The current card's emitter, or nothing when no card is running. */
let current: CardEmitter | undefined

/**
 * Register the running card's emitter.
 *
 * @param emitter - how to reach this card's frames.
 * @returns a disposer that clears it, but **only if it is still the current
 * one**. Without that check a late teardown from a previous card would silence
 * the card that replaced it — the two orders are indistinguishable from inside
 * a cleanup function, and the wrong one leaves buttons that do nothing.
 */
export function registerCardEmitter(emitter: CardEmitter): () => void {
  current = emitter
  return () => {
    if (current === emitter) current = undefined
  }
}

/**
 * Emit into the running card, if there is one.
 *
 * @param event - the event name; for a button, the id both sides computed.
 * @param args - the payload, empty for a button press.
 * @returns whether anything was listening — that is, whether a card is running
 * at all. The caller reports a `false` rather than dropping it: a press that
 * reached nothing looks exactly like a press that reached a card with no
 * listener, and only one of those is worth telling somebody about.
 */
export function emitToCard(event: string, args: readonly unknown[] = []): boolean {
  if (current === undefined) return false
  current(event, args)
  return true
}
