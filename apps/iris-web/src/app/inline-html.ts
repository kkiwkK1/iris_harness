/**
 * What a card's inline HTML is allowed to be, and how we check afterwards.
 *
 * The design is `notes/apps/iris-web/INLINE-HTML.md` (3c). This module holds the parts that can be
 * decided without a DOM: the sanitizer's configuration, an audit of what came
 * back out of it, and — added later — the one piece of upstream's sanitizer
 * that has to be reproduced on the **string**, because the message renderer
 * never gives us a tree to sanitize: what happens to a tag name no browser
 * recognises ({@link unwrapUnknownTags}).
 *
 * **Why there is an audit at all.** The sanitizer is configured to forbid
 * scripts, event handlers and external loads, and configuration is exactly the
 * kind of thing that is right until someone edits it. This project's own rule
 * is that a guard must not be same-source as the thing it guards, so the check
 * that no script survived does not read the same config that was supposed to
 * remove it — it looks at the tree that actually arrived.
 *
 * **The audit does not replace the sanitizer.** It cannot: by the time it runs,
 * the string has already been parsed. It is a tripwire that says the policy and
 * the outcome disagree, which is a thing worth knowing loudly and immediately.
 *
 * @module iris-web/app/inline-html
 */

/**
 * Tags that never survive, stated rather than inherited.
 *
 * [notes/apps/iris-web/INLINE-HTML.md §4.1 / checklist item 3] Upstream writes only `ADD_TAGS`
 * because it trusts the sanitizer's default allow-list. **We are tightening, so
 * the tightening has to be on paper** — a default that widens in a later
 * release would otherwise widen us with it, silently, in a dependency bump.
 *
 * `script` is the whole of ruling ③: **a fragment never gains script
 * capability, scripts live only in frames.** That is the same decision the
 * sandbox grants make, one surface over — a frame is isolated and can be
 * refused wholesale, while a fragment renders into the host's own DOM.
 */
export const FORBIDDEN_TAGS: readonly string[] = [
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'link',
  'meta',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'template',
  'noscript',
]

/**
 * Attributes that never survive.
 *
 * Event handlers are the script surface again, arriving one attribute at a
 * time. `style` is **kept** deliberately: a card styling its own panel inline is
 * the ordinary case, and the scoping in `card-css.ts` handles the stylesheet
 * form. What is refused is anything that fetches or navigates.
 */
export const FORBIDDEN_ATTRS: readonly string[] = [
  'srcset',
  'formaction',
  'action',
  'ping',
  'background',
  'dynsrc',
  'lowsrc',
]

/**
 * The only URI shapes an attribute may carry.
 *
 * Fragment references and same-page anchors only. [§4.3] refuses every external
 * load at a measured cost of zero on the corpus — with the caveat that matters
 * more than the zero: it says the tightening hits nothing that *exists*, not
 * that it never will.
 *
 * `javascript:` is refused by this being an allow-list rather than a
 * deny-list — a deny-list has to anticipate `JaVaScRiPt:`, `java\0script:` and
 * whatever the next parser bug spells it as.
 */
