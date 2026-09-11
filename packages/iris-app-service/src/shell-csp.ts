/**
 * The shell page's own Content-Security-Policy, injected into the served index.
 *
 * **Why the host writes it and not the page.** `apps/iris-web/index.html` is
 * also the dev server's entry, and a policy that only exists in one of the two
 * is a policy nobody tests in the other. More to the point, the directive set
 * below is a *deployment* fact — it names the origin the page was served from —
 * so it belongs where the deployment is assembled. The carrier
 * (`@deepseek-ai/dsh-host-webserver`) offers exactly one seam for it,
 * `tapIndex(html => html)`, applied by `renderIndex` on the index body; the
 * static seat (`@deepseek-ai/dsh-host-frontend-static`) re-reads `distIndex`
 * from disk and calls `renderIndex` **per response** (`lib/index.js`: the
 * `renderIndex` closure is `async () => ctx.webServer.renderIndex(await
 * readFile(distIndex, 'utf8'))`, passed into `serveStatic` and awaited on every
 * index request), so nothing is cached per process and a per-response value —
 * a nonce — would be sound if the policy needed one. It does not; see below.
 *
 * ## The measurement that decides the directive set
 *
 * The obvious policy — `default-src 'self'; script-src 'self' 'nonce-…'` with
 * no `'unsafe-inline'` and no `'unsafe-eval'` — **cannot be shipped**, and the
 * reason is not a matter of taste. A card interface is an `<iframe srcdoc>`
 * (`apps/iris-web/src/sandbox/runner.ts`), `about:srcdoc` is a *local scheme*,
 * and a document with a local-scheme URL **inherits the embedder's CSP**, which
 * is then enforced *in addition to* the document's own `<meta>` policy. The
 * frame's own policy is the permissive one card code needs
 * (`'unsafe-inline' 'unsafe-eval' blob:` + the CDN allow-list); intersecting it
 * with a strict shell policy leaves nothing that runs.
 *
 * Measured in headless Chrome 2026-09-11 — one card-shaped `srcdoc` frame with
 * Iris's real frame policy in its `<meta>`, mounted under four different parent
 * documents, `sandbox="allow-scripts …"` exactly as `frameSandbox` writes it:
 *
 * | the shell's policy | the frame's first inline script | `new Function` |
 * | --- | --- | --- |
 * | none (today) | **runs** | `2` |
 * | `default-src 'self'; script-src 'self' 'nonce-…'` | **never runs** | — |
 * | the same plus `frame-src 'none'` | **never runs** (the frame is still created) | — |
 * | `default-src 'self'; script-src 'self' 'unsafe-inline'` | runs | **blocked**, and the refusal quotes the *shell's* directive |
 *
 * The first row is the control that makes the rest readable: the same frame
 * document, byte for byte, runs when the parent carries no policy. The last row
 * is the one that names the mechanism out loud — the browser refused the
 * frame's `new Function` citing `script-src 'self' 'unsafe-inline'`, a string
 * that appears nowhere in the frame's own policy.
 *
 * Two consequences, both recorded rather than worked around:
 *
 * 1. **No `script-src`, `default-src`, `style-src`, `img-src`, `font-src` or
 *    `connect-src` here.** Each of them narrows every card frame, and a shell
 *    policy that costs the product its cards is not defence in depth. The one
 *    shape that would not — a union wide enough for the frames — is
 *    `'unsafe-inline' 'unsafe-eval'` plus two CDNs, which is to say no
 *    protection against the injected-script threat this exists for. (And a
 *    nonce cannot be added to widen it back: a `script-src` carrying a nonce
 *    makes browsers *ignore* `'unsafe-inline'`, so the two cannot coexist.)
 * 2. **`frame-src` is omitted entirely.** The same measurement shows Chrome
 *    does not apply `frame-src` to a `srcdoc` navigation — the frame under
 *    `frame-src 'none'` was created and its markup parsed. So every value is
 *    either a no-op (today) or, if a browser ever started enforcing it, the one
 *    line that kills every card interface at once, since no source expression
 *    matches `about:srcdoc`. An omitted directive says that honestly.
 *
 * ## What is left, and why each one is free
 *
 * The three directives below are exactly those that a card frame either already
 * enforces on itself or wants enforced. They cost the frames nothing and they
 * are real: `<object data>` and `<embed>` execute script in several engines,
 * `<base href>` re-points every relative URL on the page (the shell's own module
 * bundle is loaded as `./assets/…`), and a form posting to an attacker is how
 * an injected credential prompt gets its answer out without needing `fetch`.
 *
 * The shell uses none of the three (measured: no `<form>`, `<object>`, `<embed>`
 * or `<base>` anywhere in `apps/iris-web/src`), and the frame policy sets
 * `object-src` and `form-action` to `'none'` already by way of
 * `default-src 'none'`. `base-uri` has **no fallback to `default-src`**, which
 * is why the frame was unrestricted there until `framePolicy` gained its own
 * line in the same change.
 *
 * ## The two gaps this cannot close
 *
 * - **Response headers on the index and the assets.** `nosniff`,
 *   `frame-ancestors`/`X-Frame-Options` and `Cache-Control: no-store` are
 *   headers, and the fallback seat that writes those responses belongs to an
 *   external package with no header hook. `frame-ancestors` is additionally
 *   ignored in a `<meta>` by definition, so the click-jacking answer is the
 *   shell's own first inline script refusing to render framed — weaker than a
 *   header, and said so in `apps/iris-web/index.html`.
 * - **The strict policy itself.** It becomes possible the day a card frame's
 *   document stops being `srcdoc` — served from a real same-origin URL, still
 *   sandboxed to an opaque origin, its policy its own response's header. That
 *   is the thing that would overturn this module's whole shape.
 *
 * @module @iris/app-service/shell-csp
 */

