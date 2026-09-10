/**
 * The markup a card's frame is built from.
 *
 * Pure string assembly, kept out of `runner.ts` so the part that decides what
 * the frame *is* can be asserted without a browser — the frame's own CSP, the
 * token that lets the shell tell frames apart, and the order in which the
 * frame's three scripts run.
 *
 * **The bootstrap is fetched by content-hashed URL, not inlined.** It was
 * inlined until 2026-09-10, on the reasoning that a card's markup reads bridged
 * names at *parse* time so the bootstrap must finish before the body — true, and
 * satisfied by a blocking classic `<script src>`, which is the same mechanism
 * the member table has depended on since it was split out. What inlining bought
 * was one fewer thing to cache-manage; what it cost was 53 KB per frame with no
 * cache at all, charged against the reading window's byte budget, which had
 * moved the frame gate down four times. See `notes/apps/iris-web/DEVIATIONS.md`
 * §91 for the measurement and the one failure the move introduces — a tag in
 * the document whose code never ran — which `bootstrap-contract.ts`'s guard
 * exists to name.
 *
 * @module iris-web/sandbox/srcdoc
 */

import { BOOTSTRAP_TAG_MARK, bootstrapGuard } from './bootstrap-contract.ts'
import { fromProxied, toProxied } from './bundle-proxy.ts'
import { isAllowedRemote, REMOTE_ALLOWLIST } from './policy.ts'

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
/**
 * An iframe's own default size, given to the elements that stand in for one.
 *
 * A nested iframe cannot be reached into from an opaque origin, so a card that
 * builds one is handed a `<div>` stand-in (`nested-frame.ts`). A `<div>` has no
 * intrinsic size: an `<iframe>` is a replaced element and is **300×150** with
 * no styling at all, while the stand-in fills its container's width and
 * collapses to **zero height** — measured in a laid-out page: `600×0` against
 * an iframe's `300×150`. A card that sizes its frame only from a stylesheet, or
 * not at all, therefore gets nothing to look at.
 *
 * **A rule rather than inline styles, and that is the whole design.** Inline
 * would beat the card's own stylesheet and break every card that *does* size
 * its frame. Measured against jQuery-era card CSS in a laid-out page, with this
 * rule first and the card's sheet after:
 *
 * | the card writes | result |
 * | --- | --- |
 * | nothing | 300×150 — an iframe's default |
 * | `#its-id { width:100%; height:400px }` | 600×400 — the card wins |
 * | `.its-class { width:100%; height:420px }` | 600×420 — the card wins |
 * | `iframe { … }` | 300×150 — **does not match a div**, a recorded gap |
 *
 * The attribute selector is specificity 0-1-0, the same as a class, so a card's
 * id rule wins outright and its class rule wins on order — this rule is in the
 * frame's reset and the card's sheet comes later.
 *
 * The last row is the gap this does not close: page-level `iframe { … }` in a
 * card selects by element type. The full-corpus census found zero of those, so
 * it is recorded rather than chased.
 */
const NESTED_FRAME_RESET =
  '[data-iris-nested-frame]{display:block;width:300px;height:150px}'

export const FA_SENTINEL = '/sandbox/fontawesome.min.css'

/**
 * The font-CSS origin admitted by default, and the one the interface body's
 * own font links are unblocked against.
 *
 * Shared between `framePolicy` and `unblockFontStylesheets` so the two cannot
 * drift: the policy admits exactly this origin because "a stylesheet or a font
 * file executes nothing", and the transform exists because a stylesheet whose
 * *absence* blocks every script in the frame defeats that premise. One fact,
 * one spelling.
 */
export const FONT_CSS_ORIGIN = 'https://fonts.googleapis.com'

