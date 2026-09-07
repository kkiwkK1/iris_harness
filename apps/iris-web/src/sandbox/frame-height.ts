/**
 * When a card's frame has to scroll itself.
 *
 * Split out of `frame-entry.ts` because that file's own contract says so: it
 * exists to adapt the real frame realm and hand it to `installSandbox`, and
 * *"every decision about what a card may touch lives there, where it is injected
 * and therefore testable; keeping this file free of policy is what stops the
 * untestable part from growing."* Deciding when a frame becomes scrollable is
 * policy, and it went into the entry first — this is that walked back.
 *
 * @module iris-web/sandbox/frame-height
 */

/**
 * How far content may exceed the viewport before the frame scrolls itself.
 *
 * Not zero, because the height travels to the shell as a message and is applied
 * a frame later: in that gap the content is legitimately a pixel or two taller
 * than the viewport it is about to be given, and a zero threshold would flash a
 * scrollbar on every ordinary growth — including the ones that resolve
 * themselves immediately. Sub-pixel layout rounding lands in the same band.
 *
 * Small enough that nothing a reader could see hides underneath it: two pixels
 * cannot conceal a line of text, let alone the cut-off screen that prompted
 * this.
 */
export const OVERFLOW_SLACK_PX = 2

/**
 * Whether the frame must scroll its own content.
 *
 * The frame asks this of itself on every measurement and needs to know nothing
 * about *why* its viewport is short of its content — a lagging height message, a
 * card that pins its own height, a cap the shell might grow one day. Each of
 * those would otherwise need its own fix, and each would arrive as the same
 * user-visible fault: content that is simply not there, with a dead wheel over
 * it.
 *
 * A non-positive viewport is not an overflow. A frame still being laid out
 * reports `clientHeight` of 0, and treating that as "content exceeds viewport"
 * would turn on a scrollbar during every frame's first moments — the same class
 * of mistake as the self-reinforcing zero that `frame-entry.ts` records for
 * height, read the other way round.
 * @param content - the content height, as `body.scrollHeight` measures it.
 * @param viewport - the frame's own viewport, `documentElement.clientHeight`.
 * @returns whether the frame should allow itself to scroll.
 */
/**
 * Whether a measured height carries any information.
 *
 * **A card that clips its own overflow closes the height loop.** Measured on a
 * real card: every available ruler — `body.scrollHeight`, `documentElement`'s,
 * the body's box, a range over its contents, the furthest child edge — returned
 * exactly the frame's own viewport, while the screen visibly overflowed. The
 * overflow was clipped by the card's own descendant, so nothing outside that
 * descendant can see it.
 *
 * Reporting such a measurement is worse than reporting nothing: the frame tells
 * the shell "make me the height I already am", the shell obliges, and the next
 * measurement says the same. Whatever height the frame happened to start with
 * becomes the height it keeps forever — which looks exactly like a height that
 * was measured once at mount, and is why that was the first diagnosis. It is
 * measured continuously and the answer is a fixed point.
 *
 * So a measurement equal to the viewport is refused *as a measurement*. It is
 * still a fact, but a fact about the card's layout rather than about its
 * content, and it belongs in a different message.
 * @param measured - the content height this frame read.
 * @param viewport - the frame's own viewport height.
 * @returns whether the measurement says anything the shell does not know.
 */
export function informsShell(measured: number, viewport: number): boolean {
  if (!Number.isFinite(measured) || measured <= 0) return false
  if (!Number.isFinite(viewport) || viewport <= 0) return true
  return Math.abs(measured - viewport) > OVERFLOW_SLACK_PX
}

/** What a measurement should make the frame say. */
export type HeightSignal =
  /** Report this content height; the shell sizes the frame to it. */
  | { kind: 'height', pixels: number }
  /** Say once that this card cannot be measured, so the shell gives it a screen. */
  | { kind: 'sizing' }
  /** Say nothing: the measurement adds nothing to what the shell already did. */
  | { kind: 'silent' }

