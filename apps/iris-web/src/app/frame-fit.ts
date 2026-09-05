/**
 * How tall a message frame may be: the visible band, and no taller.
 *
 * A message interface used to take whatever height its content reported —
 * 776px, 1048px, 1847px, measured on real cards — and the reading column
 * scrolled to reach the rest. That is the fault a user names "卡面前端超级大":
 * a game-style interface should fill the visible band and scroll **inside**
 * itself, not push the conversation a screen and a half down the page.
 *
 * The clamp lives in CSS (`max-height` on the frame element, `reading.css`),
 * because `max-height` beats an inline `height` no matter which one the frame
 * reported — so the shell can keep applying measured heights verbatim and the
 * box still comes out `min(content, band)`. This file holds the one decision
 * that CSS cannot make: **how tall the band is**, in pixels, and which measure
 * wins when the reading scroller is not there to be measured.
 *
 * @module iris-web/app/frame-fit
 */

/**
 * The custom property the band height is published under.
 *
 * Consumed by `reading.css`'s frame rules (`max-height`, and the
 * `data-iris-sizing='viewport'` height). Published on the reading scroller
 * element by `ChatPane`, so every interface slot below it inherits the same
 * number — one writer, many readers, and a stylesheet rule that cannot drift
 * from the number the shell measured.
 */
export const FRAME_BAND_VARIABLE = '--iris-app-frame-height'

/**
 * The band a message frame may fill, in whole CSS pixels.
 *
 * **The scroller's `clientHeight`, when there is one.** The frame lives inside
 * the reading scroller, so "one screen" means that box — not the window, which
 * is taller by the masthead, the composer and the notice region. A frame sized
 * to the window would still not fit the band, and the outer scroller would be
 * back: the exact fault this exists to remove.
 *
 * **The window only as the fallback**, for the one state where no scroller
 * exists to measure — a frame queried before the reading view has mounted its
 * scroller. An approximate answer that keeps the clamp armed beats no answer,
 * which would hand the frame its full content height again.
 *
 * Zero wins through: a zero band would clamp every frame to nothing — the
 * self-reinforcing zero `frame-height.ts` records on the reporting side, read
 * on the applying side. Callers skip publishing rather than write it.
 * @param scroller - the reading scroller's `clientHeight`, or `undefined` when
 *   there is no scroller to measure.
 * @param window - the window's `innerHeight`, the fallback measure.
 * @returns the band height in pixels, or `0` when neither measure is usable.
 */
export function frameBandPixels(
  scroller: number | undefined,
  window: number,
): number {
  const candidates = [scroller, window]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (!Number.isFinite(candidate)) continue
    if (candidate <= 0) continue
    return Math.floor(candidate)
  }
  return 0
}
