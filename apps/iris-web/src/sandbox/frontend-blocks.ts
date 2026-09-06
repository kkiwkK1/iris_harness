/**
 * Which code blocks in a message are card interfaces.
 *
 * Step one of the message-frame pipeline, and deliberately the whole of it: this
 * decides what would be *claimed* and builds no frames. `notes/apps/iris-web/RENDER.md` puts the
 * caliper first and the diagnostics last for a reason — the first cut can be
 * entirely wrong about which blocks to claim, and the local corpus cannot tell
 * us, because it contains exactly one hit and that hit is a loader stub.
 *
 * Two properties are copied from upstream deliberately, and both look like bugs
 * until you know why:
 *
 * - **The fence's info string is never read.** Upstream tests content, not
 *   language, so a block labelled ```` ```text ```` is claimed exactly like one
 *   labelled ```` ```html ````. The single real block in the corpus is labelled
 *   `text`, so routing by language would claim nothing at all.
 * - **It is substring containment, not parsing.** A block that merely *mentions*
 *   `<body` — a tutorial, a bug report, a census like the one that measured this
 *   — is claimed. That false-positive surface is upstream behaviour and is not
 *   narrowed here: tightening it would drop real cards, and the safety argument
 *   is the sandbox wall rather than the predicate's precision.
 *
 * And one property that is *not* copied, because copying it would have been
 * wrong: there is **no entity decoding**. See `notes/apps/iris-web/RENDER.md`'s retraction — showdown
 * escapes a block's body before the DOM exists, so upstream's `.text()` hands
 * back the author's own characters, and decoding here would claim blocks upstream
 * leaves alone.
 *
 * @module iris-web/sandbox/frontend-blocks
 */

import { splitHtmlRegions, type MessageStyle } from '../app/html-regions.ts'
import { unwrapUnknownTags } from '../app/inline-html.ts'
import { scopeCardCss } from '../app/card-css.ts'

/** What upstream looks for, verbatim (`src/util/is_frontend.ts:1-3`). */
const MARKERS: readonly string[] = ['html>', '<head>', '<body']

/** A newline, built rather than escaped — see `script-source.ts` for why. */
const NEWLINE = String.fromCharCode(10)

/** How a block was written. Recorded for diagnostics, never for the decision. */
export type BlockKind = 'fenced' | 'indented' | 'bare-html'

/** One claimed block. */
export interface FrontendBlock {
  /** Offset of the block's first character in the message source. */
  start: number
  /** Offset just past the block's last character. */
  end: number
  /** The block's body — what a frame would run. */
  body: string
  kind: BlockKind
  /**
   * The fence's info string, or undefined for an indented block.
   *
   * Carried so a diagnostic can say "claimed a block labelled `text`", which is
   * the most surprising thing the predicate does. Never consulted.
   */
  info?: string
  /** Which marker matched, so a report can say why this block was claimed. */
  matched: string
}

/**
 * Whether a block's body reads as a front end, and which marker said so.
 *
 * @param body - the block's body, exactly as the author wrote it.
 * @returns the marker that matched, or undefined when none did.
 */
export function frontendMarker(body: string): string | undefined {
  return MARKERS.find(marker => body.includes(marker))
}

/**
 * Every fenced or indented code block in a message, claimed or not.
 *
 * The scanner `claimFrontendBlocks` runs, kept whole so the bare-HTML composer
 * below sees the same spans the fence pipeline sees — one line-walk over the
 * message, not two that could disagree about where a block begins.
 *
 * An unclaimed span is still a span: its body did not read as a front end, but
 * it is still code to the renderer, which is a fact the bare-HTML split has to
 * respect (see `claimMessageSurfaces`).
 */
interface ScannedCodeBlock {
  /** Offset of the block's first character in the message source. */
  start: number
  /** Offset just past the block's last character. */
  end: number
  /** The block's body — what a frame would run. */
  body: string
  kind: BlockKind
  info?: string
  /** Whether the body read as a front end. */
  claimed: boolean
  /** Which marker matched, when claimed. */
  matched?: string
}

