/**
 * How a card reaches the composer.
 *
 * Upstream's cards send messages by writing `#send_textarea`'s value and
 * clicking `#send_but`, and 44 measured that path in nine cards — eight of them
 * from **interface** code. It is a card function SillyTavern has, so Iris serves
 * it rather than refusing; what Iris adds is that it is visible in the panel.
 *
 * A module-scope holder, for the reasons `card-bus.ts` gives for the same shape:
 * the composer re-renders on every keystroke, so threading a live handle through
 * it is how a stale closure gets to submit into a chat that has already closed;
 * and this is not state — it is a capability whose lifetime is exactly one
 * mounted composer.
 *
 * **The direction is the interesting part.** Everything else a card asks for
 * goes to the host: it is data the host owns. This one asks the *shell* to do
 * something it owns, so it never reaches the wire — `card-api.ts` keeps it in
 * `SHELL_ACTIONS` for exactly that reason, and the store answers it before the
 * host lookup rather than after.
 *
 * @module iris-web/app/composer-bus
 */

/** What the composer can be asked to do, and what it says happened. */
export interface ComposerReach {
  /**
   * Put text in the field.
   *
   * Not "send this text": the two measured variants disagree about what happens
   * between the write and the click — one dispatches events and waits 300 ms,
   * the other clicks immediately — so the write and the send have to be separate
   * requests, exactly as they are upstream.
   */
  setDraft: (text: string) => void
  /**
   * Send what the field currently holds.
   *
   * @returns why nothing was sent, or undefined when it was. The caller is a
   * card, and "it did not happen" has to be reportable rather than silent.
   */
  send: () => string | undefined
}

/** The mounted composer, or nothing when none is mounted. */
let current: ComposerReach | undefined

/**
 * Register the mounted composer.
 * @param reach - how to drive it.
 * @returns a disposer that clears it **only if it is still the current one**,
 *   for the reason `card-bus.ts` records: a late teardown from a previous
 *   composer would otherwise silence the one that replaced it, and the two
 *   orders are indistinguishable from inside a cleanup function.
 */
export function registerComposer(reach: ComposerReach): () => void {
  current = reach
  return () => {
    if (current === reach) current = undefined
  }
}

/**
 * Put text in the composer on a card's behalf.
 * @param text - what the card wrote to `#send_textarea.value`.
 * @returns why it did not land, or undefined when it did.
 */
export function draftThroughComposer(text: string): string | undefined {
  if (current === undefined) return 'no composer is mounted in this chat'
  current.setDraft(text)
  return undefined
}

/**
 * Send the composer's contents on a card's behalf.
 * @returns why nothing was sent, or undefined when a message went.
 */
export function sendThroughComposer(): string | undefined {
  if (current === undefined) return 'no composer is mounted in this chat'
  return current.send()
}
