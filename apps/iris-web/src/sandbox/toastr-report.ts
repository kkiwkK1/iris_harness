/**
 * `toastr`, answered by the panel instead of by a toast.
 *
 * Upstream's cards get the real library from SillyTavern's page, and they use it
 * heavily: the MagVarUpdate bundle alone calls it 73 times across four levels,
 * and **36 of those are `toastr.error`**. That distribution is the whole design
 * input. `toastr` is not decoration in these cards, it is the channel a card
 * author uses to tell a user that something went wrong.
 *
 * Two wrong answers were available, and both were considered:
 *
 * - **Leave it absent.** Honest, and it is what the missing-libraries banner did.
 *   But a great many of those calls sit in `catch (error) { toastr.error(...) }`,
 *   so an absent `toastr` converts a *handled* error into an unhandled one — the
 *   card's error handler becomes the thing that kills it, and the original error
 *   is replaced by a `ReferenceError` about the reporting library. The diagnostic
 *   destroys the diagnosis.
 * - **A silent no-op.** Nothing crashes, and the card's error reporting is
 *   quietly cut. A user is shown a working card that has stopped telling them
 *   anything, which is worse than either honest answer.
 *
 * So neither absence nor pretence: the call is **answered and forwarded**.
 * Upstream's equivalent of `toastr.error(text)` is a toast the user reads; ours
 * is a line in the card's report list the user reads. The medium changed, the
 * message did not, and that is fidelity rather than a fake — the one thing this
 * must never do is accept the call and drop the text.
 *
 * The first call also says plainly that this frame has no real `toastr`, so
 * "named absence" is preserved rather than traded away for the convenience of a
 * global that answers.
 *
 * @module iris-web/sandbox/toastr-report
 */

/** The levels toastr exposes, and the four a card actually reaches for. */
export type ToastLevel = 'error' | 'warning' | 'info' | 'success'

/**
 * How much of a card's text is carried into one report line.
 *
 * A toast is a few words by nature; a card handing over a stack trace or a
 * serialised object would push every other report off the panel. Truncated
 * rather than dropped, because the first line of an error message is almost
 * always the part that names the fault.
 */
const TEXT_LIMIT = 300

/**
 * Render one toastr call as the sentence the panel shows.
 *
 * Exported for its own test: this is the only place the card's own words survive
 * the crossing, so "the text arrived intact" is the property worth pinning.
 *
 * @param level - which toastr method the card called.
 * @param message - the card's message argument, whatever type it passed.
 * @param title - the card's title argument, if it passed one.
 * @returns the report line.
 */
export function describeToast(level: ToastLevel, message: unknown, title: unknown): string {
  const body = trim(text(message))
  const heading = trim(text(title))

  /*
   * The level is named rather than styled away. A card calling `toastr.info` and
   * a card calling `toastr.error` mean different things, and a report list that
   * flattened them would make a routine notice look like a fault.
   */
  const label = `card called toastr.${level}`
  if (heading.length === 0 && body.length === 0) {
    // A toast with no words is a real thing a card can emit, and reporting it as
    // an empty line would read as a rendering bug in the panel.
    return `${label} with no text`
  }
  if (heading.length === 0) return `${label}: ${body}`
  if (body.length === 0) return `${label}: ${heading}`
  return `${label}: ${heading} — ${body}`
}

/**
 * A card's argument as text, without inventing content.
 *
 * `String(value)` on a plain object yields `[object Object]`, which occupies a
 * report line while saying nothing; naming the type at least tells a reader the
 * card passed a value of the wrong shape.
 * @param value - whatever the card passed.
 * @returns text safe to show.
 */
function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return value.message
  try {
    const rendered = JSON.stringify(value)
    return rendered === undefined ? `[${typeof value}]` : rendered
  } catch {
    // Circular, or a getter that throws. The card still called toastr, and that
    // fact is worth a line even when its argument cannot be read.
    return `[unreadable ${typeof value}]`
  }
}

/**
 * Collapse whitespace and cap the length.
 * @param value - the text to shorten.
 * @returns one line, at most `TEXT_LIMIT` characters.
 */
function trim(value: string): string {
  const flat = value.split(/\s+/u).filter(part => part.length > 0).join(' ')
  return flat.length <= TEXT_LIMIT ? flat : `${flat.slice(0, TEXT_LIMIT)}…`
}

/** The surface a card sees. Wider than the four levels, on purpose. */
export interface ReportingToastr {
  error: (message?: unknown, title?: unknown, options?: unknown) => void
  warning: (message?: unknown, title?: unknown, options?: unknown) => void
  info: (message?: unknown, title?: unknown, options?: unknown) => void
  success: (message?: unknown, title?: unknown, options?: unknown) => void
  clear: (target?: unknown) => void
  remove: (target?: unknown) => void
  options: Record<string, unknown>
}

/** What the first call says, before any card text. */
export const TOASTR_SUBSTITUTION_NOTICE =
  'this frame has no toastr, so a card\u2019s toasts are shown here as report lines instead' +
  ' \u2014 the text is the card\u2019s own, not Iris\u2019s'

/**
 * Which channel one toastr level belongs on.
 *
 * `describeToast` above says the level "is named rather than styled away"
 * because "a report list that flattened them would make a routine notice look
 * like a fault" — and until this function existed the module named the level in
 * the *text* and flattened it in the *channel*, which is the same mistake one
 * layer down, committed by the code whose own comment forbids it.
 *
 * Only `error` is the card claiming something failed. `warning` is a card
 * saying it coped, and `info`/`success` are a card talking to its reader; none
 * of the three belongs in a column headed by scripts that did not start. The
 * distribution makes this worth getting right rather than tidy: 36 of the MVU
 * bundle's 73 toastr calls are `error`, so a flattening in either direction
 * loses a real signal.
 * @param level - the toastr method the card called.
 * @returns the channel to post its line on.
 */
function channelFor(level: ToastLevel): 'note' | 'error' {
  return level === 'error' ? 'error' : 'note'
}

/**
 * Build the `toastr` a card frame provides.
 *
 * @param report - the frame's report channel, taking the channel to post on; it
 *   already discards a repeat of an identical message, which is also the
 *   de-duplication a toast loop needs.
 * @returns the object to seed as `window.toastr`.
 */
export function createReportingToastr(
  report: (message: string, channel: 'note' | 'error') => void,
): ReportingToastr {
  let announced = false

  const at = (level: ToastLevel) => (message?: unknown, title?: unknown): void => {
    if (!announced) {
      announced = true
      // The notice is about this frame, not about the card's message, and it is
      // posted before the card's first word — on the error channel it would put
      // "this frame has no toastr" at the top of the failure list of every card
      // that merely called `toastr.success`.
      report(TOASTR_SUBSTITUTION_NOTICE, 'note')
    }
    report(describeToast(level, message, title), channelFor(level))
  }

  return {
    error: at('error'),
    warning: at('warning'),
    info: at('info'),
    success: at('success'),
    /*
     * `clear` and `remove` dismiss toasts that were never shown, so they have
     * nothing to do — but they must exist. They are the members a card calls
     * *without* checking, and the failure this module exists to prevent is a
     * missing member turning a card's own error handling into its cause of
     * death. Providing four levels and omitting these would rebuild that trap
     * one method along.
     */
    clear: () => {},
    remove: () => {},
    /** Assignable, because configuring toastr is the first thing many cards do. */
    options: {},
  }
}