export function framePolicy(networkGranted: boolean, selfOrigin: string): string {
  const remotes = REMOTE_ALLOWLIST.map(host => `https://${host}`).join(' ')

  // Fonts are the one default widening: high coverage across real cards, and a
  // stylesheet or a font file executes nothing. `fonts.googleapis.com` serves the
  // CSS, `fonts.gstatic.com` the faces — both are needed or neither works.
  const fontCss = FONT_CSS_ORIGIN
  const fontFiles = 'https://fonts.gstatic.com'
  /*
   * Iris's own origin joins the face list: a proxied stylesheet's faces are
   * rewritten onto the bundle route (`rewriteStylesheetUrls`), so a sheet the
   * allowlist already carries loads its glyphs from an origin that is Iris's
   * end to end — the same standing `script-src` and `style-src` entries rest
   * on, and strictly less than the remote origins that `script-src` already
   * admits for *code*. Without this the CSS arrives and every glyph in it is
   * still missing, with a refusal pointing at our own route.
   */
  const faceSources = `data: ${fontFiles} ${selfOrigin}`

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
    `font-src ${faceSources}`,
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
 * Whether a `<link>` tag's attributes name a stylesheet the proxy should carry.
 *
 * `rel` is read case-insensitively and may be a list; `href` must be an
 * absolute URL on the remote allowlist — the same list `script-src` names, so
 * "the frame already trusts this origin with executing code" is the floor a
 * stylesheet clears. An already-proxied href is left alone: rewriting it again
 * would nest one route inside another, and the upstream URL would be
 * recoverable only by unwrapping twice.
 */
function isProxiedStylesheetLink(tag: string): boolean {
  const attributes = linkAttributes(tag)
  const rel = attributes.get('rel')?.toLowerCase() ?? ''
  if (!rel.split(/\s+/).includes('stylesheet')) return false
  const href = attributes.get('href')
  if (href === undefined) return false
  return isAllowedRemote(href) && fromProxied(href) === undefined
}

/**
 * Point a card's remote stylesheet links at the host's bundle route.
 *
 * A card's remote stylesheets are inert — the same reasoning that admits
 * Google Fonts by default — but the frame's `style-src` is closed by default,
 * and the measured injector (人贩子物语's status bar) reaches the document the
 * way scripts do: an HTML string parsed through a `template` and appended,
 * which no markup-time pass sees. Rewriting the href to
 * `{origin}/iris/script-bundle?url=…` keeps the load inside what the policy
 * already admits — Iris's own origin, listed in `style-src` for the sentinel —
 * and inside the allowlist the host enforces on that route, rather than
 * widening `style-src` to the remote. What the proxy serves back has its
 * `@font-face` faces rewritten onto the same route, so `font-src` stays at
 * Iris's origin too; that widening is recorded at {@link framePolicy}.
 *
 * Scoped like its sibling {@link unblockFontStylesheets}: only `<link>` tags,
 * only `stylesheet` links, only origins the allowlist already trusts. Anything
 * else passes untouched and is refused by directive, reported by name — which
 * is the correct answer for a source the user never allowed.
 * @param html - markup a card authored.
 * @param origin - the shell origin, which serves the bundle route.
 * @returns the markup with allowlisted stylesheet links loading through the host.
 */
export function rewriteStylesheetLinks(html: string, origin: string): string {
  return html.replace(/<link\b[^>]*>/gi, tag => {
    if (!isProxiedStylesheetLink(tag)) return tag
    const href = linkAttributes(tag).get('href') ?? ''
    // Attribute-value level, not text level: a blanket replacement across the
    // tag could rewrite `data-href` or a comment's text. The escaped value goes
    // back inside double quotes, the one spelling `attribute()` produces.
    return tag.replace(/(\bhref\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i,
      (_match, lead: string) => `${lead}"${attribute(toProxied(href, origin))}"`)
  })
}

/**
 * A `template` whose `innerHTML` passes through the stylesheet rewrite.
 *
 * This is the measured injection route for remote stylesheets: 人贩子物语's
 * status bar parses a whole HUD document out of a JS string —
 * `hostDocument.createElement('template')`, `template.innerHTML = source`,
 * `template.content.querySelector(…)` — and appends the result. The `<link>`
 * inside that string never crosses this frame as *markup*, so the build-time
 * pass in `buildSrcdoc` cannot see it; the parse is the last moment the choice
 * of URL is still ours. Rewriting there means the browser's first fetch of the
 * sheet is the proxied one, instead of fetching into a `style-src` refusal,
 * reporting it, and only then loading the same sheet from the route it should
 * have asked for in the first place.
 *
 * A **proxy, not a copy**, because a template is a live DOM node: `content`
 * must be the real fragment the card will query and insert, and every other
 * member has to keep its native behaviour. Methods are bound to the target —
 * a DOM method invoked with the proxy as `this` is an Illegal invocation, the
 * one way this wrapper could break a card that only forwards calls. Only the
 * `innerHTML` **write** is intercepted; reads and every other property are
 * forwarded untouched.
 * @param real - the template the frame's own document built.
 * @param origin - the shell origin serving the bundle route.
 * @returns the element to hand a card as `parent.document`'s factory output.
 */
export function rewritingTemplate(real: HTMLTemplateElement, origin: string): HTMLTemplateElement {
  return new Proxy(real, {
    get(target, property): unknown {
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value): boolean {
      if (property === 'innerHTML' && typeof value === 'string') {
        value = rewriteStylesheetLinks(value, origin)
      }
      return Reflect.set(target, property, value, target)
    },
  })
}

/**
 * Whether a `<link>` tag's attributes name a default-admitted font stylesheet.
 *
 * `rel` is read case-insensitively and may be a list (`rel="preload stylesheet"`
 * is not a thing, but a defensive containment check costs nothing); `href` must
 * resolve to the font-CSS origin `framePolicy` admits by default. A link the
 * policy refuses anyway fails fast and blocks nothing, so it is not this
 * function's business.
 */
function isFontStylesheetLink(tag: string): boolean {
  const attributes = linkAttributes(tag)
  const rel = attributes.get('rel')?.toLowerCase() ?? ''
  if (!rel.split(/\s+/).includes('stylesheet')) return false
  const href = attributes.get('href')
  if (href === undefined) return false
  try {
    return new URL(href, 'https://card.invalid/').host === new URL(FONT_CSS_ORIGIN).host
  } catch {
    return false
  }
}

/** A tag's attributes, name to value, as written (no case folding of values). */
function linkAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const pattern = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  for (const match of tag.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4]
    if (value !== undefined) attributes.set(match[1]?.toLowerCase() ?? '', value)
  }
  return attributes
}