export const ALLOWED_URI = /^(?:#|\.?\/|mailto:)/i

/**
 * Element names a browser — and therefore upstream's sanitizer — recognises.
 *
 * DOMPurify's default `ALLOWED_TAGS`, transcribed: the union of its `html`,
 * `svg`, `svgFilters` and `mathMl` name lists
 * (`dompurify/dist/purify.cjs.js:301-309`, combined at `:605`), which is what
 * upstream gets because `messageFormatting` passes no `ALLOWED_TAGS` and no
 * `USE_PROFILES` — only `ADD_TAGS: ['custom-style']` (`public/script.js:1898-1908`).
 * `custom-style` is included here for the same reason.
 *
 * `#text` is left out: this set is asked about **tag names**, and a text node
 * has none. Names absent on purpose and worth naming, because they read as
 * omissions: `script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`,
 * `noscript` — DOMPurify forbids all of those *by leaving them out*, and this
 * transcription keeps that.
 *
 * **This is a measurement, not a preference**, so it is compared against the
 * installed DOMPurify in `tests/inline-html.test.ts` rather than trusted.
 */
export const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'acronym', 'address', 'altglyph', 'altglyphdef', 'altglyphitem', 'animatecolor',
  'animatemotion', 'animatetransform', 'area', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo',
  'big', 'blink', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'center', 'circle',
  'cite', 'clippath', 'code', 'col', 'colgroup', 'content', 'custom-style', 'data', 'datalist',
  'dd', 'decorator', 'defs', 'del', 'desc', 'details', 'dfn', 'dialog', 'dir', 'div', 'dl', 'dt',
  'element', 'ellipse', 'em', 'enterkeyhint', 'exportparts', 'feblend', 'fecolormatrix',
  'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting',
  'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca', 'fefuncb',
  'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology',
  'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
  'fieldset', 'figcaption', 'figure', 'filter', 'font', 'footer', 'form', 'g', 'glyph',
  'glyphref', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hkern', 'hr',
  'html', 'i', 'image', 'img', 'input', 'inputmode', 'ins', 'kbd', 'label', 'legend', 'li',
  'line', 'lineargradient', 'main', 'map', 'mark', 'marker', 'marquee', 'mask', 'math',
  'menclose', 'menu', 'menuitem', 'merror', 'metadata', 'meter', 'mfenced', 'mfrac', 'mglyph',
  'mi', 'mlabeledtr', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mpath', 'mphantom',
  'mprescripts', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msubsup', 'msup',
  'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'nav', 'nobr', 'ol', 'optgroup',
  'option', 'output', 'p', 'part', 'path', 'pattern', 'picture', 'polygon', 'polyline', 'pre',
  'progress', 'q', 'radialgradient', 'rect', 'rp', 'rt', 'ruby', 's', 'samp', 'search',
  'section', 'select', 'shadow', 'slot', 'small', 'source', 'spacer', 'span', 'stop', 'strike',
  'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'switch', 'symbol', 'table', 'tbody', 'td',
  'template', 'text', 'textarea', 'textpath', 'tfoot', 'th', 'thead', 'time', 'title', 'tr',
  'track', 'tref', 'tspan', 'tt', 'u', 'ul', 'var', 'video', 'view', 'vkern', 'wbr',
])

/**
 * Unrecognised names whose **content** goes with the element, not just its tags.
 *
 * DOMPurify keeps a removed element's children unless the name is in
 * `FORBID_CONTENTS` (`purify.cjs.js:724` for the list, `:1756` for the branch
 * that consults it). Most of that list is allowed anyway, so it never fires;
 * these are the names that are unrecognised **and** content-forbidding, which
 * is where the two rules combine into "the whole subtree disappears".
 *
 * It matters here rather than being trivia: unwrapping `<script>` and keeping
 * its children would put a card's JavaScript **source** into the reader's
 * prose. Upstream shows nothing, and so does this.
 */
export const UNKNOWN_CONTENT_FORBIDDEN: ReadonlySet<string> = new Set([
  'annotation-xml', 'foreignobject', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext',
  'script', 'selectedcontent', 'xmp',
])

/*
 * `selectedcontent` is the one name here that is **ahead** of the SillyTavern
 * installation measured: it entered `FORBID_CONTENTS` after DOMPurify 3.4.2
 * (what that checkout resolved) and this app depends on ^3.4.14, so the copy
 * whose defaults are being mirrored has it and the measured one does not. The
 * difference is that a `<selectedcontent>x</selectedcontent>` would show `x`
 * there and nothing here. Kept rather than trimmed, because the set is defined
 * as "what our DOMPurify does" and the drift test compares it to exactly that
 * — a hand-trimmed entry would make the check disagree with its own subject.
 */

/**
 * Whether a browser would build a real element for this tag name.
 *
 * @param name - a tag name, any case.
 * @returns true when the name is in {@link KNOWN_ELEMENTS}.
 */
export function isKnownElement(name: string): boolean {
  return KNOWN_ELEMENTS.has(name.toLowerCase())
}

/**
 * Where the inline code spans of a run of prose are.
 *
 * CommonMark's rule, simplified to what it takes to *not damage* a code span: a
 * run of N backticks opens, the next run of exactly N closes, and an unclosed
 * run is literal text. Needed because a card that documents its own markup —
 * `` `<Gui>` `` in a note to the reader — must keep the characters it wrote,
 * and because upstream keeps them too: showdown hashes code before it ever
 * looks at raw HTML (`showdown.js:2503-2506` runs `hashPreCodeTags` and
 * `githubCodeBlocks` before `blockGamut`), so tags inside code reach DOMPurify
 * already escaped.
 *
 * @param text - one run of prose.
 * @returns the spans, in order, as half-open offsets.
 */
