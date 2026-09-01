/**
 * The libraries a card's frame carries, and why there is no longer a CDN in it.
 *
 * Upstream's `src/iframe/third_party_script.html` is two tags — Vue and
 * vue-router from jsdelivr, unversioned — and Iris copied them verbatim. Copying
 * the URLs was right; calling the result *mirroring upstream* was not, because
 * the two sides run under different caches:
 *
 * - Upstream's script frames are same-origin with the SillyTavern page and share
 *   its HTTP cache. Those tags are a warm hit after the first load.
 * - Iris opens every chat in a **fresh opaque origin**, and the HTTP cache is
 *   partitioned by origin. The same tag is a cold cross-origin fetch every time
 *   — the path measured at 9–12 seconds with four timeouts in six openings,
 *   which is why card bundles already go through the host proxy.
 *
 * The cost was not the latency. **A classic `<script src>` that fails, fails
 * silently**: no exception, nothing the parent can see, the global simply never
 * appears. MagVarUpdate publishes from inside a `Vue.watch` callback, so one
 * dropped tag meant `Mvu` was never published and every consumer of that card
 * waited forever — with a missing-libraries banner that named three other
 * libraries and not Vue.
 *
 * So Vue moved into `preset.js`, pinned, served from Iris's own origin, and a
 * card frame's startup now has no network dependency at all. `vue-router` did
 * not move with it: nothing measured uses it, and its absence is *reported*
 * rather than hidden. See `preset-entry.ts` for that decision and its numbers.
 *
 * @module iris-web/sandbox/libraries
 */

/**
 * Which libraries a frame should carry.
 *
 * One entry now, and the list is kept as a list rather than collapsed into a
 * single string: the probe still gets nothing, and that distinction is the
 * reason this function exists.
 *
 * The probe gets none because it exercises the frame, not a card. Making a
 * diagnostic depend on a fetch would mean a network problem and a sandbox
 * problem producing the same symptom — the confusion this whole diagnostic layer
 * exists to remove. That argument used to be about two CDN fetches; it still
 * holds for one same-origin one, because the probe has nothing to use a library
 * for.
 *
 * @param kind - what the frame is running.
 * @param origin - Iris's own origin, for the locally served bundle.
 * @returns the library URLs, in load order.
 */
export function librariesFor(kind: 'card-script' | 'probe', origin: string): readonly string[] {
  if (kind !== 'card-script') return []
  // Absolute rather than root-relative. A `srcdoc` document resolves relative
  // URLs against its parent's base URL, which is a browser behaviour this project
  // cannot verify from outside a browser — and the failure mode if it differs is
  // a silent 404 that surfaces as a missing library three steps later.
  return [`${origin}/sandbox/preset.js`]
}
