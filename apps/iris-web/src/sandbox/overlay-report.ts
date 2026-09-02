/**
 * What to say when a card builds a user interface where nobody can see it.
 *
 * [OVERLAY-CARDS.md (3c)] A third class of interface card exists: it never
 * touches `parent.*` at all. Upstream's `parent_jquery.js` makes the `$` inside
 * a script frame the **page's** jQuery, so the card's `.appendTo('body')` lands
 * on the host page. In Iris's cohabiting realm `$` is the frame's own, so the
 * same call lands on the hidden script frame's body — and the card's whole
 * interface is built somewhere with no viewport.
 *
 * **Structural, not visual.** The script frame is 0×0 (deliberately: `hidden`
 * would be `display:none`, which a card can detect, so it is off-screen at zero
 * size instead). So every box the card measures is zero and
 * `getBoundingClientRect()` cannot tell "drew nothing" from "drew into
 * nothing". Counting the elements it appended can.
 *
 * **The zero viewport is reported even though it is our own doing**, because it
 * is the common cause of everything the card does next: layout that collapses,
 * animations that never start because an observer sees no intersection,
 * scrolling with nothing to scroll. A reader who has the element count but not
 * the viewport will chase each of those separately.
 *
 * @module iris-web/sandbox/overlay-report
 */

/** What the frame observed about a card's attempt to draw. */
export interface OverlayAttempt {
  /** Element children that are not `<script>` or `<style>`. */
  built: number
  /** The tag names, for the first few, so the report names something concrete. */
  tags: readonly string[]
  /**
   * How much text the built subtree contains, trimmed.
   *
   * The difference between an interface and a mount point. MVU appends a single
   * empty `div` to the script frame and hangs its own panel off it later — in
   * upstream that div also lives in a hidden frame, and nobody was ever meant to
   * see it. Reporting it would put a permanent line under **every one of the 13
   * cards that bundle MVU**, saying something true about a thing that is not
   * wrong.
   */
  textLength: number
  /** The frame's own viewport width. */
  viewportWidth: number
  /** The frame's own viewport height. */
  viewportHeight: number
}

/**
 * Tags that only exist to be looked at.
 *
 * A card can build a visible interface with no text at all — a canvas game, an
 * SVG dial — so text alone would miss those. These say "intended to be seen"
 * on their own.
 */
const VISUAL_TAGS: ReadonlySet<string> = new Set([
  'canvas', 'svg', 'img', 'video', 'iframe', 'picture', 'object',
])

/**
 * Describe a card drawing inside a script frame, or say nothing.
 *
 * Silence is the correct output for almost every script frame: a script frame's
 * body is script tags and nothing else, and a line saying that the frame which
 * was never going to draw has not drawn would appear under every card forever.
 * This speaks only when the card actually appended something.
 *
 * @param attempt - what the frame saw.
 * @returns the line to report, or undefined when there is nothing to say.
 */
export function describeOverlayAttempt(attempt: OverlayAttempt): string | undefined {
  if (!Number.isFinite(attempt.built) || attempt.built <= 0) return undefined

  /*
   * **A single empty element is a mount point, not an interface.**
   *
   * The first version of this reported any appended element, and on its first
   * live reading it fired on 爱衣 — because MVU appends one empty `div` to hang
   * its panel off, exactly as it does upstream, where that div also sits in a
   * hidden frame nobody sees. So the line was *true* and would have appeared
   * under **every card that bundles MVU** (13 of them), saying the same thing
   * about a thing that is not wrong. "Built one div" and "built a whole
   * application" were the same sentence.
   *
   * `RENDER.md`'s own rule: the value of a report depends on what it does not
   * report. So the gate is a shape rather than a count — text, or something
   * whose only purpose is to be looked at, or more than one element.
   *
   * **Named risk**: a card that builds an interface out of several empty styled
   * divs and fills them later would be silent here. That shape is not in any
   * measured card, and it is the cost of not being noise in 13 of them.
   */
  const visual = attempt.tags.some(tag => VISUAL_TAGS.has(tag.toLowerCase()))
  const speaks = attempt.built > 1 || attempt.textLength > 0 || visual
  if (!speaks) return undefined

  const named = attempt.tags.slice(0, 4).join(', ')
  const size = `${String(Math.round(attempt.viewportWidth))}x${String(Math.round(attempt.viewportHeight))}`
  const zero = attempt.viewportWidth <= 0 || attempt.viewportHeight <= 0

  return (
    `this card built ${String(attempt.built)} element(s) in a **script** frame`
    + `${named === '' ? '' : ` (${named})`}`
    + ' — Iris has no overlay surface yet, so they are in a frame nobody can see.'
    + ` The frame's viewport is ${size}`
    + (zero
      /*
       * Said explicitly, because it is upstream of everything else the card is
       * about to get wrong. A reader holding only the element count will debug
       * the collapsed layout, then the animation that never runs, then the
       * scroll that has nothing to scroll — three symptoms of this one line.
       */
        ? ', so every size this card measures is zero and every layout it computes'
          + ' collapses — that is one cause, not three separate faults'
        : '.')
  )
}