/**
 * Turn one measurement into one thing to say.
 *
 * The whole decision in one place because it is a small state machine, and the
 * two halves used to live apart: `informsShell` refused the echo, and a boolean
 * in the frame entry decided whether the refusal had already been announced.
 * Apart, they missed the case that matters most.

 * **A card can stop being measurable and start again.** These cards switch
 * screens; one screen clips its overflow and the next does not. So:
 *
 * - measurable → report the height, and **re-arm**, because the card may become
 *   unmeasurable again and the shell has to be told a second time. Announcing
 *   once and never again is how the frame would freeze at the last real height
 *   the moment a later screen clipped itself — the original fault, narrowed.
 * - unmeasurable and not yet announced → announce it once.
 * - unmeasurable and already announced → silence. Repeating it is a log, and the
 *   shell's answer has not changed.
 *
 * **A measurement equal to the height the shell already applied for us is
 * neither of those — it is our own write coming back, and it says nothing.**
 * `informsShell` refuses it as a height, and the refusal used to fall through to
 * the `sizing` announcement, which the shell answers by *removing* the applied
 * height — whereupon the content overflows again, a real height is reported
 * (re-arming the announcement), the shell applies it, the next measurement
 * equals the viewport again… Measured on four real cards, that closed loop
 * flips the frame between its content height and the CSS fallback on every
 * animation frame, forever: the reading column's scrollbar toggles and the
 * interface's right and bottom edges flicker without end. The state is a fixed
 * point of the loop itself, so it carries no news and earns only silence — and
 * crucially it flips no state: `announced` is left exactly as it was, so a
 * measurement that arrives while the viewport is *not* what we asked for can
 * still announce once.
 *
 * @param measured - the content height this frame read.
 * @param viewport - the frame's own viewport height.
 * @param announced - whether the frame has already said it cannot be measured.
 * @param applied - the height this frame most recently asked the shell to
 *   apply, or `undefined` while nothing of ours is applied (before the first
 *   report, or after a `sizing` announcement removed it). Omitted by callers
 *   that have no shell to echo off — the answer is then exactly the three-
 *   argument form's.
 * @returns what to say.
 */
export function heightSignal(
  measured: number,
  viewport: number,
  announced: boolean,
  applied?: number,
): HeightSignal {
  if (!Number.isFinite(measured) || measured <= 0) return { kind: 'silent' }
  if (informsShell(measured, viewport)) return { kind: 'height', pixels: measured }
  if (
    applied !== undefined
    && Number.isFinite(applied)
    && Math.abs(applied - viewport) <= OVERFLOW_SLACK_PX
  ) {
    return { kind: 'silent' }
  }
  return announced ? { kind: 'silent' } : { kind: 'sizing' }
}

/** Every candidate measure of "how tall is this card", read at one moment. */
export interface HeightSources {
  /** How many times the resize observer has fired. */
  resizes: number
  /** How many times the mutation observer has fired. */
  mutations: number
  /** `document.body.scrollHeight` — what the frame currently reports. */
  bodyScroll: number
  /** `document.documentElement.scrollHeight`. */
  docScroll: number
  /** The frame's own viewport. */
  docClient: number
  /** `body.getBoundingClientRect().height` — the box, not its content. */
  bodyRect: number
  /** A range over the body's contents, which ignores the body's own box. */
  rangeHeight: number
  /** The furthest bottom edge among the body's direct children. */
  childBottom: number
}

/**
 * One line naming every height this frame can see, and which of them moved.
 *
 * Built because a fix failed and two explanations fitted equally well. The
 * height reporter gained a mutation observer, and the frame still did not grow:
 * either the observer never fires, or it fires and the quantity it measures is
 * pinned — `body.scrollHeight` cannot exceed the frame when `html,body` are
 * `height:100%` **and** the card clips its own overflow in a descendant. A
 * third reading is worse than both: the card may genuinely have no measurable
 * content height from outside, because it lays out against the viewport it is
 * given and scrolls internally.
 *
 * Those are three different repairs, and no amount of reading the code from
 * outside separates them — an opaque origin means the parent cannot reach
 * `contentDocument`. So the frame says what it sees, and the counters are as
 * important as the measures: they are what distinguishes "never woke up" from
 * "woke up and read a pinned number".
 * @param sources - the measures, read at one moment.
 * @returns a compact line for the panel.
 */
export function describeHeightSources(sources: HeightSources): string {
  const round = (value: number): string =>
    Number.isFinite(value) ? String(Math.round(value)) : '?'
  return (
    `height sources: viewport ${round(sources.docClient)}`
    + ` | body.scrollHeight ${round(sources.bodyScroll)}`
    + ` | doc.scrollHeight ${round(sources.docScroll)}`
    + ` | body rect ${round(sources.bodyRect)}`
    + ` | range ${round(sources.rangeHeight)}`
    + ` | child bottom ${round(sources.childBottom)}`
    + ` | fired resize ${String(sources.resizes)} mutation ${String(sources.mutations)}`
  )
}

export function overflowsViewport(content: number, viewport: number): boolean {
  // One predicate, said twice: the boolean form for callers that want a yes/no,
  // the string form (`overflowDecision`) for the style value. Keeping two
  // bodies is how the frame ended up with two scroll decisions that disagreed.
  return overflowDecision(content, viewport) === 'auto'
}


