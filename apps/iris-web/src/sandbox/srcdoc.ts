/**
 * The markup a card's frame is built from.
 *
 * Pure string assembly, kept out of `runner.ts` so the part that decides what
 * the frame *is* can be asserted without a browser — the frame's own CSP, the
 * token that lets the shell tell frames apart, and the fact that the bootstrap
 * is inlined rather than fetched.
 *
 * @module iris-web/sandbox/srcdoc
 */

import { REMOTE_ALLOWLIST } from './policy.ts'

/**
 * The frame's content security policy.
 *
 * CSP cannot be the isolation mechanism here — the card blobs are webpack output
 * that `eval()`s per module, so forbidding `unsafe-eval` runs none of them. But
 * that only rules out using CSP to restrict what code may *compile*. Restricting
 * where code may come *from* is a different capability and it is fully available:
 * this policy allows eval and pins remote script origins to the measured
 * allowlist in the same breath.
 *
 * It is a second line, not the line that counts. A page cannot be trusted to
 * police its own fetches, so the host's `script.fetch` remains the enforcement
 * that matters; this catches the case where a card loads a dependency directly
 * instead of asking.
 * @returns the policy value.
 */
/**
 * The FontAwesome sentinel's path, served from Iris's own origin.
 *
 * A literal rather than a manifest lookup, because the **filename** is what a
 * card's guard reads — see the file at this path for why it cannot be hashed.
 */
export const FA_SENTINEL = '/sandbox/fontawesome.min.css'

