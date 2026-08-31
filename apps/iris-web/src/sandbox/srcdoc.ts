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
export function framePolicy(): string {
  const remotes = REMOTE_ALLOWLIST.map(host => `https://${host}`).join(' ')
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${remotes}`,
    `connect-src ${remotes}`,
    // Inline styles are how a card draws; images from anywhere plus data URIs is
    // what card UI actually uses, and neither is a way out of the frame.
    "style-src 'unsafe-inline' https: data:",
    'img-src https: data: blob:',
    "font-src https: data:",
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
 * @returns the `srcdoc` value.
 */
export function buildSrcdoc(token: string, bootstrap: string): string {
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
    `<meta http-equiv="Content-Security-Policy" content="${attribute(framePolicy())}">`,
    // How the bootstrap learns its token. An attribute rather than a global,
    // because the bootstrap runs before any card code and reads it once.
    `<meta name="iris-token" content="${attribute(token)}">`,
    // The card's container is this document's own body: `parent.document.body`
    // resolves here, which is what makes the two measured mount sites work
    // without the card ever reaching the host page.
    '<style>html,body{margin:0;padding:0;background:transparent;color-scheme:inherit}</style>',
    '</head><body>',
    `<script>${safe}</script>`,
    '</body></html>',
  ].join('')
}
