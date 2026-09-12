/**
 * The name a script button's press is emitted under.
 *
 * Upstream has no separate event type for buttons: the button's **id is** the
 * event name, and the two sides compute it independently
 * (`store/iframe_runtimes/script.ts:6-8` builds it for the bar,
 * `function/script.ts:54-56` builds it for the card). They are expected to
 * agree, and nothing checks that they do.
 *
 * That is why this lives in one module rather than being inlined at both ends.
 * The failure mode when they disagree is the quietest one available: the card
 * registered a listener, the bar emitted an event, both succeeded, and the
 * handler is never called. There is no error to catch and no symptom except a
 * button that does nothing.
 *
 * The hash itself is imported, not written. `cyrb53` was already present twice
 * in this repo when this member needed it, and adding a third copy is exactly
 * how `getChatMessages` ended up with two incompatible shapes.
 *
 * @module iris-web/sandbox/button-event
 */
import { stringHash } from '@iris/text'

/**
 * Build the event name for one button.
 *
 * @param scriptId - the script that published it. Upstream stringifies whatever
 * it has, so an absent id becomes the string `"undefined"` rather than throwing
 * — copied, because a card whose script id is missing would otherwise fail here
 * instead of at the place the id went missing.
 * @param buttonName - the label, which is an input to the hash: renaming a
 * button changes its event and orphans listeners registered against the old one.
 * @returns `${scriptId}_${cyrb53(buttonName)}`.
 */
export function buttonEventName(scriptId: string | undefined, buttonName: string): string {
  return `${String(scriptId)}_${String(stringHash(buttonName))}`
}