/**
 * The shell's policy, directive by directive.
 *
 * Exported as the list rather than the joined string so a test can name the
 * directive it is asserting about, and so the absences above are visible as
 * absences rather than as a string someone has to diff.
 */
export const SHELL_CSP_DIRECTIVES: readonly string[] = [
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

/** The policy as it is written into the page. */
export function shellPolicy(): string {
  return SHELL_CSP_DIRECTIVES.join('; ')
}

/**
 * Whether a document already declares a policy of its own.
 *
 * Matched on the `http-equiv` attribute rather than on a whole tag, because the
 * attribute order a build tool writes is not something this should depend on.
 */
const EXISTING_POLICY =
  /<meta[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?/i

/** The `<head>` opening tag, with or without attributes. */
const HEAD_OPEN = /<head\b[^>]*>/i

/** What one pass over an index body did. */
export interface IndexStamp {
  /** The body to serve. Unchanged whenever `refusal` is set. */
  html: string
  /** Why nothing was injected, when nothing was. */
  refusal?: string
}

/**
 * Put the policy into one index body.
 *
 * **Refuses rather than adds a second policy.** Two CSP meta elements are not a
 * stronger policy and not the later one either — the browser enforces both, so
 * the page ends up under an intersection nobody wrote down, and the symptom is
 * a refusal citing a directive that appears in neither author's copy (which is
 * exactly the confusion the srcdoc measurement above cost a morning to unpick).
 * Refusing also makes this idempotent for free: a second pass over this
 * function's own output changes nothing, and the count stays one.
 *
 * Inserted immediately after `<head>` because a `<meta>` policy governs only
 * what the parser reaches **after** it, and the first thing in this head is an
 * inline script.
 * @param html - the raw index body, as the static seat read it from disk.
 * @returns the body to serve, and why it was left alone if it was.
 */
export function stampShellIndex(html: string): IndexStamp {
  if (EXISTING_POLICY.test(html)) {
    return {
      html,
      refusal: 'the served index already declares a Content-Security-Policy, so none was injected —'
        + ' two policies are enforced as one intersection that neither author wrote',
    }
  }
  const head = HEAD_OPEN.exec(html)
  if (head === null) {
    return {
      html,
      refusal: 'the served index has no <head> element, so the Content-Security-Policy'
        + ' has nowhere to go that the parser reaches before the page\'s first script',
    }
  }
  const at = head.index + head[0].length
  const meta = `<meta http-equiv="Content-Security-Policy" content="${shellPolicy()}">`
  return { html: `${html.slice(0, at)}${meta}${html.slice(at)}` }
}
