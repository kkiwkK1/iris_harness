/**
 * Where a message stops being markdown and starts being HTML.
 *
 * Our markdown renderer disables raw HTML by design (`MarkdownText`: *"raw
 * HTML, relative links, and unsafe protocols are disabled"*), and it exposes no
 * interception point — so inline HTML cannot be produced by sanitizing the
 * renderer's output. The message is split instead, and each region goes to the
 * renderer that suits it.
 *
 * **The specification is 44's, and it arrived twice.** The first version was
 * written to *count* affected floors; four of its clauses were loose in ways
 * that only matter once a machine follows them. His own note on that is the
 * provenance line for this file:
 *
 * > A criterion has to say which question it was written for before anything
 * > downstream treats it as a specification — the places it is loose are
 * > precisely the places it is wrong for a different question.
 *
 * The clause that cost the most: **66% of the 936 fragment floors (622) contain
 * more than one HTML region**, so "split once" would have merged them and
 * swallowed the markdown in between.
 *
 * Measured costs of this rule, so the next reader does not have to re-derive
 * them: ending a region at the next **blank line** would damage 911 of 936
 * floors (97.3%, including all 887 in 命定之诗 — blank lines inside a region are
 * normal); running to the **end of the segment** over-captures at most 23
 * floors, all in 命定之诗.
 *
 * @module iris-web/app/html-regions
 */

/**
 * Tags whose appearance at the start of a line opens an HTML region.
 *
 * CommonMark's own HTML-block (type 6) list, used rather than invented because
 * our renderer follows CommonMark: a tag this list omits that CommonMark
 * includes would be a place where our split and the renderer's parse disagree
 * about the same text, which is the two-implementations drift the split was
 * chosen to avoid.
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
  // Not in CommonMark's list, but each is a container a card actually opens a
  // region with, and each is meaningless as markdown text.
  'style', 'script', 'canvas', 'svg', 'video', 'audio', 'template', 'pre',
])

/**
 * Tags that close themselves, so a region opened by one is a single line.
 *
 * Without this a `<hr>` at the start of a line would open a region whose
 * closing tag never arrives, and the unclosed fallback would swallow the rest
 * of the message — a wrong answer produced by a correct rule applied to a tag
 * that cannot participate in it.
 */
const VOID_TAGS: ReadonlySet<string> = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** One run of a message, and which renderer it belongs to. */
export interface Region {
  kind: 'markdown' | 'html'
  text: string
  /**
   * Offset of the region's first character in the input.
   *
   * Computed in the same walk that produces the text, so the two cannot drift:
   * a caller that splices the source by these offsets — the message-frame
   * pipeline carves claimed regions out of the message the way it carves out
   * fenced blocks — gets exactly the characters `text` holds.
   */
  start: number
  /** Offset just past the region's last character. */
  end: number
}

/** The split, plus anything a card author should be told about it. */
export interface SplitMessage {
  regions: readonly Region[]
  /** Deduplicated notes — an unclosed region, and nothing else so far. */
  refused: readonly string[]
}

/** The tag a line opens, if it opens one. */
function opensRegion(line: string): string | undefined {
  // Up to three leading spaces, then `<`, then a name — never `</`, because a
  // closing tag cannot open a region and **every one of the 936 floors has a
  // line-initial closing tag**, so admitting them would claim every floor.
  const match = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)[\s/>]/.exec(`${line} `)
  const tag = match?.[1]?.toLowerCase()
  return tag !== undefined && BLOCK_TAGS.has(tag) ? tag : undefined
}

/** How far the nesting of `tag` moves across one line. */
function depthDelta(line: string, tag: string): number {
  const opens = line.match(new RegExp(`<${tag}(?=[\\s/>])`, 'gi'))?.length ?? 0
  const closes = line.match(new RegExp(`</${tag}(?=[\\s>])`, 'gi'))?.length ?? 0
  const selfClosing = line.match(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'))?.length ?? 0
  return opens - closes - selfClosing
}

/**
 * Split a message into markdown and HTML regions.
 *
 * A region opens at a line-initial block tag and closes when that tag's nesting
 * depth returns to zero. Regions are independent; whatever sits between two of
 * them is markdown again.
 *
 * **One deliberate reading of the specification.** It says the region closes at
 * the *line-initial* closing tag whose depth returns to zero. This closes
 * wherever depth returns to zero, line-initial or not, because the stricter
 * reading fails a shape that is not rare — `<details>…</details>` written on one
 * line never presents a line-initial closer, so it would be reported unclosed
 * and swallow the rest of the message. Depth pairing is the mechanism the clause
 * describes; "line-initial" describes what the common case looks like.
 *
 * @param text - the message text, after display regex.
 * @returns the regions in order, and any notes.
 */
export function splitHtmlRegions(text: string): SplitMessage {
  if (text === '') return { regions: [], refused: [] }

  const lines = text.split('\n')

  /** Offset of each line's first character; the walk reports regions in these. */
  const starts: number[] = []
  let cursor = 0
  for (const line of lines) {
    starts.push(cursor)
    cursor += line.length + 1
  }

  const regions: Region[] = []
  const refused = new Set<string>()

  let pending: string[] = []
  let pendingFrom = 0
  let pendingTo = 0
  const flushMarkdown = (): void => {
    if (pending.length === 0) return
    const joined = pending.join('\n')
    // Whitespace-only runs between two regions are not prose; emitting them
    // would put an empty paragraph between two panels.
    if (joined.trim() !== '') {
      regions.push({
        kind: 'markdown',
        text: joined,
        start: starts[pendingFrom] ?? 0,
        end: (starts[pendingTo] ?? 0) + (lines[pendingTo] ?? '').length,
      })
    }
    pending = []
  }

  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ''
    const tag = opensRegion(line)

    if (tag === undefined) {
      if (pending.length === 0) pendingFrom = at
      pending.push(line)
      pendingTo = at
      at += 1
      continue
    }

    flushMarkdown()

    if (VOID_TAGS.has(tag)) {
      regions.push({ kind: 'html', text: line, start: starts[at] ?? 0, end: (starts[at] ?? 0) + line.length })
      at += 1
      continue
    }

    let depth = 0
    let end = at
    let closed = false
    while (end < lines.length) {
      depth += depthDelta(lines[end] ?? '', tag)
      if (depth <= 0) {
        closed = true
        break
      }
      end += 1
    }

    if (!closed) {
      /*
       * The documented fallback: take the rest and say so. Reported rather than
       * silently rendered, because a card author whose panel swallowed the
       * narrative below it needs to know the cause is a missing closing tag —
       * and because the alternative reading (treat it as markdown) would put the
       * card's raw tags on screen, which is the fault we started from.
       */
      refused.add(`an HTML block opened with <${tag}> is never closed — the rest of the message is treated as HTML`)
      regions.push({ kind: 'html', text: lines.slice(at).join('\n'), start: starts[at] ?? 0, end: text.length })
      return { regions, refused: [...refused] }
    }

    regions.push({
      kind: 'html',
      text: lines.slice(at, end + 1).join('\n'),
      start: starts[at] ?? 0,
      end: (starts[end] ?? 0) + (lines[end] ?? '').length,
    })
    at = end + 1
  }

  flushMarkdown()
  return { regions, refused: [...refused] }
}
