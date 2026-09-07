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
    describeOverlayAttempt({ built: 0, tags: [], textLength: 0, viewportWidth: 0, viewportHeight: 0 }),
    undefined,
  )
})

test('a card that built elements is reported, with what it built', () => {
  const line = describeOverlayAttempt({
    built: 3,
    tags: ['div', 'button', 'canvas'],
    textLength: 40,
    viewportWidth: 0,
    viewportHeight: 0,
  })

  assert.ok(line !== undefined)
  assert.match(line, /built 3 element/)
  assert.match(line, /div, button, canvas/, 'the report names something concrete')
  assert.match(line, /overlay surface/, 'and says where they went')

  /*
   * **The claim this used to make is now false and must not come back.** It
   * said "Iris has no overlay surface yet, so they are in a frame nobody can
   * see" — true when written, and the exact opposite of the truth once the
   * script frame became the surface. A report whose premise the code has since
   * fixed is worse than none: it sends a reader to build what already exists.
   *
   * Asserted as the absence of the *claim* rather than of a word: the honest
   * sentence still contains "overlay surface", which is why the match above
   * looks for it. Banning the phrase would ban the fix as well as the bug —
   * the same distinction `failure-attribution.test.ts` records for "belongs to"
   * versus "rather than".
   */
  assert.doesNotMatch(line, /no overlay surface/, line)
  assert.doesNotMatch(line, /nobody can see/, line)
})

test('the zero viewport is named as one cause, not left to be inferred', () => {
  /*
   * [notes/apps/iris-web/OVERLAY-CARDS.md] The script frame is 0×0 on purpose — `hidden` would be
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
    textLength: 12,
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
    textLength: 5,
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
      describeOverlayAttempt({ built, tags: ['div'], textLength: 9, viewportWidth: 0, viewportHeight: 0 }),
      undefined,
      `built=${String(built)}`,
    )
  }
})

test('a single empty element is a mount point and says nothing', () => {
  /*
   * The live reading that forced this gate: on 爱衣 the first version fired,
   * because MVU appends one empty `div` to hang its panel off — as it does
   * upstream, where that div also sits in a hidden frame nobody sees.
   *
   * The line was **true**, and would have appeared under every one of the 13
   * cards that bundle MVU, saying the same thing about something that is not
   * wrong. "Built one div" and "built a whole application" were one sentence.
   */
  assert.equal(
    describeOverlayAttempt({
      built: 1,
      tags: ['div'],
      textLength: 0,
      viewportWidth: 0,
      viewportHeight: 0,
    }),
    undefined,
  )
})

test('one element that is meant to be looked at does speak', () => {
  /*
   * Text alone would miss a card that draws with no text — a canvas game, an
   * SVG dial. These tags say "intended to be seen" on their own.
   */
  for (const tag of ['canvas', 'svg', 'img', 'video']) {
    const line = describeOverlayAttempt({
      built: 1,
      tags: [tag],
      textLength: 0,
      viewportWidth: 0,
      viewportHeight: 0,
    })
    assert.ok(line !== undefined, `${tag} should be reported`)
    assert.match(line, new RegExp(tag))
  }
})

test('one element with text speaks, and two empty ones speak', () => {
  assert.ok(describeOverlayAttempt({
    built: 1, tags: ['div'], textLength: 3, viewportWidth: 0, viewportHeight: 0,
  }) !== undefined, 'text is an interface')

  assert.ok(describeOverlayAttempt({
    built: 2, tags: ['div', 'div'], textLength: 0, viewportWidth: 0, viewportHeight: 0,
  }) !== undefined, 'a structure of more than one element is not a mount point')
})