function codeSpans(text: string): { start: number, end: number }[] {
  const spans: { start: number, end: number }[] = []
  const TICK = String.fromCharCode(96)
  let at = 0
  while (at < text.length) {
    if (text.charAt(at) !== TICK) {
      at += 1
      continue
    }
    let width = 0
    while (text.charAt(at + width) === TICK) width += 1

    let scan = at + width
    let closed = -1
    while (scan < text.length) {
      if (text.charAt(scan) !== TICK) {
        scan += 1
        continue
      }
      let run = 0
      while (text.charAt(scan + run) === TICK) run += 1
      if (run === width) {
        closed = scan + run
        break
      }
      scan += run
    }

    if (closed === -1) {
      // No closer: the backticks are ordinary characters, and whatever follows
      // them is still prose the tag rule applies to.
      at += width
      continue
    }
    spans.push({ start: at, end: closed })
    at = closed
  }
  return spans
}

/**
 * Find `</name …>` in `rest`, case-insensitively.
 *
 * Searched with `indexOf` rather than a constructed pattern: the name comes from
 * the card's own text, and building a regex out of card text is how a `.` in a
 * tag name becomes a wildcard.
 * @param rest - the text after the opening tag.
 * @param name - the lower-cased tag name.
 * @returns the offset just past the closing tag, or -1.
 */
function closerEnd(rest: string, name: string): number {
  const at = rest.toLowerCase().indexOf(`</${name}`)
  if (at === -1) return -1
  const shut = rest.indexOf('>', at)
  return shut === -1 ? -1 : shut + 1
}

/**
 * Remove markup a browser would not build an element for, keeping its content.
 *
 * **This is upstream's behaviour, arrived at from the other side.** Upstream
 * hands the whole formatted message to DOMPurify (`public/script.js:1907`), and
 * a name outside `ALLOWED_TAGS` takes the branch at
 * `dompurify/dist/purify.cjs.js:1894`, which hands it to
 * `_sanitizeDisallowedNode` (`:1743`): the children are re-inserted where the
 * element stood and the element is force-removed — unless the name is in
 * `FORBID_CONTENTS` (the guard at `:1756`), when the subtree goes too. A
 * self-closing `<StatusPlaceHolderImpl/>` has no children, so it simply
 * disappears; the `HTMLUnknownElement` branch of upstream's own
 * `uponSanitizeElement` hook (`public/scripts/chats.js:1943-1972`) exists
 * precisely because these elements *do* reach the sanitizer as elements.
 *
 * Iris cannot copy the mechanism, because there is no tree to sanitize — the
 * renderer disables raw HTML (`app/html-regions.ts`, module note) — so the same
 * outcome is reached on the string, before it is handed over. Without this a
 * card's `<Gui>` wrapper arrived on the reading surface as the escaped text
 * `<Gui>`, which its author has never seen in SillyTavern.
 *
 * **Recognised names are deliberately left alone.** They are escaped by the
 * renderer and show as source, which is a different and older gap (the inline
 * path of `notes/apps/iris-web/INLINE-HTML.md` §三, deliberately not taken —
 * see DEVIATIONS entry 25); removing their tags here would quietly change what
 * that gap looks like without closing it.
 *
 * **Nothing here can create an element.** The result goes to `MarkdownText`,
 * which renders it as text; this transform only decides which characters the
 * reader sees. It is therefore not a sanitizer and is not a place to relax one.
 *
 * @param prose - a run of message text with no fenced or indented code in it.
 * @returns the same text with unrecognised markup removed.
 */
export function unwrapUnknownTags(prose: string): string {
  const spans = codeSpans(prose)
  let out = ''
  let at = 0
  for (const span of spans) {
    out += rewriteTags(prose.slice(at, span.start))
    out += prose.slice(span.start, span.end)
    at = span.end
  }
  out += rewriteTags(prose.slice(at))
  return out
}

/**
 * The tag rule itself, over one stretch with no code in it.
 * @param text - prose without code spans.
 * @returns the text with unrecognised markup removed.
 */
