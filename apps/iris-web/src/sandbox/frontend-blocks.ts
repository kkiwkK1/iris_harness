/**
 * Which code blocks in a message are card interfaces.
 *
 * Step one of the message-frame pipeline, and deliberately the whole of it: this
 * decides what would be *claimed* and builds no frames. `RENDER.md` puts the
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
 * wrong: there is **no entity decoding**. See `RENDER.md`'s retraction — showdown
 * escapes a block's body before the DOM exists, so upstream's `.text()` hands
 * back the author's own characters, and decoding here would claim blocks upstream
 * leaves alone.
 *
 * @module iris-web/sandbox/frontend-blocks
 */

import { splitHtmlRegions } from '../app/html-regions.ts'

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
}

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
 * @param source - the message text, after display regex.
 * @returns the claimed surfaces, in source order, with any split notes.
 */
export function claimMessageSurfaces(source: string): ClaimedSurfaces {
  const scanned = scanCodeBlocks(source)
  const claimed = claimFrontendBlocks(source)

  const regions: FrontendBlock[] = []
  const notes: string[] = []

  // Fences — claimed or not — bound the prose the split may read. `cursor`
  // walks the source and collects one split per gap between them.
  let cursor = 0
  for (const span of scanned) {
    if (span.kind !== 'fenced') continue
    if (span.start > cursor) collectRegions(source, cursor, span.start, regions, notes)
    if (span.end > cursor) cursor = span.end
  }
  if (cursor < source.length) collectRegions(source, cursor, source.length, regions, notes)

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

  return { blocks, refused: notes }
}

/**
 * Run the HTML-region split over one gap between fences, in place.
 *
 * @param source - the whole message, so regions come back in source offsets.
 * @param from - gap start, inclusive.
 * @param to - gap end, exclusive.
 * @param out - where claimed regions accumulate.
 * @param notes - where the split's unclosed-region notes accumulate.
 */
function collectRegions(
  source: string,
  from: number,
  to: number,
  out: FrontendBlock[],
  notes: string[],
): void {
  const split = splitHtmlRegions(source.slice(from, to))
  for (const note of split.refused) notes.push(note)
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
interface Fence {
  char: string
  width: number
  info: string
}

/**
 * Read an opening code fence, if this line is one.
 *
 * Up to three leading spaces are allowed before a fence (CommonMark); four would
 * make it indented code instead.
 * @param line - the line to inspect.
 * @returns the fence, or undefined.
 */
function openingFence(line: string): Fence | undefined {
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
 * Whether a line closes the given fence.
 * @param line - the line to inspect.
 * @param fence - the fence that is open.
 * @returns true when this line ends the block.
 */
function closesFence(line: string, fence: Fence): boolean {
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
 * @param source - the message text, after display regex.
 * @param blocks - the claimed blocks, from `claimFrontendBlocks`.
 * @returns the pieces, in order, with empty prose dropped.
 */
export function splitAroundInterfaces(
  source: string,
  blocks: readonly FrontendBlock[],
): MessageSegment[] {
  const segments: MessageSegment[] = []
  let at = 0

  blocks.forEach((block, instance) => {
    const before = source.slice(at, block.start)
    // Trimmed only for the emptiness test: a gap of whitespace between two
    // interfaces is not prose, and rendering it would add a blank paragraph.
    if (before.trim() !== '') segments.push({ kind: 'text', text: before })
    segments.push({ kind: 'interface', block, instance })
    at = block.end
  })

  const rest = source.slice(at)
  if (rest.trim() !== '') segments.push({ kind: 'text', text: rest })
  return segments
}

