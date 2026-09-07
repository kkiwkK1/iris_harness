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
  //
  // `style` is here for a different reason since message sheets existed: a run
  // it opens is not a region at all (see `MessageStyle`), and this list is what
  // makes the walk *recognise* the run instead of handing a stylesheet's text
  // to the markdown renderer.
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

/**
 * A `<style>` block a message wrote outside any fence.
 *
 * **Not a region, because it has nothing to render.** Upstream is one DOM per
 * floor: `decodeStyleTags` prefixes every selector with `.mes_text ` and the
 * sheet then applies to the whole message, panel and prose alike. Iris is one
 * frame per region, and a region carrying only CSS became a frame with nothing
 * in it — measured at 812px of empty black on 爱衣's variable panel, whose own
 * `[open]>div` rule was in that frame while the `<details>` it unhides was in
 * the next one.
 *
 * So a style block leaves the region sequence here, carrying its span so the
 * caller can take it out of the prose as well, and the pipeline copies its CSS
 * into every frame the message's *other* regions become
 * (`frontend-blocks.ts`, `message-frames.ts`).
 */
export interface MessageStyle {
  /** Offset of the block's first character in the input. */
  start: number
  /** Offset just past the block's last character. */
  end: number
  /**
   * The CSS between the tags, exactly as written.
   *
   * Unscoped and unfiltered on purpose: this file decides *what is a style
   * block*, and `card-css.ts` decides what a card's CSS may do. Two files
   * deciding the second question is how they come to disagree about
   * `@font-face`.
   */
  css: string
}

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
  /**
   * The message's own `<style>` blocks, in source order.
   *
   * Never also a region: a block that lands here has left the sequence, so a
   * caller that renders `regions` and splices out `styles` shows neither a
   * frame for it nor its source text.
   */
  styles: readonly MessageStyle[]
}

/** A `<style>` element's opening tag. */
const STYLE_OPEN = /<style\b[^>]*>/i

/**
 * A `<style>` element's closing tag.
 *
 * The solidus is written as a character class so no escape has to survive being
 * written — the convention `script-source.ts` records, and this file's own
 * patterns are the ones a collapsed escape would silently widen.
 */
const STYLE_CLOSE = /<[/]style\s*>/i

/** An HTML comment: neither content a renderer needs nor CSS. */
const COMMENT = /<!--[\s\S]*?-->/g

/**
 * The CSS of a run that is `<style>` elements and nothing else.
 *
 * Answering "is this whole run just CSS" rather than "does it contain a style
 * tag", because a card's panel routinely carries a `<style>` **inside** it —
 * that one belongs to the panel's own frame and must stay exactly where the
 * author put it. Only a run with nothing outside its style elements (blank
 * space and comments aside) is a message-level sheet.
 *
 * An unclosed `<style>` takes the rest of the run as CSS. That is the author's
 * intent read the only way it can be: what follows an opening style tag is
 * declarations, and handing them to a renderer would put a stylesheet's text on
 * screen.
 * @param text - one region's text.
 * @returns the CSS, or undefined when the run is not a style block.
 */
function cssOnly(text: string): string | undefined {
  let css = ''
  let outside = ''
  let found = false
  let rest = text

  for (;;) {
    const open = STYLE_OPEN.exec(rest)
    if (open === null) {
      outside += rest
      break
    }
    found = true
    outside += rest.slice(0, open.index)
    const after = rest.slice(open.index + open[0].length)
    const close = STYLE_CLOSE.exec(after)
    if (close === null) {
      css += after
      break
    }
    css += after.slice(0, close.index)
    rest = after.slice(close.index + close[0].length)
  }

  if (!found) return undefined
  return outside.replace(COMMENT, '').trim() === '' ? css : undefined
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
 * **One kind of region is not one.** A run that is nothing but `<style>`
 * elements is a *message-level sheet* (`MessageStyle`), not a panel: it comes
 * back in `styles` with its span and never as a region, because a frame built
 * for it renders nothing and takes its rules out of reach of the panel they
 * were written for.
 *
 * @param text - the message text, after display regex.
 * @returns the regions in order, the message's own style blocks, and any notes.
 */
export function splitHtmlRegions(text: string): SplitMessage {
  if (text === '') return { regions: [], refused: [], styles: [] }

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
  const styles: MessageStyle[] = []

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
      const tail = lines.slice(at).join('\n')
      /*
       * An unclosed `<style>` is CSS, not a frame full of CSS text. Reported,
       * because what follows it is gone from the reading surface either way and
       * the author is the only one who can put the closing tag back.
       */
      const unclosedCss = cssOnly(tail)
      if (unclosedCss !== undefined) {
        refused.add(
          'a <style> block is never closed — its CSS is applied to this message,'
          + ' and nothing after it reaches the reader',
        )
        styles.push({ start: starts[at] ?? 0, end: text.length, css: unclosedCss })
        return { regions, refused: [...refused], styles }
      }
      /*
       * The documented fallback: take the rest and say so. Reported rather than
       * silently rendered, because a card author whose panel swallowed the
       * narrative below it needs to know the cause is a missing closing tag —
       * and because the alternative reading (treat it as markdown) would put the
       * card's raw tags on screen, which is the fault we started from.
       */
      refused.add(`an HTML block opened with <${tag}> is never closed — the rest of the message is treated as HTML`)
      regions.push({ kind: 'html', text: tail, start: starts[at] ?? 0, end: text.length })
      return { regions, refused: [...refused], styles }
    }

    const claimed = lines.slice(at, end + 1).join('\n')
    const from = starts[at] ?? 0
    const to = (starts[end] ?? 0) + (lines[end] ?? '').length

    /*
     * A style block leaves the sequence here — no region, and therefore no
     * frame and no prose. `MessageStyle` carries the reasoning; the span is
     * what lets the caller take the same characters out of the text it hands
     * the renderer.
     */
    const css = cssOnly(claimed)
    if (css !== undefined) {
      styles.push({ start: from, end: to, css })
      at = end + 1
      continue
    }

    regions.push({ kind: 'html', text: claimed, start: from, end: to })
    at = end + 1
  }

  flushMarkdown()
  return { regions, refused: [...refused], styles }
}
