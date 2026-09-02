/**
 * Who to blame for an error nothing else could attribute.
 *
 * An unhandled rejection or a window error arrives with a callback's stack, so
 * no script owns it — which is exactly why the frame has to say something about
 * *when* it happened instead. The risk is the one this module exists to hold
 * down: **a report that names a suspect gets the innocent party skipped.**
 *
 * This has been wrong twice, in the same shape both times.
 *
 * 1. It said "after the card body finished" unconditionally — a claim about
 *    *when* — and added "this is card code failing in a callback, not the frame
 *    refusing anything" — a claim about *whose fault*, from no evidence. A
 *    frame whose own preset threw during load reported it as the card failing,
 *    and sent a reader to read the card.
 * 2. The fix made the wording conditional on whether a body had run, and left
 *    the other branch asserting "no card code had started, so this belongs to
 *    the frame's own setup". That is false for an **interface** frame: its
 *    card markup is inlined into the document and runs *while the document
 *    parses*, long before any `run` message sets the flag. A real card's
 *    `ReferenceError: errorCatched is not defined` was reported as the frame's
 *    own setup — and `errorCatched` appears nowhere in the frame's code. It is
 *    an upstream global the card expected. The report sent a reader hunting a
 *    bug in the bootstrap that was never there.
 *
 * The lesson kept for the next reader: **a flag that says "no card body has
 * started" is not the same fact as "no card code has run"**, and only one of
 * them licenses blaming the frame.
 *
 * @module iris-web/sandbox/failure-attribution
 */

/** What the frame knows at the moment an unattributable error arrives. */
export interface FailureContext {
  /** Whether a card body has been handed over and begun. */
  bodyRan: boolean
  /**
   * Whether this frame carries a card's markup.
   *
   * An interface frame's markup — including its `<script>` elements — executes
   * during parsing, so card code can fail before `bodyRan` is ever true.
   */
  interfaceFrame: boolean
}

/**
 * Describe an unattributable failure without naming a suspect it cannot see.
 *
 * @param kind - how it arrived, e.g. `an unhandled rejection`.
 * @param text - the error's own message.
 * @param context - what the frame knows about its own state.
 * @returns the sentence to report.
 */
export function describeFailure(kind: string, text: string, context: FailureContext): string {
  if (context.bodyRan) {
    return `${kind} after a card body ran: ${text}`
      + ' — the frame refused nothing, so this is code the card scheduled'
  }

  if (context.interfaceFrame) {
    /*
     * Two candidates, and the frame genuinely cannot tell them apart: inlined
     * markup runs during parsing, and so does the frame's own setup. Naming
     * both is the honest report — and the markup goes first because it is the
     * larger and less-tested body of code of the two.
     */
    return `${kind} before the card body message arrived: ${text}`
      + " — this frame carries the card's markup, which runs while the document parses,"
      + " so this is most likely that markup rather than the frame's own setup"
  }

  return `${kind} before any card body ran: ${text}`
    + " — no card code had started, so this belongs to the frame's own setup"
}