/**
 * Every ruler this frame can read for "how far does the content actually go",
 * read at one moment.
 *
 * `bodyScroll` alone is a **liar on exactly the cards that need the scroll**:
 * a card that pins its own `body` (or clips inside a descendant) reports a
 * `scrollHeight` at or below its viewport while its content runs on past the
 * frame — measured on a real card at `bodyScroll 100` against a 1069px range
 * over the body's own contents. The range and the furthest child edge are the
 * rulers that cannot be pinned that way, which is why the height diagnostics
 * already carried them; the scroll decision reads them too.
 */
export interface ContentRulers {
  /** `document.body.scrollHeight`. */
  bodyScroll: number
  /** `document.documentElement.scrollHeight`. */
  docScroll: number
  /** A range over the body's contents, which ignores the body's own box. */
  rangeHeight: number
  /** The furthest bottom edge among the body's descendants. */
  childBottom: number
}

/**
 * The honest content extent: the largest ruler, and no larger.
 *
 * **Max, not any single ruler** — each one is blind to a layout the others
 * see. And **non-finite rulers drop out** rather than poisoning the max: a
 * ruler a realm cannot produce comes back `NaN`, and `Math.max` with `NaN` is
 * `NaN` — one unusable ruler would silently disarm the scroll for every card.
 * @param rulers - the measures, read at one moment.
 * @returns the content extent in pixels, `0` when nothing measures anything.
 */
export function contentExtent(rulers: ContentRulers): number {
  let extent = 0
  for (const value of Object.values(rulers)) {
    if (!Number.isFinite(value)) continue
    if (value > extent) extent = value
  }
  return extent
}

/**
 * Whether the frame's document may scroll its overflowing content.
 *
 * `'auto'` — whatever the clamp, the band, or the card's own pinning put past
 * the frame stays reachable. This is the same turn-on-when-needed the height
 * path already applied; it now also fires when the height signal had nothing
 * to say (a `sizing` frame, an echo measurement) — the scroll answers "is the
 * content reachable", which is a different question from "how tall should the
 * shell make us".
 *
 * It comes off the **honest extent**, not `bodyScroll` alone, and it is
 * **removed when the content fits**: a frame with nothing to scroll must
 * chain its wheel to the page (that is the only way a reader reaches the rest
 * of the conversation past a fitting interface), which is exactly what a
 * leftover `overflow-y: auto` from an earlier, taller layout would swallow —
 * measured: a wheel over such a frame moved neither the frame nor the page.
 *
 * A frame that reports no viewport is not deciding anything yet: it is still
 * being laid out, and the self-reinforcing zero that `frame-entry.ts` records
 * for height applies here too.
 * @param extent - the honest content extent (`contentExtent`).
 * @param viewport - the frame's own viewport, `documentElement.clientHeight`.
 * @returns the inline `overflow-y` value for `html` and `body`.
 */
export function overflowDecision(extent: number, viewport: number): 'auto' | '' {
  if (!Number.isFinite(extent) || !Number.isFinite(viewport)) return ''
  if (viewport <= 0) return ''
  return extent > viewport + OVERFLOW_SLACK_PX ? 'auto' : ''
}

/**
 * Whether the frame's boundary should stop the wheel.
 *
 * `'contain'` — measured on a real card: the frame scrolled to its end and the
 * next wheel notch **scrolled the reading column** (68px → 146px over six
 * notches), because scroll chaining treats the frame's boundary as the page's.
 * A game-style interface the reader is scrolling is a scroller, and a scroller
 * that hands its leftovers to the conversation under it reads as the page
 * being dragged.
 *
 * It is decided from the **scroll range that actually exists after
 * `overflowDecision` is applied**, not from the extent: a card that pinned
 * itself to its viewport (the `sizing` contract — its overflow is its own
 * business, clipped inside its own descendant) never gains a document range,
 * and a zero-range scroller with `contain` would do the one thing this exists
 * to prevent — swallow the wheel without scrolling anything. Reachable content
 * gets a sealed scroller; a fitting or self-pinning frame chains, which is how
 * the reader scrolls on past it.
 * @param scrollRange - `scrollHeight - clientHeight` of whichever element the
 *   overflow decision made a scroller, measured after it applied.
 * @returns the inline `overscroll-behavior` value for `html` and `body`.
 */
export function containDecision(scrollRange: number): 'contain' | '' {
  if (!Number.isFinite(scrollRange) || scrollRange <= 0) return ''
  return scrollRange > OVERFLOW_SLACK_PX ? 'contain' : ''
}