export function framePolicy(networkGranted: boolean, selfOrigin: string): string {
  const remotes = REMOTE_ALLOWLIST.map(host => `https://${host}`).join(' ')

  // Fonts are the one default widening: high coverage across real cards, and a
  // stylesheet or a font file executes nothing. `fonts.googleapis.com` serves the
  // CSS, `fonts.gstatic.com` the faces — both are needed or neither works.
  const fontCss = 'https://fonts.googleapis.com'
  const fontFiles = 'https://fonts.gstatic.com'

  /*
   * The three directives a network grant widens, and why they are closed by
   * default even though closing them costs real cards their appearance.
   *
   * An open image or fetch channel is an exfiltration channel for everything the
   * frame can see. A card that may request `https://anywhere/x.png?d=<data>` can
   * send the conversation out one pixel at a time; `connect-src` is the same
   * capability without the pretence. So the default is data and blob only —
   * origins the frame already holds in memory — and widening is a decision the
   * user makes per card.
   *
   * `http:` is never listed, granted or not. A grant is the user accepting that
   * a card may talk to its author's server; it is not them accepting that the
   * conversation travels in clear text over a network they do not control.
   */
  const imgSrc = networkGranted ? 'https: data: blob:' : 'data: blob:'
  const connectSrc = networkGranted ? 'https:' : "'none'"
  /*
   * Iris's own origin is admitted for stylesheets, and for one file: the
   * FontAwesome sentinel the head links (`FA_SENTINEL`). Named exactly, the
   * same way and for the same reason as in `script-src` — and strictly weaker
   * than that entry, which already admits *executing* code from this origin.
   *
   * Both branches list it. Under a network grant `https:` would cover a
   * deployed origin but not a dev one, and a policy that only works in
   * production is a policy nobody tests.
   */
  const styleSrc = networkGranted
    ? `'unsafe-inline' https: data: ${selfOrigin}`
    : `'unsafe-inline' ${fontCss} data: ${selfOrigin}`

  return [
    "default-src 'none'",
    /*
     * `blob:` is not a widening — it is the difference between this working and
     * not working at all.
     *
     * Tavern Helper delivers its own injected layer (`predefine`,
     * `adjust_iframe_height`, `adjust_viewport`) as `blob:` URLs rather than
     * inline text, confirmed in a live network trace. A policy without `blob:`
     * blocks the injection layer before any card code exists, so nothing would
     * run and the failure would look like a broken card rather than a wrong
     * policy. It grants nothing extra: a blob URL can only carry what this frame
     * already had in memory.
     *
     * Script origins are NOT widened by a network grant. Letting a card fetch its
     * author's images is a different decision from letting it execute its author's
     * code, and only the first is what the grant is for.
     */
    /*
     * Iris's own origin is listed because the card-library bundle is served from
     * it. Named exactly, never as a wildcard: this admits one origin that Iris
     * already controls end to end, which is a different thing from admitting a
     * host on the public internet.
     *
     * Without it the bundle is refused by this very policy — and the symptom would
     * be `_ is not defined`, a message pointing at a missing library rather than at
     * the rule that blocked it. (The refusal *would* be reported, which is the
     * point of reporting refusals; it would still have cost a round trip.)
     */
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${selfOrigin} ${remotes}`,
    `connect-src ${connectSrc}`,
    `style-src ${styleSrc}`,
    `font-src data: ${fontFiles}`,
    `img-src ${imgSrc}`,
    // No nested browsing contexts and no form posts: both would be routes out of
    // a frame whose whole purpose is not having any.
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** Escape a value for an HTML attribute. */
function attribute(value: string): string {
  return value
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;')
}

/**
 * Build a frame's document.
 *
 * The bootstrap arrives as text and is inlined. Nothing is fetched: an
 * opaque-origin frame has no useful same-origin path, and a stable public URL
 * would be one more thing that has to be cache-managed and one more thing whose
 * answer could be substituted.
 * @param token - the run token for this frame, minted per run.
 * @param bootstrap - the built bootstrap source.
 * @param options.networkGranted - whether the user let this card reach the
 * network. No default: a caller that forgot it would build the restrictive policy
 * for a card the user had granted, and the reader would see "Iris refused <host>"
 * and conclude the grant control was broken. A hidden default does not just hide
 * a decision, it points the resulting failure at the wrong thing.
 * @param options.libraries - preset libraries to load before the card, in order.
 * @returns the `srcdoc` value.
 */
export function buildSrcdoc(
  token: string,
  bootstrap: string,
  options: {
    networkGranted: boolean
    libraries: readonly string[]
    /**
     * The card-facing member table's URL.
     *
     * Loaded once per page and cached by content hash, where the bootstrap is
     * inlined per frame. Optional so a caller that has not been given one still
     * builds a frame — it will report the absence by name rather than fail to
     * exist, which is the more useful of the two failures.
     */
    members?: string
    selfOrigin: string
    /**
     * Markup to place in the frame's own body — a message frame's card
     * interface.
     *
     * Script frames leave this undefined: their bodies arrive later as `run`
     * messages, because a script *is* code and can be handed over a channel. A
     * message frame's block is **markup**, and markup only runs by being parsed,
     * so it has to be in the document from the start.
     */
    body?: string
    /**
     * The snapshot, inlined so it exists before the body parses.
     *
     * This is the whole reason the option exists. A card's interface runs its
     * scripts **at parse time** and reads variables immediately — drawing a
     * status panel from them is the point of it existing. The pushed `context`
     * message cannot arrive that early: the shell only sends it after `ready`
     * (`runner.ts`), so the only thing separating them is the parse pause while
     * a library `<script src>` is fetched. That pause usually wins, and
     * "usually" is not a mechanism — it makes correctness depend on a fetch's
     * timing, which is the class of accident this project has spent eleven
     * rounds removing.
     *
     * Inlined, the ordering is correct by construction. The cost is bytes, paid
     * per frame with no caching, and it is bounded three ways: a message frame
     * carries only **its own floor's** layer, the corpus distribution is
     * overwhelmingly under 1 KiB (283 KiB is the worst single floor measured),
     * and the number of simultaneous frames is limited by the lifecycle window.
     *
     * The pushed channel stays for **updates**; this is only the initial value.
     */
    context?: unknown
  },
): string {
  const { networkGranted, libraries, selfOrigin, members } = options
  // The bootstrap is placed inside a script element, so the one sequence that
  // could break out of it is a literal `</script`. Split rather than escaped:
  // the string is JavaScript, and an HTML escape inside it would change the code.
  // The replacement is built from a code point rather than written as an escape.
  // A literal backslash here is invisible when it goes missing: `'<\/script'`
  // and `'</script'` look almost identical and the second is a silent no-op,
  // which is exactly the bug this line shipped with until a test caught it.
  const { body, context } = options
  const BACKSLASH = String.fromCharCode(92)
  const escapeClose = (source: string): string =>
    source.split('</script').join(`<${BACKSLASH}/script`)
  const safe = escapeClose(bootstrap)

  /*
   * The initial snapshot, as a global the bootstrap picks up.
   *
   * `JSON.stringify` twice, then parsed once at run time: the value is embedded
   * as a **string literal** rather than as an object literal, so no character in
   * a card's data can end the script element or be read as code. A card's
   * variables are card-authored and model-influenced text; putting them into a
   * document as source is exactly where an object literal would be a hole.
   */
  const seed =
    context === undefined
      ? ''
      : `<script>globalThis.__iris_context__=JSON.parse(${escapeClose(
          JSON.stringify(JSON.stringify(context)),
        )})</script>`

  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attribute(framePolicy(networkGranted, selfOrigin))}">`,
    // How the bootstrap learns its token. An attribute rather than a global,
    // because the bootstrap runs before any card code and reads it once.
    `<meta name="iris-token" content="${attribute(token)}">`,
    /*
     * The shell's origin, stamped in because the frame **cannot work it out**.
     * A sandboxed srcdoc frame's `location.origin` is the string `"null"`, so a
     * frame comparing a URL against its own origin compares against nothing —
     * see `shellOrigin` in `frame-entry.ts` for the report this had been
     * quietly flattening.
     */
    `<meta name="iris-origin" content="${attribute(selfOrigin)}">`,
    /*
     * The FontAwesome sentinel, and **its filename participates in behaviour**.
     *
     * The icon rules are already in this frame as inlined `<style>` elements
     * before any card runs. But a card cannot cheaply ask "are the icon rules
     * present", so upstream's cards ask a different question — has a stylesheet
     * whose href contains `fontawesome` / `font-awesome` been loaded — and
     * inject a CDN `<link>` when the answer is no. This frame's policy refuses
     * that injection, so a card that was never missing anything would spend its
     * recovery path on a wall and report a failure for a library it already has.
     *
     * Linking this file makes the guard's substring findable. It is deliberately
     * **not** hashed and **not** in the manifest, unlike every other asset here:
     * the name is read by code that is not ours, so it is a fixed literal on
     * both sides. See the file's own comment.
     *
     * Both frame kinds get it. The guard runs wherever the card's code does, and
     * upstream's message frames link a real FontAwesome sheet too.
     */
    `<link rel="stylesheet" href="${attribute(`${selfOrigin}${FA_SENTINEL}`)}">`,
    // The card's container is this document's own body: `parent.document.body`
    // resolves here, which is what makes the two measured mount sites work
    // without the card ever reaching the host page.
    /*
     * A message frame gets upstream's reset; a script frame keeps the minimal one.
     *
     * The load-bearing line is `overflow:hidden` on `html,body`
     * (`render/iframe.ts:88-89`), and it is what turns height sync from a layout
     * concern into an **existence** one: the frame cannot scroll itself, so
     * anything past the reported height is not clipped-with-a-scrollbar, it is
     * simply not there. Copied deliberately — a card that sized itself expecting
     * no inner scrollbar would lay out differently against one.
     *
     * It interacts with a divergence already recorded in `SANDBOX.md`: Iris
     * cannot write `frameElement.style.height` across origins and posts the
     * height out instead, one frame later. So during that one frame a growing
     * interface is cut off rather than scrollable. Upstream has no such lag
     * because its write is same-origin and synchronous.
     *
     * `box-sizing` and `max-width` come from the same block. The avatar
     * background rules upstream also injects are **not** copied: they need the
     * user's and character's real avatar paths, which is host data a frame only
     * gets through the document grant.
     */
    body === undefined
      ? '<style>html,body{margin:0;padding:0;background:transparent;color-scheme:inherit}</style>'
      : '<style>*,*::before,*::after{box-sizing:border-box}' +
        'html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;' +
        'background:transparent;color-scheme:inherit}</style>',
    /*
     * A marker on the body when this frame holds a card **interface**.
     *
     * The blank-body detector needs it: a *script* frame's body is script tags
     * and nothing else, so "has drawn nothing" is its normal and correct state.
     * Without this the detector would put a false finding under every card
     * script frame — a noisy instrument teaches a reader to skip the whole list,
     * which costs more than the silence it was meant to fix.
     */
    body === undefined ? '</head><body>' : '</head><body data-iris-interface>',
    /*
     * The bootstrap first, then the card's libraries.
     *
     * This order is deliberate and the reason is reporting: the bootstrap has to
     * capture its channel to the shell and install its error handling before
     * anything else runs, so that a library which fails to load is something the
     * frame can *say*. Loaded first, a broken library would be a silent gap that
     * only surfaces later as `Vue is not defined` — a message that names the
     * symptom and hides the cause.
     *
     * The libraries are the card's dependencies, not the sandbox's, which is the
     * other half of why they come second.
     */
    /*
     * The member table, **before** the inlined bootstrap and blocking.
     *
     * A classic `<script src>` with no `async`/`defer` finishes before the next
     * script element begins, so by the time the bootstrap's first line runs the
     * table is either present or definitively absent — which is what lets the
     * bootstrap check a marker instead of waiting for one.
     *
     * `crossorigin="anonymous"` for the same reason the libraries carry it: this
     * frame is an opaque origin, so every script it loads is cross-origin to it,
     * and without the attribute an exception thrown inside the table is redacted
     * to the bare word `Script error.`. The other half of that pair — the host's
     * `Access-Control-Allow-Origin` on the sandbox-asset route — already exists;
     * adding the attribute without it once stopped the preset from running at
     * all, silently.
     *
     * Omitted entirely when there is no URL, rather than emitted empty: a
     * `<script src="">` re-requests the frame's own document, and the failure
     * that produces is nothing like the one it would be standing in for.
     */
    ...(members === undefined
      ? []
      : [`<script src="${attribute(members)}" crossorigin="anonymous" data-iris-members></script>`]),
    `<script>${safe}</script>`,
    // After the bootstrap, which reads it, and before anything a card can run.
    seed,
    /*
     * `crossorigin="anonymous"`, and it only works as **one half of a pair**.
     *
     * The attribute makes the browser report a cross-origin script's exceptions
     * in full instead of redacting them to the bare string `Script error.`, and
     * a frame here is an opaque origin, so every script it loads — Iris's own
     * preset included — is cross-origin to it. Without the names, an error
     * thrown inside a callback the preset scheduled arrives carrying nothing:
     * MagVarUpdate's entry runs inside jQuery's `$(async () => …)`, so jQuery is
     * the script the browser blames, jQuery comes from `preset.js`, and the
     * throw that stops the whole publish chain shows up as one masked word.
     *
     * The other half is the response. `crossorigin` turns the load into a CORS
     * fetch, which **requires** `Access-Control-Allow-Origin`. This attribute was
     * added once without that header, and the result was not a degraded error
     * message — it was the browser refusing to run the preset at all, silently,
     * costing a full round and reporting nine missing libraries that were really
     * one blocked request. The header now exists (`@iris/app-service`'s
     * sandbox-asset route, `*` plus `cache-control: no-cache`).
     *
     * Neither half is safe alone and each looks correct on its own, which is
     * exactly how they composed into a silent failure the first time. They are
     * asserted **together**, across the two halves, in
     * `apps/iris/tests/sandbox-cors.test.ts` — a test in either package alone
     * could only ever check its own side.
     */
    ...libraries.map(
      url => `<script src="${attribute(url)}" crossorigin="anonymous" data-iris-lib></script>`,
    ),
    /*
     * The card's markup last, after the bootstrap and the libraries.
     *
     * Order is load-bearing in both directions. The bootstrap must be first so
     * that anything the markup throws is something the frame can *say* — it
     * installs the channel and the error reporting. The libraries must precede
     * the markup because a card's inline script calls `$()` on its first line,
     * and an external `<script src>` without `defer` blocks parsing until it has
     * run, which is what makes that ordering hold.
     */
    body === undefined ? '' : body,
    '</body></html>',
  ].join('')
}
