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

/** What upstream looks for, verbatim (`src/util/is_frontend.ts:1-3`). */
const MARKERS: readonly string[] = ['html>', '<head>', '<body']

/** A newline, built rather than escaped — see `script-source.ts` for why. */
const NEWLINE = String.fromCharCode(10)

/** How a block was written. Recorded for diagnostics, never for the decision. */
export type BlockKind = 'fenced' | 'indented'

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
 * Find every code block in a message and claim the ones that look like interfaces.
 *
 * Scanned line by line with string operations rather than matched with a pattern,
 * for the reason recorded across this package: escapes here have been eaten in
 * transit repeatedly, and a collapsed one still parses while matching nothing.
 *
 * @param source - the message text, as stored.
 * @returns the claimed blocks, in source order.
 */
export function claimFrontendBlocks(source: string): FrontendBlock[] {
  const claimed: FrontendBlock[] = []
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
      if (marker !== undefined) {
        claimed.push({
          start: offsets[at] ?? 0,
          end: to < lines.length ? (offsets[to] ?? source.length) + (lines[to] ?? '').length : source.length,
          body,
          kind: 'fenced',
          ...(fence.info === '' ? {} : { info: fence.info }),
          matched: marker,
        })
      }
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
      if (marker !== undefined) {
        claimed.push({
          start: offsets[at] ?? 0,
          end: (offsets[lastContent] ?? 0) + (lines[lastContent] ?? '').length,
          body,
          kind: 'indented',
          matched: marker,
        })
      }
      at = to
      continue
    }

    at += 1
  }

  return claimed
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
