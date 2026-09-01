/**
 * The actions a card may invoke, and the wire methods they reach.
 *
 * Two entry points, one surface. Upstream exposes the context's members both
 * through `getContext()` and directly on the `SillyTavern` global — measured:
 * `SillyTavern.saveMetadata` at six sites, `context.saveChat` at eight, and MVU's
 * own bundle calling `SillyTavern.saveChat` directly. The data members were
 * already reachable both ways here; these are the actions, which were reachable
 * neither way.
 *
 * **The list is used twice and enforced once.** The frame reads it to know which
 * members of its facade are callable; the shell reads it to decide whether to
 * make the call. Only the second is authority — the frame is the untrusted side,
 * so a card asking for a method not on this list is refused by the shell no
 * matter what the frame believes. Sharing one constant keeps the two from
 * drifting into different ideas of the same set.
 *
 * @module iris-web/sandbox/card-api
 */

/** Card-facing action name → the wire method that performs it. */
export const CARD_METHODS: Readonly<Record<string, string>> = {
  saveChat: 'script.saveChat',
  saveMetadata: 'script.saveMetadata',
  generateRaw: 'script.generateRaw',
  // Not the same thing as the card's bare `getVariables()`, which answers
  // synchronously from the pushed snapshot. This is the round trip that
  // `updateVariablesWith` needs before it can amend a scope the snapshot does
  // not carry.
  getVariables: 'script.getVariables',
  setVariables: 'script.setVariables',
  swipeTo: 'script.swipeTo',
}

/** Whether a card may invoke this action. */
export function isCardMethod(name: string): boolean {
  return Object.hasOwn(CARD_METHODS, name)
}

/**
 * The wire method behind a card action.
 * @param name - the card-facing name.
 * @returns the wire method, or undefined when the card may not invoke it.
 */
export function wireMethodFor(name: string): string | undefined {
  return isCardMethod(name) ? CARD_METHODS[name] : undefined
}
