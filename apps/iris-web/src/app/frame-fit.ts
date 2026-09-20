/**
 * How tall a **viewport-mode** frame's screen is: the visible band.
 *
 * This file used to arm a clamp — `max-height` on every message frame, holding
 * each one to the visible band so a tall interface scrolled inside itself
 * rather than pushing the conversation down the page. Reversed on 2026-09-21
 * (`reading.css` carries the reasoning): upstream renders a message's card
 * markup at its natural height and lets the page scroll, and the band read as
 * a broken embed on aspect-locked cards. What survives here is the one
 * consumer the reversal left — the `data-iris-sizing='viewport'` rule, for a
 * card that **asks** to be a screen and clips its own overflow. For those the
 * band is still the honest answer to "how big is one screen here", and this
 * file holds the decision CSS cannot make: how tall that screen is, in pixels,
 * and which measure wins when the reading scroller is not there to be measured.
 *
 * @module iris-web/app/frame-fit
 */

/**
 * The custom property the band height is published under.
 *
 * Consumed by `reading.css`'s `data-iris-sizing='viewport'` height. Published
 * on the reading scroller element by `ChatPane`, so every interface slot below
 * it inherits the same number — one writer, many readers, and a stylesheet
 * rule that cannot drift from the number the shell measured.
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