/**
 * Find every code block in a message and mark the ones that look like interfaces.
 *
 * Scanned line by line with string operations rather than matched with a pattern,
 * for the reason recorded across this package: escapes here have been eaten in
 * transit repeatedly, and a collapsed one still parses while matching nothing.
 *
 * @param source - the message text, as stored.
 * @returns every code block, in source order, with its claim verdict.
 */
function scanCodeBlocks(source: string): ScannedCodeBlock[] {
  const scanned: ScannedCodeBlock[] = []
  const lines = source.split(NEWLINE)

  /** Offset of the first character of `lines[at]`. */
  const offsets: number[] = []
  let cursor = 0
  for (const line of lines) {
    offsets.push(cursor)
    cursor += line.length + NEWLINE.length
  }

  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    const fence = openingFence(line)

    if (fence !== undefined) {
      /*
       * A fence closes on the first line that is a fence of the same character
       * and at least as long, per CommonMark. An unclosed fence runs to the end
       * of the message, which is what a streaming reply looks like mid-flight —
       * claimed here, because a half-arrived interface is still that interface,
       * and the caller decides whether to wait.
       */
      const bodyFrom = at + 1
      let to = bodyFrom
      while (to < lines.length && !closesFence(lines[to] ?? '', fence)) to += 1

      const body = lines.slice(bodyFrom, to).join(NEWLINE)
      const marker = frontendMarker(body)
      scanned.push({
        start: offsets[at] ?? 0,
        end: to < lines.length ? (offsets[to] ?? source.length) + (lines[to] ?? '').length : source.length,
        body,
        kind: 'fenced',
        ...(fence.info === '' ? {} : { info: fence.info }),
        claimed: marker !== undefined,
        ...(marker === undefined ? {} : { matched: marker }),
      })
      at = to + 1
      continue
    }

    if (opensIndentedBlock(lines, at)) {
      let to = at
      // Blank lines belong to an indented block only when indented content
      // follows them; a trailing blank line is not part of it.
      let lastContent = at
      while (to < lines.length) {
        const current = lines[to] ?? ''
        if (isIndented(current)) {
          lastContent = to
          to += 1
          continue
        }
        if (current.trim() === '') {
          to += 1
          continue
        }
        break
      }

      const body = lines
        .slice(at, lastContent + 1)
        .map(entry => stripIndent(entry))
        .join(NEWLINE)
      const marker = frontendMarker(body)
      scanned.push({
        start: offsets[at] ?? 0,
        end: (offsets[lastContent] ?? 0) + (lines[lastContent] ?? '').length,
        body,
        kind: 'indented',
        claimed: marker !== undefined,
        ...(marker === undefined ? {} : { matched: marker }),
      })
      at = to
      continue
    }

    at += 1
  }

  return scanned
}

/**
 * Find every code block in a message and claim the ones that look like interfaces.
 *
 * The claim verdict is the fence pipeline's own predicate, unchanged; this
 * wrapper only keeps the verdict's shape the callers have always had.
 *
 * @param source - the message text, as stored.
 * @returns the claimed blocks, in source order.
 */
export function claimFrontendBlocks(source: string): FrontendBlock[] {
  return scanCodeBlocks(source)
    .filter(block => block.claimed)
    .map(block => ({
      start: block.start,
      end: block.end,
      body: block.body,
      kind: block.kind,
      ...(block.info === undefined ? {} : { info: block.info }),
      matched: block.matched ?? '',
    }))
}

/**
 * Strip unrecognised markup from a message's prose, leaving its code alone.
 *
 * The policy is `app/inline-html.ts`'s ({@link unwrapUnknownTags}); what this
 * adds is *where it may run*, and that is why it lives here rather than there:
 * this module already owns the one line-walk that knows where a message's code
 * blocks are ({@link scanCodeBlocks}), and a second walk that disagreed with it
 * about where a fence begins is exactly the drift the walk was kept whole to
 * avoid.
 *
 * Code is skipped whatever it is — claimed or not, fenced or indented. A card
 * that documents its own markup in a fence wrote those characters on purpose,
 * and upstream keeps them too: showdown turns a fence into `<pre><code>` with
 * its body escaped (`showdown.js:2504`, before any raw-HTML handling), so the
 * tags inside reach DOMPurify as text and survive.
 *
 * Applied to the **prose handed to the renderer**, not to the text the claim
 * pipeline reads: claims are offsets into the message as stored, and rewriting
 * underneath them would move every boundary they name.
 *
 * @param source - a run of message text, prose and code together.
 * @returns the same text with unrecognised markup removed outside code.
 */
