/**
 * Whether a card's request is aimed at Iris itself, and what it resolves to.
 *
 * A srcdoc frame resolves relative URLs against the parent page's base, so a
 * card's `fetch('/version')` — frequent upstream, because card scripts there
 * share SillyTavern's origin — aims at Iris's own host. `connect-src` never
 * lists that origin (see `srcdoc.ts`), so the request is refused and the
 * refusal banner is what a user sees for a call upstream answers silently.
 * Measured: MagVarUpdate's bundle, which every MVU card imports, opens with
 * `fetch('/version')` and posts to `/api/backends/...` the same way.
 *
 * The answer decided in `SANDBOX.md` is not a wider CSP but a bridge: a
 * same-origin request is carried to the shell on the existing `fetch` message
 * and fetched *by the shell page*, with its own credentials. This module is
 * the decision of what counts as same-origin, and it is consulted twice —
 * frame-side, to decide whether a request rides the bridge at all, and again
 * in the runner before the shell honours it, because the frame is the
 * untrusted side and "the frame already filtered" is not a check.
 *
 * @module iris-web/sandbox/same-origin
 */

/**
 * Resolve a request against `base`, and name it only when it is `origin`'s own.
 *
 * @param specifier - the URL or relative path exactly as the card wrote it.
 * @param base - what relative paths resolve against: the frame's
 *   `document.baseURI` frame-side — which for a srcdoc frame is the shell
 *   page's URL, the same resolution the browser would have made — and the
 *   shell page's own URL host-side.
 * @param origin - the origin that counts as "us": the shell's.
 * @returns the resolved absolute URL when it is same-origin, else undefined.
 *   Undefined always means "not ours", and the caller keeps its existing
 *   behaviour: the frame hands the request to the native fetch, where CSP
 *   refuses what it refuses and reports it, and the runner hands it to the
 *   allowlisted remote path.
 */
export function sameOriginTarget(specifier: string, base: string, origin: string): string | undefined {
  let url: URL
  try {
    url = new URL(specifier, base)
  } catch {
    // Unparseable. Native keeps the old failure; a bridge that threw here
    // would turn a card's typo into a new and different one.
    return undefined
  }
  return url.origin === origin ? url.href : undefined
}
