/**
 * The libraries upstream puts in a card's frame before the card.
 *
 * Copied from `src/iframe/third_party_script.html` in the installed Tavern
 * Helper, which is two tags and nothing else for a **script** frame. Message
 * frames get a larger set (jQuery and friends); that list belongs with the
 * message-rendering pipeline, which does not exist here yet.
 *
 * **Upstream pins no versions.** `npm/vue/dist/...` without a version resolves to
 * jsdelivr's latest, so the code that ends up inside a card's frame can change
 * without anyone here doing anything. That is copied rather than corrected, for
 * the usual reason — a card working today was written against whatever latest is
 * — but it is a supply-chain property rather than a behavioural quirk, and it is
 * flagged in SANDBOX.md as a decision rather than left as an accident.
 *
 * @module iris-web/sandbox/libraries
 */

/**
 * Libraries for a card-script frame, in load order.
 *
 * Order matters: `vue-router` expects `Vue` to already be a global.
 */
export const SCRIPT_LIBRARIES: readonly string[] = [
  'https://testingcf.jsdelivr.net/npm/vue/dist/vue.runtime.global.prod.min.js',
  'https://testingcf.jsdelivr.net/npm/vue-router/dist/vue-router.global.prod.min.js',
]

/**
 * Which libraries a frame should carry.
 *
 * The probe gets none. It exercises the frame, not a card, and making a
 * diagnostic depend on two CDN fetches would mean a network problem and a sandbox
 * problem producing the same symptom — which is the confusion this whole
 * diagnostic layer exists to remove.
 * @param kind - what the frame is running.
 * @returns the library URLs, in load order.
 */
export function librariesFor(kind: 'card-script' | 'probe'): readonly string[] {
  return kind === 'card-script' ? SCRIPT_LIBRARIES : []
}