export function unwrapUnknownTagsOutsideCode(source: string): string {
  let out = ''
  let at = 0
  for (const block of scanCodeBlocks(source)) {
    // `scanCodeBlocks` reports blocks in source order and never overlapping,
    // but the clamp is cheap and keeps a future scanner change from producing
    // duplicated text rather than a caught mistake.
    const from = Math.max(at, block.start)
    const to = Math.max(at, block.end)
    if (from > at) out += unwrapUnknownTags(source.slice(at, from))
    out += source.slice(from, to)
    at = to
  }
  return out + unwrapUnknownTags(source.slice(at))
}

/** What claiming found in one message: every frameable surface, and the notes. */
export interface ClaimedSurfaces {
  /**
   * Claimed fenced blocks and bare HTML regions, in source order.
   *
   * One list, because the instance number a frame is addressed by has to mean
   * the same thing at every place that counts or renders one: the budget plans
   * over this list, the controller runs it, and the row splices it into the
   * prose. Three claimers with different lists would renumber each other's
   * frames.
   */
  blocks: FrontendBlock[]
  /**
   * Notes from the HTML-region split — an unclosed region, reported rather
   * than swallowed. Empty when every region closed.
   */
  refused: readonly string[]
  /**
   * The message's own `<style>` spans, which are neither frames nor prose.
   *
   * Handed back so the row can splice the same characters out of the text it
   * gives the renderer. Leaving them in would trade an empty frame for a
   * screenful of escaped CSS in the middle of the message — `MarkdownText`
   * disables raw HTML, so a `<style>` element reaching it arrives as *text*.
   */
  styles: readonly MessageStyle[]
  /**
   * Those styles, confined and ready for a region frame's head.
   *
   * One string for the whole message, because the message is the scope: every
   * region frame gets this same sheet, which is the only construction that
   * reproduces upstream's one-DOM-per-floor behaviour across frames that cannot
   * see each other. Empty when the message wrote no style of its own, and empty
   * when everything it wrote was refused.
   */
  css: string
}

/**
 * The message's identity, as `card-css.ts` names a scope.
 *
 * A constant rather than the floor or a sequence number, and the reason is that
 * **the scope is not a message here, it is a document**: the sheet is installed
 * in a frame that holds one region of one message, so there is nothing else in
 * that document for it to collide with or leak onto. The seq's usual job —
 * keeping two messages' sheets apart in one shared DOM — is done by the frame
 * boundary before this string is read.
 */
const MESSAGE_SCOPE_SEQ = 'msg'

/**
 * The scope root a message's sheet is confined to inside a frame.
 *
 * `body`, which is upstream's rule expressed in this document's terms:
 * `decodeStyleTags` prefixes every selector with `.mes_text `, the element that
 * holds the message's markup, so a message sheet upstream cannot reach the page
 * root either. Measured on the corpus's 13 message sheets: **none** carries a
 * rule for `html`, `body` or `:root`, and none reaches for a SillyTavern
 * container (`.mes_text`, `#chat`) — so the root a `@scope` cannot match is not
 * a root any of them tries to style.
 */
const MESSAGE_SCOPE_ROOT = 'body'

