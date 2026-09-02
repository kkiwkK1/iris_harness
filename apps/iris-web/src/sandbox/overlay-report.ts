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
  /** The frame's own viewport width. */
  viewportWidth: number
  /** The frame's own viewport height. */
  viewportHeight: number
}

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
