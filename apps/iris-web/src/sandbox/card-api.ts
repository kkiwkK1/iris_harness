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
import type { RpcMethod } from '@iris/protocol'

/**
 * Card-facing action name → the wire method that performs it.
 *
 * The values are `RpcMethod`, not `string`, and that is the whole point of the
 * annotation: the shell reaches `client.call` through a cast, so a misspelled
 * wire method here would compile, ship, and fail only when a card asked for it.
 * A type error at the table is the only place that mistake is cheap. (Type-only
 * import — it costs the frame bundle nothing.)
 */
export const CARD_METHODS: Readonly<Record<string, RpcMethod>> = {
  saveChat: 'script.saveChat',
  saveMetadata: 'script.saveMetadata',
  /*
   * Two generates, two meanings, and the pair is listed together so nobody adds
   * one without seeing the other.
   *
   * `generate` assembles the preset, the worldbook and the history and puts the
   * card's `user_input` last. `generateRaw` sends only what the caller ordered.
   * Serving one with the other **succeeds** — text comes back, nothing throws,
   * and the reply is missing its persona and its conversation — which is why
   * they are separate wire methods rather than one with a flag, and why this
   * table is the place the distinction has to be visible.
   */
  generate: 'script.generate',
  generateRaw: 'script.generateRaw',
  // Not the same thing as the card's bare `getVariables()`, which answers
  // synchronously from the pushed snapshot. This is the round trip that
  // `updateVariablesWith` needs before it can amend a scope the snapshot does
  // not carry.
  getVariables: 'script.getVariables',
  setVariables: 'script.setVariables',
  swipeTo: 'script.swipeTo',
  /*
   * The only worldbook member routed through here, and deliberately the only one.
   *
   * `getCharWorldbookNames` is **synchronous** upstream, so it cannot be a round
   * trip at all — it answers from the pushed snapshot's `charWorldbooks`, the
   * same way the bare `getVariables()` does. Listing it here would be a second,
   * wrong way to reach it.
   */
  getWorldbook: 'worldbook.get',
  /*
   * `updateWorldbookWith` is deliberately absent and is **not** a gap.
   *
   * It takes a function, which cannot cross the frame boundary, so it is built
   * in the frame out of this method plus `worldbook.get` — the same shape
   * `updateVariablesWith` uses. There is no wire method for it to map to.
   */
  replaceWorldbook: 'worldbook.replace',
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
export function wireMethodFor(name: string): RpcMethod | undefined {
  return isCardMethod(name) ? CARD_METHODS[name] : undefined
}