/**
 * Claim every frameable surface of a message: fenced blocks **and** bare HTML.
 *
 * The message-frame pipeline until now claimed only code blocks — the shape a
 * card author marks explicitly. Cards also write HTML **without** any fence
 * (upstream renders message HTML in place, so they can): a status widget that
 * is a bare `<div>` arrived as escaped source text on the reading surface. The
 * split that names those spans is `splitHtmlRegions`, measured against the
 * 936-floor fragment corpus; this is where it stops having no consumers.
 *
 * **Composition order is the whole design, and it is fence-first.** The two
 * claimers describe the same text with different grammars, so one has to win
 * where they overlap, and the fence does:
 *
 * - The split runs only on the prose **between fences**, so a fence body's
 *   line-initial tags are never read as bare HTML — a claimed block is not
 *   double-claimed, and an ordinary code sample inside a fence stays code.
 * - Unclaimed fences (a body without the three markers) are excluded too.
 *   Their tags cannot open regions without also stranding the fence markers
 *   themselves in the prose, which would trade rendered source for leaked
 *   backticks. Upstream shows such a block as source as well.
 * - Indented blocks are **not** excluded. Their lines carry four or more
 *   leading spaces and a region can only open at up to three (the split is
 *   CommonMark's own boundary), so no region begins inside one — while a
 *   widget's own deep-indented lines behind blank lines *are* CommonMark
 *   indented blocks, and excluding them would carve real panels in half.
 *   The one clash this can still produce — a claimed indented block inside
 *   what would otherwise be a region — resolves to the claimed block, and the
 *   overlapped region falls back to the renderer, which is the behaviour the
 *   message had before this pipeline existed.
 *
 * **A `<style>` block is a third thing, and it is not a surface.** Upstream is
 * one DOM per floor: a message's sheet is prefixed with `.mes_text ` and covers
 * the whole message. Iris is one frame per region, and the frames cannot see
 * each other — so a sheet that became its own region became a frame with
 * nothing to style, while the panel it was written for sat in the next frame
 * without it (爱衣's variable panel: 812px of empty black, a `<details>` that
 * opened onto `opacity:0`). The sheet therefore leaves the region sequence, is
 * confined once for the message, and is copied into **every** region frame of
 * it. Copying is not an optimisation to remove later: with one frame per region
 * it is the only construction equivalent to a message-wide scope.
 *
 * @param source - the message text, after display regex.
 * @returns the claimed surfaces, in source order, the message's own style
 *   spans, the sheet to install in their frames, and any notes.
 */
export function claimMessageSurfaces(source: string): ClaimedSurfaces {
  const scanned = scanCodeBlocks(source)
  const claimed = claimFrontendBlocks(source)

  const regions: FrontendBlock[] = []
  const notes: string[] = []
  const styles: MessageStyle[] = []

  // Fences — claimed or not — bound the prose the split may read. `cursor`
  // walks the source and collects one split per gap between them.
  let cursor = 0
  for (const span of scanned) {
    if (span.kind !== 'fenced') continue
    if (span.start > cursor) collectRegions(source, cursor, span.start, regions, notes, styles)
    if (span.end > cursor) cursor = span.end
  }
  if (cursor < source.length) collectRegions(source, cursor, source.length, regions, notes, styles)

  /*
   * A claimed code block outranks a region that reaches into it — the fence
   * pipeline's claims are the incumbent behaviour, and a region loses to one
   * rather than framing half a panel beside it. Claims and regions are each
   * internally disjoint, so dropping the clashing regions leaves one
   * non-overlapping list in source order.
   */
  const safe = regions.filter(region =>
    !claimed.some(block => region.start < block.end && block.start < region.end)
  )
  const blocks = [...claimed, ...safe].sort((left, right) => left.start - right.start)

  /*
   * The message's sheet, confined once for the whole message.
   *
   * Through `card-css.ts` and not a private copy of its rules: `@import` and
   * `@font-face` fetch, and a second implementation of that refusal list is how
   * the two would come to disagree about which one of them still refuses.
   * Keyframes keep their names here — see `KeyframePolicy` and the 5-of-13
   * measurement behind it.
   */
  const written = styles.map(style => style.css).join(NEWLINE)
  const scoped = written.trim() === ''
    ? { css: '', refused: [] as readonly string[] }
    : scopeCardCss(written, MESSAGE_SCOPE_SEQ, MESSAGE_SCOPE_ROOT, 'keep')
  for (const refusal of scoped.refused) notes.push(refusal)

  /*
   * A sheet with nothing to style is dropped and said out loud.
   *
   * The frames a message sheet is copied into are the ones that stand in for
   * the message's own DOM — its bare-HTML regions. A **fenced** block is a
   * different thing: upstream renders that one in an iframe of its own, which
   * its `.mes_text`-prefixed message sheet does not reach either, so copying
   * ours in would be a divergence rather than a fix. When a message has no
   * region frame at all, the sheet has no equivalent destination, and silence
   * would leave a card author looking for a panel whose CSS simply evaporated.
   */
  const reachable = blocks.some(block => block.kind === 'bare-html')
  if (styles.length > 0 && !reachable) {
    notes.push(
      'a <style> block in this message has nothing to style —'
      + ' the message has no HTML of its own, so the CSS was dropped',
    )
  }

  return {
    blocks,
    refused: notes,
    styles,
    css: reachable ? scoped.css : '',
  }
}