/**
 * Take a card interface's font stylesheets out of the frame's blocking sets —
 * **download and apply them still, but let nothing wait on the network.**
 *
 * The mechanism is upstream's own load-swap pattern: `media="print"` makes the
 * link download without matching the screen (so it joins neither the
 * render-blocking nor the **script-blocking** set), and the `onload` swap makes
 * it apply once it has arrived. The CSP already admits exactly this origin by
 * default on the reasoning that a font stylesheet "executes nothing" — but a
 * pending stylesheet blocks the execution of every classic script parsed after
 * it, and a card whose interface links Google Fonts on a network where that
 * fetch hangs had its own button handler held hostage behind a font: the
 * interface rendered, the button drew, and clicking it did nothing, because the
 * `<script>` defining its handler was still waiting for the CSS. That is the
 * premise defeated, and this is the completion of the same reasoning: a
 * resource admitted *because* it executes nothing must not be able to stop
 * everything that does.
 *
 * Scoped deliberately. A stylesheet the CSP refuses fails fast and blocks
 * nothing; a stylesheet the user's network grant admitted is a real decision
 * and keeps upstream's blocking semantics; same-origin links are Iris's own and
 * deterministic. A link that already carries `media` is left alone — its author
 * already decided when it applies. `@import` inside a card's own `<style>` is a
 * recorded gap: the child sheet does not join the element-created blocking set,
 * but it can hold the load event, and rewriting into a stylesheet's text is a
 * deeper surgery than this deserves until a card actually measures badly there.
 * @param body - the card's markup, as the author wrote it.
 * @returns the markup with font stylesheet links loading non-blocking.
 */