function rewriteTags(text: string): string {
  /*
   * A tag, as a lexer sees one: `<name …>` or `</name …>`. Built per call
   * rather than shared at module scope, because a sticky `lastIndex` on a
   * shared `g` regex is state two callers can hand each other.
   *
   * `[^>]*` is a lexer, not a parser: an unrecognised tag whose attribute value
   * contains a literal `>` ends early and leaves the remainder as text. A
   * browser's tokenizer tracks quotes; the corpus has no such tag, and the
   * failure is visible rather than silent.
   */
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9.:_-]*)[^>]*>/g
  let out = ''
  let at = 0
  let found = TAG.exec(text)
  while (found !== null) {
    const name = (found[2] ?? '').toLowerCase()
    if (isKnownElement(name)) {
      found = TAG.exec(text)
      continue
    }

    out += text.slice(at, found.index)
    const past = found.index + found[0].length

    if (found[1] === '' && UNKNOWN_CONTENT_FORBIDDEN.has(name)) {
      /*
       * Element **and** content. An unclosed one takes the rest of the stretch,
       * which is what a browser does with an unterminated `<script>` — its
       * content is everything that follows.
       */
      const shut = closerEnd(text.slice(past), name)
      at = shut === -1 ? text.length : past + shut
    } else {
      at = past
    }

    TAG.lastIndex = at
    found = TAG.exec(text)
  }
  return out + text.slice(at)
}

/** One thing the audit found that the policy says should not be there. */
export interface Violation {
  /** What was found, in words that name the thing. */
  what: string
  /** Where, as a tag path, so a card author can find it. */
  where: string
}

/** The shape the audit needs, so it can run without a DOM in tests. */
export interface AuditNode {
  /** Upper- or lower-case tag name; comparison is case-insensitive. */
  tagName?: string | undefined
  /** Attribute names and values. */
  attributes?: readonly { name: string, value: string }[] | undefined
  children?: readonly AuditNode[] | undefined
}

/**
 * Check what the sanitizer actually returned against what the policy allows.
 *
 * Deliberately **not** written in terms of {@link FORBIDDEN_TAGS}: reading the
 * same list that configured the sanitizer would make this agree with a broken
 * configuration as readily as with a working one. The tags named here are the
 * ones whose presence is a capability rather than a style — script execution,
 * navigation, framing, submission — restated independently on purpose.
 *
 * @param root - the sanitized tree.
 * @returns everything found that should not have survived.
 */
export function auditSanitized(root: AuditNode): Violation[] {
  const found: Violation[] = []

  const walk = (node: AuditNode, path: string): void => {
    const tag = (node.tagName ?? '').toLowerCase()
    // No leading separator at the root: the path is printed for a card author
    // to follow, and `>div>script` reads as though something sat above the div.
    const here = tag === '' ? path : path === '' ? tag : `${path}>${tag}`

    if (['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'].includes(tag)) {
      found.push({ what: `a <${tag}> element survived sanitizing`, where: here })
    }

    for (const attribute of node.attributes ?? []) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value

      // An event handler is script arriving one attribute at a time.
      if (name.startsWith('on')) {
        found.push({ what: `an event handler (${name}) survived sanitizing`, where: here })
        continue
      }

      /*
       * `src`/`href`-shaped attributes are checked by value, and the check is an
       * allow-list. A deny-list would have to anticipate every spelling of
       * `javascript:` that a parser accepts.
       */
      if (['src', 'href', 'xlink:href', 'poster', 'data', 'srcset'].includes(name)) {
        if (value.trim() !== '' && !ALLOWED_URI.test(value.trim())) {
          found.push({
            what: `${name} pointing outside the document (${describeTarget(value)})`,
            where: here,
          })
        }
      }
    }

    for (const child of node.children ?? []) walk(child, here)
  }

  walk(root, '')
  return found
}

/**
 * Name a refused target so the report is more specific than the card's own.
 *
 * [notes/TEST-CARDS.md / `docs/OBSERVABILITY.md` gap 8] Cards print their own message when
 * a resource does not arrive — one blames the reader's installation. A report
 * that says only "something was refused" loses to that, because the card's
 * explanation is the more specific of the two and specific is what gets
 * believed.
 * @param value - the attribute value.
 * @returns a short description naming the host or scheme.
 */
export function describeTarget(value: string): string {
  const trimmed = value.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme === 'javascript') return 'a javascript: URL'
  if (scheme === 'data') return 'a data: URL'
  if (trimmed.startsWith('//') || (scheme !== undefined && trimmed.includes('//'))) {
    try {
      return new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed).host || trimmed.slice(0, 60)
    } catch {
      return trimmed.slice(0, 60)
    }
  }
  return trimmed.slice(0, 60)
}