/**
 * Run the HTML-region split over one gap between fences, in place.
 *
 * @param source - the whole message, so regions come back in source offsets.
 * @param from - gap start, inclusive.
 * @param to - gap end, exclusive.
 * @param out - where claimed regions accumulate.
 * @param notes - where the split's unclosed-region notes accumulate.
 * @param styles - where the message's own `<style>` spans accumulate, in
 *   source offsets like everything else here.
 */
function collectRegions(
  source: string,
  from: number,
  to: number,
  out: FrontendBlock[],
  notes: string[],
  styles: MessageStyle[],
): void {
  const split = splitHtmlRegions(source.slice(from, to))
  for (const note of split.refused) notes.push(note)
  for (const style of split.styles) {
    styles.push({ start: from + style.start, end: from + style.end, css: style.css })
  }
  for (const region of split.regions) {
    if (region.kind !== 'html') continue
    out.push({
      start: from + region.start,
      end: from + region.end,
      body: region.text,
      kind: 'bare-html',
      // Why it was claimed, in the same shape the fence pipeline reports: the
      // line-initial tag that opened the region.
      matched: /^ {0,3}<[a-zA-Z][a-zA-Z0-9-]*/.exec(region.text)?.[0] ?? '<',
    })
  }
}

/** A fence's character and width, plus whatever followed it on the line. */
export interface Fence {
  char: string
  width: number
  info: string
}

/**
 * Read an opening code fence, if this line is one.
 *
 * Up to three leading spaces are allowed before a fence (CommonMark); four would
 * make it indented code instead.
 *
 * Exported rather than kept private because the fence grammar is the one thing
 * that must not grow a second implementation: the stray-fence repair
 * (`app/stray-fences.ts`) walks a message with these same two predicates, so a
 * repaired text and the claim built over it cannot disagree about where a fence
 * begins or ends.
 * @param line - the line to inspect.
 * @returns the fence, or undefined when this line opens nothing.
 */
export function openingFence(line: string): Fence | undefined {
  const indent = line.length - line.trimStart().length
  if (indent > 3) return undefined
  const rest = line.slice(indent)
  const char = rest.charAt(0)
  if (char !== '`' && char !== '~') return undefined

  let width = 0
  while (rest.charAt(width) === char) width += 1
  if (width < 3) return undefined

  const info = rest.slice(width).trim()
  /*
   * A backtick fence's info string may not contain a backtick — otherwise
   * ``` `code` ``` inline spans would read as fences. Tilde fences have no such
   * rule.
   */
  if (char === '`' && info.includes('`')) return undefined
  return { char, width, info }
}

/**
 * Whether a line closes the given fence. Exported with {@link openingFence} for
 * the same reason: one fence grammar, wherever a fence matters.
 * @param line - the line to inspect.
 * @param fence - the fence that is open.
 * @returns true when this line ends the block.
 */
export function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim()
  if (trimmed.length < fence.width) return false
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed.charAt(index) !== fence.char) return false
  }
  return true
}

/** Whether a line is indented enough to be code. */
function isIndented(line: string): boolean {
  return line.startsWith('    ') || line.startsWith(String.fromCharCode(9))
}

/** Remove one level of code indentation. */
function stripIndent(line: string): string {
  if (line.startsWith('    ')) return line.slice(4)
  if (line.startsWith(String.fromCharCode(9))) return line.slice(1)
  return line
}

