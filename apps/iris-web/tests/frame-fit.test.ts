/**
 * The viewport-mode frame's screen: the band, and the two halves that have to
 * agree about it.
 *
 * This file used to guard a clamp — `max-height` on every message frame, held
 * to the band — and its pairing test asserted that clamp alive. Reversed on
 * 2026-09-21: upstream renders a message's card markup at natural height and
 * lets the page scroll, and the band read as a broken embed on aspect-locked
 * cards (黑兽's opening page). What remains of the mechanism is the band the
 * `data-iris-sizing='viewport'` rule fills — a card that *asks* for a screen —
 * and the absence pin below, because a clamp that was deliberately removed is
 * exactly the kind of rule a later "fix" re-adds without knowing the ruling.
 *
 * @module iris-web/tests/frame-fit
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { frameBandPixels } from '../src/app/frame-fit.ts'

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

test('the base frame rule carries no clamp, and the publisher still feeds the band', () => {
  /*
   * The absence pin, standing where the clamp's pairing guard used to stand.
   * The clamp was removed by ruling, not by accident: a frame is as tall as the
   * height it reports, the page scrolls, and re-adding a `max-height` here
   * would silently re-break every aspect-locked card (黑兽's opening page
   * measured) into an internal scrollbox. The publisher stays — the
   * `data-iris-sizing='viewport'` rule below still fills its screen from the
   * band — so the pairing that remains is one-directional and asserted too.
   */
  const styles = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')
  const pane = readFileSync(join(here, '..', 'src', 'app', 'ChatPane.tsx'), 'utf8')

  const frameAt = styles.indexOf('.iris-interfaces__slot iframe {')
  assert.notEqual(frameAt, -1, 'nothing styles the frame element')
  const frameBlock = styles.slice(frameAt, styles.indexOf('}', frameAt))
  /*
   * Comments stripped before the match: the ruling's tombstone lives in a
   * comment inside this very rule, and a pin that read comments would fire on
   * its own explanation.
   */
  const frame = frameBlock.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(
    frame,
    /max-height/u,
    'the clamp is back — natural height is the ruling; move any cap behind an explicit request, not this rule',
  )

  assert.ok(
    pane.includes('FRAME_BAND_VARIABLE'),
    'ChatPane no longer publishes the band; the viewport-mode rule fell back to 100vh',
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
