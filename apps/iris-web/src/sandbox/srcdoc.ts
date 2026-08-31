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
export function framePolicy(networkGranted: boolean): string {
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
  const styleSrc = networkGranted
    ? `'unsafe-inline' https: data:`
    : `'unsafe-inline' ${fontCss} data:`

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
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${remotes}`,
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
  options: { networkGranted: boolean, libraries: readonly string[] },
): string {
  const { networkGranted, libraries } = options
  // The bootstrap is placed inside a script element, so the one sequence that
  // could break out of it is a literal `</script`. Split rather than escaped:
  // the string is JavaScript, and an HTML escape inside it would change the code.
  // The replacement is built from a code point rather than written as an escape.
  // A literal backslash here is invisible when it goes missing: `'<\/script'`
  // and `'</script'` look almost identical and the second is a silent no-op,
  // which is exactly the bug this line shipped with until a test caught it.
  const BACKSLASH = String.fromCharCode(92)
  const safe = bootstrap.split('</script').join(`<${BACKSLASH}/script`)

  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${attribute(framePolicy(networkGranted))}">`,
    // How the bootstrap learns its token. An attribute rather than a global,
    // because the bootstrap runs before any card code and reads it once.
    `<meta name="iris-token" content="${attribute(token)}">`,
    // The card's container is this document's own body: `parent.document.body`
    // resolves here, which is what makes the two measured mount sites work
    // without the card ever reaching the host page.
    '<style>html,body{margin:0;padding:0;background:transparent;color-scheme:inherit}</style>',
    '</head><body>',
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
    `<script>${safe}</script>`,
    ...libraries.map(url => `<script src="${attribute(url)}" data-iris-lib></script>`),
    '</body></html>',
  ].join('')
}