/**
 * Whether an indented code block starts at this line.
 *
 * The rule that matters and is easy to miss: **indented code cannot interrupt a
 * paragraph** (CommonMark). An indented line after a text line is a lazy
 * continuation of that paragraph, not code — so a message whose prose happens to
 * be indented does not become a claimable block. Without this, ordinary wrapped
 * narration would be scanned as code, and any of it mentioning `<body` claimed.
 * @param lines - every line of the message.
 * @param at - the candidate line.
 * @returns true when a block opens here.
 */
function opensIndentedBlock(lines: readonly string[], at: number): boolean {
  if (!isIndented(lines[at] ?? '')) return false
  if (stripIndent(lines[at] ?? '').trim() === '') return false
  const previous = at === 0 ? '' : lines[at - 1] ?? ''
  return at === 0 || previous.trim() === ''
}

/** One piece of a message: prose to render, or an interface to mount. */
export type MessageSegment =
  | { kind: 'text', text: string }
  | { kind: 'interface', block: FrontendBlock, instance: number }

/**
 * Split a message so each claimed block is **replaced** by its interface.
 *
 * Upstream replaces: it wraps the `<pre>` in a `div.TH-render`, hides the block and
 * puts the iframe in its place (`render/Iframe.vue`, the `hidden!` class). The
 * first cut of this pipeline appended the frame *after* the message instead, and
 * on the sample card that meant a reader scrolled through **360 KiB of source**
 * before reaching the interface it describes. Side by side is not a milder
 * version of replacement; it is a different and worse thing.
 *
 * Splitting rather than hiding after the fact, because the renderer never
 * produces a `<pre>` for us to hide — `MarkdownText` emits React elements, and the
 * block only becomes an element if we hand it the text. So the text handed over
 * is the text with the claimed spans removed, and the interfaces go in the gaps
 * they left. That also puts each interface **where its block was**, which
 * matters for a message that has prose on both sides of it.
 *
 * **Spans can also be removed without anything taking their place.** A
 * message's own `<style>` block is neither a frame nor prose: its CSS has gone
 * into the frames the message's other regions became, and the characters
 * themselves must not reach the renderer, which disables raw HTML and would
 * print the stylesheet as text. So it is dropped here, in the same walk that
 * places the interfaces — a second pass that rewrote the text would move every
 * offset the claims are named by.
 *
 * @param source - the message text, after display regex.
 * @param blocks - the claimed blocks, from `claimFrontendBlocks`.
 * @param dropped - spans to remove from the prose and replace with nothing,
 *   from `claimMessageSurfaces`'s `styles`.
 * @returns the pieces, in order, with empty prose dropped.
 */
export function splitAroundInterfaces(
  source: string,
  blocks: readonly FrontendBlock[],
  dropped: readonly { start: number, end: number }[] = [],
): MessageSegment[] {
  /*
   * The instance number is fixed **before** the two lists are merged, and that
   * ordering is the whole reason this is written as a map and not as a counter:
   * `instance` is the block's index within `blocks`, which is what the budget
   * plans over and what the controller builds frames for. A number assigned
   * while walking a list that also contains style spans would drift from theirs
   * on any message that has one — every interface after the first style landing
   * in its neighbour's slot, with nothing reporting anything.
   */
  const claims: { start: number, end: number, block?: FrontendBlock, instance: number }[] = [
    ...blocks.map((block, instance) => ({ start: block.start, end: block.end, block, instance })),
    ...dropped.map(span => ({ start: span.start, end: span.end, instance: -1 })),
  ].sort((left, right) => left.start - right.start)

  const segments: MessageSegment[] = []
  let at = 0

  for (const claim of claims) {
    const before = source.slice(at, Math.max(at, claim.start))
    // Trimmed only for the emptiness test: a gap of whitespace between two
    // interfaces is not prose, and rendering it would add a blank paragraph.
    if (before.trim() !== '') segments.push({ kind: 'text', text: before })
    if (claim.block !== undefined) {
      segments.push({ kind: 'interface', block: claim.block, instance: claim.instance })
    }
    at = Math.max(at, claim.end)
  }

  const rest = source.slice(at)
  if (rest.trim() !== '') segments.push({ kind: 'text', text: rest })
  return segments
}

