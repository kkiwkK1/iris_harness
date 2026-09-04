/**
 * The one box a card's overlay lives in, and the numbers published about it.
 *
 * The overlay surface used to be `position:fixed; inset:0` — the whole window —
 * and the viewport metrics published to the card were `window.innerWidth` and
 * `window.innerHeight`. Two sources for one fact, and the mismatch between them
 * is a failure class a user measured before it had a name: a frame reporting a
 * **1449px** width against a **1218px** viewport. Under that regime the numbers
 * could only agree by accident, because nothing tied either of them to the
 * element the frame actually fills.
 *
 * The rule now is that **the surface element is the single source of truth**.
 * The frame fills the surface (`width:100%; height:100%`), so the frame's own
 * viewport *is* the surface's content box, and the metrics published to the
 * card are read off that same box. While the element exists they cannot
 * disagree, at any window size, at any layout.
 * @module iris-web/app/overlay-surface
 */

/** A viewport measure, in CSS pixels. */
export interface ViewportSize {
  width: number
  height: number
}

/**
 * The viewport a card's overlay frame should be told about.
 *
 * **The surface's content box while the surface exists.** `clientWidth`/
 * `clientHeight` rather than `getBoundingClientRect`: they round to integers,
 * which is what the frame protocol has always carried, and they exclude the
 * scrollbar the same way the frame's own `innerWidth` excludes the frame's.
 *
 * The fallback is the window, and it is for **one state only**: the surface not
 * being in this React tree yet (`mount.current === null`), which is the moment
 * before the run's frame is attached — no element has ever existed to measure.
 * A *detached* or zero-sized element is deliberately **not** rerouted to the
 * window: a frame inside a zero box is zero-sized, and telling the card
 * `1449×900` while its every measurement returns zero is the two-sources
 * mistake again, wearing a rescue costume.
 * @param surface - the overlay surface element, or null before it exists.
 * @param window_ - the window's size, for the not-yet-mounted state only.
 * @returns what the `viewport` message should carry.
 */
export function overlayViewport(
  surface: { clientWidth: number, clientHeight: number } | null | undefined,
  window_: ViewportSize,
): ViewportSize {
  if (surface === null || surface === undefined) return window_
  return { width: surface.clientWidth, height: surface.clientHeight }
}