export function unblockFontStylesheets(body: string): string {
  return body.replace(/<link\b[^>]*>/gi, tag => {
    if (!isFontStylesheetLink(tag)) return tag
    const attributes = linkAttributes(tag)
    if (attributes.has('media')) return tag
    // Before the closing `>`, past a possible solidus of a self-closing tag.
    const at = tag.length - (tag.endsWith('/>') ? 2 : 1)
    return `${tag.slice(0, at)} media="print" onload="this.media='all'"${tag.slice(at)}`
  })
}

/**
 * The attribute that marks a `<style>` element as the *message's* own sheet.
 *
 * A message frame renders one region of one message, and the message's
 * `<style>` blocks belong to the whole message — upstream prefixes them with
 * `.mes_text ` and they cover panel and prose alike. So every region frame of
 * that message gets a copy in its `<head>` (`message-frames.ts` composes it,
 * `card-css.ts` confines it).
 *
 * **Why it travels attached to the markup instead of as its own option.** The
 * only path from the shell to this function is `runCard`, which forwards
 * `markup` and nothing else; a sheet passed beside it would need a field in
 * `runner.ts`. Marked, prefixed and lifted back out here, the transport costs
 * one literal and the sheet still lands where a document's stylesheets belong —
 * which matters for more than tidiness: a `<style>` left in the body is a body
 * child, so it shifts `body.children[0]` under the card's own scripts and adds
 * one to the count the blank-body detector reads as "did any CSS arrive"
 * (`frame-entry.ts` `reportBodySummary`).
 */
export const MESSAGE_CSS_MARK = 'data-iris-message-css'

/** The exact opening tag {@link withMessageCss} writes and {@link liftMessageCss} reads. */
const MESSAGE_CSS_OPEN = `<style ${MESSAGE_CSS_MARK}>`

/** Its closing tag. */
const MESSAGE_CSS_CLOSE = '</style>'

/**
 * Attach a message's own CSS to the markup of one of its region frames.
 *
 * `</style` inside the CSS is escaped, because a card's sheet is card-authored
 * and model-influenced text and a literal closer would end the element early —
 * the same hole `buildSrcdoc` escapes `</script` for. The escape is CSS's own:
 * inside a string (`content: "</style>"`, the only place the sequence can
 * legally appear) a backslash before the solidus yields the solidus, so the
 * meaning is unchanged and nothing has to be decoded again later. The backslash
 * is built from its code point for the reason `script-source.ts` records — a
 * literal one has gone missing in transit here before, and the collapsed
 * version is a silent no-op.
 * @param markup - the region's markup, as the author wrote it.
 * @param css - the message's CSS, already confined by `card-css.ts`.
 * @returns the markup with the sheet prefixed, or the markup unchanged.
 */
export function withMessageCss(markup: string, css: string): string {
  if (css.trim() === '') return markup
  const BACKSLASH = String.fromCharCode(92)
  const safe = css.replace(/<[/](?=style)/gi, `<${BACKSLASH}/`)
  return `${MESSAGE_CSS_OPEN}${safe}${MESSAGE_CSS_CLOSE}${markup}`
}

/**
 * Take that sheet back off the body, for the head.
 *
 * Only at the very start, and only the exact literal the writer emits: a card's
 * own `<style>` — wherever it sits and whatever attributes it carries — is never
 * moved, because moving a card's elements is not this function's business.
 * @param body - the frame's body markup.
 * @returns the sheet's element (empty when there is none) and the rest.
 */
function liftMessageCss(body: string): { sheet: string, rest: string } {
  if (!body.startsWith(MESSAGE_CSS_OPEN)) return { sheet: '', rest: body }
  const close = body.indexOf(MESSAGE_CSS_CLOSE, MESSAGE_CSS_OPEN.length)
  if (close === -1) return { sheet: '', rest: body }
  const past = close + MESSAGE_CSS_CLOSE.length
  return { sheet: body.slice(0, past), rest: body.slice(past) }
}

