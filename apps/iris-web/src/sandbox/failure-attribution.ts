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

/**
 * Where a throw came from, as one frame of its stack.
 *
 * The `threw` path reported `error.message` and dropped `error.stack`, which is
 * survivable for a message that names its own cause and useless for one that
 * does not. `Failed to read the 'localStorage' property from 'Window'` is the
 * second kind: it identifies the API and says nothing about which of a card's
 * call sites reached for it, and a minified bundle has many. A census predicting
 * which cards survive an unavailable `localStorage` cannot be checked against a
 * report that will not say where the access was.
 *
 * The **top** frame, not a search for the card's own code. Distinguishing card
 * frames from the frame's own would mean pattern-matching our bundle's names,
 * which is a guess that goes stale silently — and the top frame is where the
 * throw happened, which is the fact rather than an interpretation of it. When
 * the interesting frame is deeper, the top one at least says which layer to
 * start from.
 *
 * @param error - whatever was thrown.
 * @returns the location as ` at <frame>`, or the empty string when there is no
 *   stack to read. Empty rather than a placeholder: a report ending in "at
 *   unknown" reads as a failure to look it up, when in most of these cases the
 *   browser genuinely provided nothing.
 */
export function topFrame(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return ''

  /*
   * The first line that looks like a frame, rather than line 2.
   *
   * V8 puts `Error: message` first and the frames after it, but a multi-line
   * message — which `UnsupportedApiError` produces, and a `ZodError` produces
   * several of — pushes the frames down by however many lines the message has.
   * Taking `lines[1]` returned the second line of the *message* for exactly the
   * errors whose location is hardest to guess from the text.
   */
  for (const line of error.stack.split('\n')) {
    const frame = line.trim()
    if (!frame.startsWith('at ')) continue
    // Bounded: a stack frame from a `blob:` or `data:` URL can carry the whole
    // inlined source in its name, and this ends up on one panel line.
    return ` ${frame.length > 200 ? `${frame.slice(0, 200)}\u2026` : frame}`
  }
  return ''
}

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
