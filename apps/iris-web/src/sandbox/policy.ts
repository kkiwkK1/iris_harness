/**
 * Where the isolation actually comes from.
 *
 * `docs/SANDBOX.md` rules out CSP: the card blobs are webpack output that `eval()`s
 * per module, so a frame forbidding `unsafe-eval` runs none of them. Isolation
 * therefore has to come from the frame boundary and from what the globals inside
 * it are wired to. This module decides both.
 *
 * **The frame is cross-origin by default.** `sandbox="allow-scripts"` without
 * `allow-same-origin` puts the frame in an opaque origin, so the browser itself
 * refuses any reach into the host page — `window.parent.document` throws a
 * SecurityError before any Iris code is consulted.
 *
 * That distinction matters for how to read the rest of the sandbox: shadowing
 * `window`, `parent` and `document` as function parameters (see `bootstrap.ts`)
 * is the **compatibility** layer, not the security layer. It exists so a card
 * that reaches for `parent.document.body` gets something useful instead of an
 * error. A card that evades the shadow — `globalThis`, `top`,
 * `Function('return this')()` — reaches the real, cross-origin `parent` and is
 * stopped by the browser. The sandbox fails closed, which is the only way a
 * boundary around code this size can be argued for at all.
 *
 * A same-origin frame with only shadowed identifiers would be the opposite: one
 * `Function('return this')()` and the card is in the host page. That is the
 * design upstream ships, and it is why Iris diverges here.
 *
 * @module iris-web/sandbox/policy
 */

/**
 * The `sandbox` attribute for a card's frame.
 *
 * @param documentGranted - whether the user granted this card the real page.
 * @returns the attribute value.
 */
export function frameSandbox(documentGranted: boolean): string {
  // `allow-scripts` alone is an opaque origin. Adding `allow-same-origin`
  // alongside it is famously not a sandbox — which is exactly what a grant is:
  // the user deciding this card may have the page. It is spelled out here rather
  // than assembled at the call site so that the one dangerous combination in the
  // product appears in exactly one place.
  return documentGranted ? 'allow-scripts allow-same-origin' : 'allow-scripts'
}

/**
 * Globals a card reaches for that Iris intends to bridge, but has not yet.
 *
 * Listed rather than omitted because of how refusal works here: an absent global
 * is a `ReferenceError` mentioning a name the card author chose, while a refusal
 * from this list names the member AND says it is unbridged rather than
 * forbidden. Those are different facts and a card author debugging deserves the
 * right one.
 *
 * Site counts are from the corpus measurement in `docs/SANDBOX.md`.
 */
export const UNBRIDGED_GLOBALS: readonly { name: string, sites: number, plan: string }[] = [
  /*
   * Empty, and the mechanism stays anyway.
   *
   * All three original entries — `eventSource` (8 sites), `event_types` (6) and
   * `TavernHelper` (1) — are bridged now, and the rule was always that an entry
   * is deleted the day its bridge lands. An empty list is the rule working, not
   * a dead list to remove: the next measured-but-unbuilt global goes here so its
   * refusal can say "not yet" instead of "no", which is a different fact and the
   * one a card author debugging needs.
   */
]

/*
 * `SillyTavern` (15 sites) and `extension_settings` (6) were here and are now
 * bridged — see `frame.ts`. Entries leave this list as their bridge lands; a
 * name left behind would produce a refusal claiming to be temporary for
 * something that already works.
 */

/** Hosts a card may pull remote dependencies from. Enforced on the host, never here. */
export const REMOTE_ALLOWLIST: readonly string[] = ['*.jsdelivr.net', 'raw.githubusercontent.com']

/**
 * Whether a URL's host is on the allowlist.
 *
 * Present in the browser bundle for one reason only: to give a card a refusal
 * that names the host *before* a pointless round trip. The enforcement that
 * counts is the host's, because a page cannot be trusted to police its own
 * fetches — anything here is advice, and `script.fetch` refuses again regardless.
 * @param url - the requested URL.
 * @returns whether it is worth asking the host for.
 */
export function isAllowedRemote(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return REMOTE_ALLOWLIST.some(pattern => {
    if (!pattern.startsWith('*.')) return host === pattern
    const suffix = pattern.slice(1)
    // `*.jsdelivr.net` matches a subdomain, not the bare domain: the measured
    // imports are all subdomains, and matching the apex too would widen the list
    // for no case that exists.
    return host.endsWith(suffix)
  })
}