/**
 * Build a frame's document.
 *
 * The bootstrap arrives as a **URL** and is loaded by a blocking classic
 * `<script src>` from Iris's own origin — the same origin, the same
 * `script-src` entry and the same CORS route the member table and the card
 * libraries already use. A classic script with no `async`/`defer` finishes
 * before the next script element begins and before the body parses, which is
 * what the inlining was buying; the guard emitted after it is what turns "that
 * premise held" from an assumption into an observation.
 * @param token - the run token for this frame, minted per run.
 * @param bootstrapUrl - this build's bootstrap artifact, content-hashed.
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
  bootstrapUrl: string,
  options: {
    networkGranted: boolean
    libraries: readonly string[]
    /**
     * The card-facing member table's URL.
     *
     * Loaded by content-hashed URL, the same way the bootstrap now is. Optional
     * so a caller that has not been given one still builds a frame — it will
     * report the absence by name rather than fail to exist, which is the more
     * useful of the two failures.
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
     *
     * May carry the message's own sheet as a marked prefix, which is lifted
     * into the head rather than left in the body — see {@link MESSAGE_CSS_MARK}.
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
  const { body, context } = options
  /*
   * The message's own sheet, taken off the body and held for the head. See
   * `MESSAGE_CSS_MARK` for why it arrives this way; `sheet` is empty for every
   * frame that was handed no message CSS, which is every script frame and every
   * message frame of a message without a `<style>` of its own.
   */
  const message = liftMessageCss(body ?? '')
  /*
   * The seed's payload is placed inside a script element, so the one sequence
   * that could break out of it is a literal `</script`. Split rather than
   * escaped: the string is JavaScript, and an HTML escape inside it would change
   * the code. The replacement is built from a code point rather than written as
   * an escape — a literal backslash here is invisible when it goes missing,
   * `'<\/script'` and `'</script'` look almost identical, and the second is a
   * silent no-op, which is exactly the bug this line shipped with until a test
   * caught it.
   *
   * It used to guard the inlined bootstrap as well. The bootstrap is fetched
   * now, so the only card-influenced text left in a script element is the
   * snapshot — which is the one that always mattered: the bootstrap is our own
   * build output and a card's variables are not.
   */
  const BACKSLASH = String.fromCharCode(92)
  const escapeClose = (source: string): string =>
    source.split('</script').join(`<${BACKSLASH}/script`)

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
      : `<script>try{globalThis.__iris_context__=JSON.parse(${escapeClose(
          JSON.stringify(JSON.stringify(context)),
        )})}catch(e){}</script>`

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
     * It interacts with a divergence already recorded in `docs/SANDBOX.md`: Iris
     * cannot write `frameElement.style.height` across origins and posts the
     * height out instead, one frame later. So during that one frame a growing
     * interface is cut off rather than scrollable. Upstream has no such lag
     * because its write is same-origin and synchronous.
     *
     * `box-sizing` and `max-width` come from the same block. The avatar
     * background rules upstream also injects are **not** copied: they need the
     * user's and character's real avatar paths, which is host data a frame only
     * gets through the document grant.
     *
     * `color-scheme:light` on `html,body`: upstream frames are light under every
     * theme, because ST's `body` says `only light` and the frame documents say
     * nothing (`notes/UPSTREAM-THEME-VARS.md` §六). This used to be `inherit`,
     * which on a root element takes the initial value `normal` — a no-op that
     * read as a decision. The host side sets the same value on both frame
     * elements (`reading.css`, `useCardScripts.tsx`); saying it here as well
     * makes the frame document light on its own evidence, not only by
     * embedding.
     */
    body === undefined
      ? `<style>html,body{margin:0;padding:0;background:transparent;color-scheme:light}${NESTED_FRAME_RESET}</style>`
      : '<style>*,*::before,*::after{box-sizing:border-box}' +
        'html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;' +
        `background:transparent;color-scheme:light}${NESTED_FRAME_RESET}</style>`,
    /*
     * The message's own sheet, last in the head and therefore **before every
     * style the card itself writes** — its inline `style=` attributes, its
     * `<style>` elements inside the markup, anything a script installs later.
     * That is the order upstream produces for free: its message sheet sits in
     * the message DOM ahead of the panel it decorates, so a rule the panel
     * writes for itself wins a tie against the message's. It comes *after* the
     * reset above for the same reason the reset exists — the reset is this
     * frame's floor, and a card's message sheet is allowed to stand on it.
     */
    message.sheet,
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
     * The member table, **before** the bootstrap and blocking.
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
    /*
     * The seed runs **before** the bootstrap, and the order is the whole point.
     *
     * The bootstrap's install reads the seed synchronously
     * (`installSandbox` initialises its snapshot from `env.seededContext()`),
     * so a seed emitted after the bootstrap script is a seed nobody will ever
     * read — the document goes on parsing past it while `installSandbox` has
     * already answered "no snapshot". That ordering shipped once, and the
     * failure it produced was the one this frame exists not to cause: a message
     * frame's inline card script calls `getAllVariables()` at parse time, the
     * member was present but the snapshot was not, and the refusal that named
     * itself arrived as the card's failure. Position, not presence, is what
     * closes the window — asserted positionally in `sandbox-srcdoc.test.ts`.
     *
     * The seed is self-contained data (`JSON.parse` of a string literal), so it
     * needs nothing from the bootstrap — and it is wrapped so that a corrupt
     * payload degrades to "no seed" rather than to an uncaught parse error ahead
     * of the bootstrap's error reporting; the frame then refuses by name on
     * each member call, which is the honest answer for a snapshot it does not
     * have.
     */
    seed,
    /*
     * The bootstrap, **blocking and classic**, from Iris's own origin.
     *
     * No `async`, no `defer`, no `type="module"` — and none of those is a style
     * choice. A classic script with none of them runs to completion before the
     * parser moves past it, which is what makes every ordering claim in this
     * function true: the seed is already set, the member table has already
     * published, and the card's markup has not parsed yet. `defer` would move it
     * to after the whole document, which is exactly the failure the inlined
     * version could not have had. `type="module"` is deferred by definition, and
     * would additionally be CORS-checked in a way a classic script is not.
     *
     * `crossorigin="anonymous"` for the reason the member table and the
     * libraries carry it: this frame is an opaque origin, so every script it
     * loads is cross-origin to it, and without the attribute an exception thrown
     * inside the bootstrap is redacted to the bare words `Script error.` — for
     * *this* file that would erase the only diagnostic the frame has. Its other
     * half, the host's `access-control-allow-origin` on the sandbox-asset route,
     * already exists and is asserted from the host side in
     * `apps/iris/tests/sandbox-cors.test.ts`.
     *
     * The URL carries a content hash and nothing per-frame. That is deliberate:
     * the token, the origin and the snapshot all travel in the markup instead
     * (two `<meta>` tags and the seed above), because a URL that varied per
     * frame would be a fresh cache key per frame and the fetch would buy
     * nothing.
     */
    `<script src="${attribute(bootstrapUrl)}" crossorigin="anonymous" ${BOOTSTRAP_TAG_MARK}></script>`,
    /*
     * And the check that the tag above actually ran, before anything depends on
     * it having run.
     *
     * This is the position that makes it a check rather than a report: after the
     * bootstrap, so the marker is either set or definitively absent; before the
     * libraries and the card's markup, so a frame with no bridge can be stopped
     * instead of being watched throw. `bootstrap-contract.ts` holds what it does
     * and why each step is there.
     */
    `<script>${bootstrapGuard()}</script>`,
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
     *
     * The font stylesheets in the markup are rewritten on the way in — the same
     * place upstream rewrites what a card means (`vh` units, bundle imports) —
     * so a decorative font can never hold the interface's own scripts, and with
     * them its buttons, hostage to the network. See
     * `unblockFontStylesheets` for the reasoning and the scope. Before that,
     * stylesheet links aimed at the remote allowlist are pointed at the host's
     * bundle route (`rewriteStylesheetLinks`), so a card's remote sheet loads
     * from an origin the policy already admits instead of being refused by
     * `style-src`; that pass runs first so its same-origin output is not
     * mistaken for a font link by the pass below.
     */
    // `message.rest`, not `body`: the message's sheet has moved to the head, and
    // leaving a copy here would apply it twice and put a `<style>` element in
    // the card's own body.
    body === undefined ? '' : unblockFontStylesheets(rewriteStylesheetLinks(message.rest, selfOrigin)),
    '</body></html>',
  ].join('')
}
