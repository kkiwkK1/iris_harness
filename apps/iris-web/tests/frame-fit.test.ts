/**
 * The frame clamp: the band, and the two halves that have to agree about it.
 *
 * The clamp itself is CSS (`max-height` on the frame, `reading.css`) — the one
 * mechanism that beats the inline height the runner applies from the frame's
 * own report. What can be tested without a browser is the *number* the clamp
 * uses and the pairing that keeps it true: a `max-height` naming a variable
 * nothing publishes would clamp every frame to the fallback forever, which is
 * the silent-failure shape `interface-styles.test.ts` exists against.
 *
 * @module iris-web/tests/frame-fit
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { FRAME_BAND_VARIABLE, frameBandPixels } from '../src/app/frame-fit.ts'

const here = dirname(fileURLToPath(import.meta.url))

test('the band is the scroller when there is one to measure', () => {
  /*
   * The band is the reading scroller's clientHeight, not the window: the frame
   * lives inside the scroller, so "one screen" is that box. A window-sized
   * frame is still taller than the band by the masthead and the composer — the
   * outer scroller would be back, which is the fault this exists to remove.
   */
  assert.equal(frameBandPixels(834, 1080), 834)
  assert.equal(frameBandPixels(522, 768), 522)
})

test('the window is the fallback, for the no-scroller state only', () => {
  assert.equal(frameBandPixels(undefined, 1080), 1080)
})

test('a zero or unusable measure never clamps a frame to nothing', () => {
  /*
   * A zero band would size every frame to 0 — the self-reinforcing zero
   * `frame-height.ts` records on the reporting side, read on the applying side.
   * The scroller's clientHeight reads 0 while the reading view is being laid
   * out; the publisher skips rather than writes it, and the pure function
   * carries the same refusal so no second caller can forget it.
   */
  assert.equal(frameBandPixels(0, 1080), 1080, 'a zero scroller is not a band')
  assert.equal(frameBandPixels(-40, 768), 768, 'a negative scroller is not a band')
  assert.equal(frameBandPixels(Number.NaN, 1080), 1080, 'a NaN scroller is not a band')
  assert.equal(frameBandPixels(undefined, Number.NaN), 0, 'no usable measure, no band')
  assert.equal(frameBandPixels(undefined, 0), 0, 'no usable measure, no band')
})

test('the band is whole pixels, because the protocol carries integers', () => {
  assert.equal(frameBandPixels(834.75, 1080), 834)
})

test('the CSS clamp and the publisher name the same variable', () => {
  /*
   * A pairing guard, the shape of the cqi/container one in
   * `interface-styles.test.ts`: `max-height: var(--iris-app-frame-height)` with
   * nothing publishing it falls back to `100vh` — yesterday's behaviour, which
   * is the 1847px frame this clamp exists to stop, arriving silently.
   */
  const styles = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')
  const pane = readFileSync(join(here, '..', 'src', 'app', 'ChatPane.tsx'), 'utf8')

  const frameAt = styles.indexOf('.iris-interfaces__slot iframe {')
  assert.notEqual(frameAt, -1, 'nothing styles the frame element')
  const frame = styles.slice(frameAt, styles.indexOf('}', frameAt))
  assert.match(
    frame,
    /max-height:\s*var\(--iris-app-frame-height/u,
    'the frame is not clamped to the band — a frame taller than the visible band is back',
  )

  assert.ok(
    pane.includes(FRAME_BAND_VARIABLE),
    'ChatPane no longer publishes the band; the clamp above fell back to 100vh',
  )
  assert.match(pane, /ResizeObserver/u, 'the band is published once and never updated on resize')
})

test('the viewport-sized frame fills the band, not the window', () => {
  /*
   * A frame that cannot be measured (`data-iris-sizing='viewport'`) is sized by
   * this rule alone. Left at `100vh` it was taller than the visible band by the
   * masthead and composer — the same "one screen cannot show it" fault, on the
   * cards that happen to clip their own overflow.
   */
  const styles = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')
  const at = styles.indexOf(".iris-interfaces__slot iframe[data-iris-sizing='viewport']")
  assert.notEqual(at, -1, 'nothing styles the viewport-sized frame')
  const block = styles.slice(at, styles.indexOf('}', at))
  assert.match(block, /var\(--iris-app-frame-height/u)
})
