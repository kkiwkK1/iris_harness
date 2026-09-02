/**
 * The report for a card that draws where nobody can see it.
 *
 * @module iris-web/tests/overlay-report
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeOverlayAttempt } from '../src/sandbox/overlay-report.ts'

test('a script frame that drew nothing says nothing', () => {
  /*
   * The correct output for almost every script frame. A line saying that the
   * frame which was never going to draw has not drawn would sit under every
   * card forever, and a report that always speaks is one nobody reads.
   */
  assert.equal(
    describeOverlayAttempt({ built: 0, tags: [], viewportWidth: 0, viewportHeight: 0 }),
    undefined,
  )
})

test('a card that built elements is reported, with what it built', () => {
  const line = describeOverlayAttempt({
    built: 3,
    tags: ['div', 'button', 'canvas'],
    viewportWidth: 0,
    viewportHeight: 0,
  })

  assert.ok(line !== undefined)
  assert.match(line, /built 3 element/)
  assert.match(line, /div, button, canvas/, 'the report names something concrete')
  assert.match(line, /script\*\* frame/, 'and says which kind of frame')
  assert.match(line, /no overlay surface/)
})

test('the zero viewport is named as one cause, not left to be inferred', () => {
  /*
   * [OVERLAY-CARDS.md] The script frame is 0×0 on purpose — `hidden` would be
   * `display:none`, which a card can detect — so all of the card's code runs
   * and every measurement it takes comes back zero.
   *
   * A reader holding only the element count debugs the collapsed layout, then
   * the animation that never starts, then the scroll with nothing to scroll.
   * Naming the viewport turns three investigations into one.
   */
  const line = describeOverlayAttempt({
    built: 1,
    tags: ['div'],
    viewportWidth: 0,
    viewportHeight: 0,
  })

  assert.ok(line !== undefined)
  assert.match(line, /viewport is 0x0/)
  assert.match(line, /one cause, not three separate faults/)
})

test('a frame that does have a viewport does not get the zero explanation', () => {
  // The explanation is only true when the viewport is zero; printing it
  // regardless would make the report say something false about a real frame.
  const line = describeOverlayAttempt({
    built: 2,
    tags: ['div'],
    viewportWidth: 900,
    viewportHeight: 400,
  })

  assert.ok(line !== undefined)
  assert.match(line, /viewport is 900x400/)
  assert.doesNotMatch(line, /every size this card measures is zero/)
})

test('a nonsense count says nothing rather than reporting nonsense', () => {
  for (const built of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(
      describeOverlayAttempt({ built, tags: ['div'], viewportWidth: 0, viewportHeight: 0 }),
      undefined,
      `built=${String(built)}`,
    )
  }
})
