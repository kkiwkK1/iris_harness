/**
 * When a frame scrolls itself, and the two ways that decision goes wrong.
 *
 * @module iris-web/tests/frame-height
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OVERFLOW_SLACK_PX,
  applyScrollCapability,
  describeHeightSources,
  heightSignal,
  informsShell,
  overflowsViewport,
  type StyleSurface,
} from '../src/sandbox/frame-height.ts'

test('content past the viewport makes the frame scrollable', () => {
  /*
   * The user-visible fault this exists for: a card's screen grew, its frame did
   * not, and `overflow:hidden` on `html,body` meant the rest was not clipped
   * with a scrollbar — it was gone, with a dead wheel over it.
   */
  assert.equal(overflowsViewport(1200, 524), true)
})

test('content that fits leaves the frame unscrollable, which is the point of the reset', () => {
  /*
   * Upstream's `overflow:hidden` is copied deliberately: a card that sized
   * itself expecting no inner scrollbar lays out differently against one. So
   * the scrollbar has to be absent whenever it is not needed, not merely
   * harmless when present.
   */
  assert.equal(overflowsViewport(524, 524), false)
  assert.equal(overflowsViewport(300, 524), false)
})

test('a couple of pixels over is not an overflow', () => {
  /*
   * The height reaches the shell as a message and is applied a frame later, so
   * in that gap the content is legitimately a pixel or two taller than the
   * viewport it is about to be given. A zero threshold would flash a scrollbar
   * on every ordinary growth — and a scrollbar that appears and vanishes on its
   * own reads as the page glitching, not as a policy.
   */
  assert.equal(overflowsViewport(524 + OVERFLOW_SLACK_PX, 524), false)
  assert.equal(overflowsViewport(524 + OVERFLOW_SLACK_PX + 1, 524), true)
})

test('a frame still being laid out does not turn on a scrollbar', () => {
  /*
   * `clientHeight` is 0 before the frame has a viewport, and 0 is smaller than
   * any content — so a naive comparison says "overflowing" for every frame's
   * first moments and every card would flash a scrollbar as it started.
   *
   * This is the self-reinforcing zero from `frame-entry.ts` read the other way
   * round: there, an unguarded 0 was *reported* and became a permanent height;
   * here an unguarded 0 would be *compared against* and become a permanent
   * scrollbar until the next measurement.
   */
  assert.equal(overflowsViewport(1200, 0), false)
  assert.equal(overflowsViewport(1200, -1), false)
})

test('a measurement that is not a number decides nothing', () => {
  // A frame is untrusted and these come out of a live DOM; `NaN > x` is false
  // by accident rather than by decision, and an accident is not a guard.
  assert.equal(overflowsViewport(Number.NaN, 524), false)
  assert.equal(overflowsViewport(1200, Number.NaN), false)
  assert.equal(overflowsViewport(Number.POSITIVE_INFINITY, 524), false)
})

test('the height report names every source, so a reading cannot be ambiguous', () => {
  const line = describeHeightSources({
    resizes: 3,
    mutations: 11,
    bodyScroll: 807,
    docScroll: 807,
    docClient: 807,
    bodyRect: 807,
    rangeHeight: 1480,
    childBottom: 1502,
    })

  /*
   * Every measure appears, because the point of this line is *which one moved*.
   * A report that showed only the one the frame currently uses would say
   * "807, still 807" through exactly the failure it exists to diagnose.
   */
  for (const expected of ['viewport 807', 'body.scrollHeight 807', 'doc.scrollHeight 807',
    'body rect 807', 'range 1480', 'child bottom 1502']) {
    assert.ok(line.includes(expected), `missing ${expected} in: ${line}`)
  }

  /*
   * And the counters, which answer the question no measure can: whether the
   * observers woke at all. "Never fired" and "fired and read a pinned number"
   * are different repairs and identical from outside an opaque origin.
   */
  assert.ok(line.includes('fired resize 3 mutation 11'), line)
})

test('a measure that is not a number is reported as unknown, not as zero', () => {
  // Zero is a height. `?` is the absence of one, and the difference matters in a
  // report whose whole job is to say which number is wrong.
  const line = describeHeightSources({
    resizes: 0,
    mutations: 0,
    bodyScroll: Number.NaN,
    docScroll: 0,
    docClient: 0,
    bodyRect: 0,
    rangeHeight: Number.POSITIVE_INFINITY,
    childBottom: 0,
  })
  assert.ok(line.includes('body.scrollHeight ?'), line)
  assert.ok(line.includes('range ?'), line)
  assert.ok(line.includes('doc.scrollHeight 0'), line)
})

test('a measurement equal to the viewport tells the shell nothing', () => {
  /*
   * The fixed point, measured on a real card: every ruler returned exactly the
   * frame's viewport while the screen visibly overflowed, because the card
   * clipped its own overflow inside a descendant.
   *
   * Posting that height makes the shell apply the height the frame already has,
   * so the next measurement returns the same number — whatever the frame started
   * at becomes permanent. It looks identical to "measured once at mount", which
   * is exactly why that was the first (wrong) diagnosis.
   */
  assert.equal(informsShell(807, 807), false)
  assert.equal(informsShell(807 + OVERFLOW_SLACK_PX, 807), false)
})

test('a measurement that differs from the viewport is worth sending', () => {
  assert.equal(informsShell(1480, 807), true, 'taller content must be reported')
  assert.equal(informsShell(400, 807), true, 'shorter content must be reported too')
})

test('before the frame has a viewport, any positive measurement is information', () => {
  /*
   * The first measurement happens before the shell has applied anything, and
   * refusing it would leave the frame at its CSS starting height with nothing
   * ever correcting it — the self-reinforcing zero, one door along.
   */
  assert.equal(informsShell(500, 0), true)
})

test('a non-positive measurement is never information', () => {
  // The reason the reporter has always refused these: an inline `height: 0px`
  // beats any CSS floor, so a frame that reports zero can never be seen again.
  assert.equal(informsShell(0, 807), false)
  assert.equal(informsShell(-5, 807), false)
  assert.equal(informsShell(Number.NaN, 807), false)
})

test('a measurable card reports its height', () => {
  assert.deepEqual(heightSignal(1200, 812, false), { kind: 'height', pixels: 1200 })
  assert.deepEqual(heightSignal(1200, 812, true), { kind: 'height', pixels: 1200 })
})

test('an unmeasurable card says so once, then goes quiet', () => {
  assert.deepEqual(heightSignal(812, 812, false), { kind: 'sizing' })
  assert.deepEqual(heightSignal(812, 812, true), { kind: 'silent' })
})

test('a card that becomes measurable again re-arms the announcement', () => {
  /*
   * The case the two halves missed while they lived apart, and the one that
   * matters most: these cards switch screens, and one screen clips its overflow
   * while the next does not.
   *
   * Announcing once and never again would freeze the frame at the last real
   * height the moment a later screen clipped itself — the original fault, one
   * screen narrower. So a real height must leave the frame able to say
   * "unmeasurable" a second time.
   */
  let announced = false

  // Screen one clips: announce, and the shell gives it a screen.
  const first = heightSignal(812, 812, announced)
  assert.deepEqual(first, { kind: 'sizing' })
  announced = true

  // Screen two does not clip: a real height, which must re-arm.
  const second = heightSignal(1400, 812, announced)
  assert.deepEqual(second, { kind: 'height', pixels: 1400 })
  if (second.kind === 'height') announced = false

  // Screen three clips again: it must be able to say so.
  assert.deepEqual(heightSignal(1400, 1400, announced), { kind: 'sizing' })
})

test('a non-positive measurement says nothing at all', () => {
  // Not `sizing` either: zero is not evidence that a card is unmeasurable, it
  // is evidence that this measurement is worthless.
  assert.deepEqual(heightSignal(0, 812, false), { kind: 'silent' })
  assert.deepEqual(heightSignal(Number.NaN, 812, false), { kind: 'silent' })
})

/** A style object that records what was written, like the real one reads. */
function fakeStyle(): StyleSurface {
  let value = ''
  return {
    getPropertyValue: name => (name === 'overflow-y' ? value : ''),
    setProperty: (name, next) => {
      if (name === 'overflow-y') value = next
    },
    removeProperty: name => {
      if (name === 'overflow-y') value = ''
    },
  }
}

test('overflow turns the document scroller on, with the weight to beat the reset', () => {
  /*
   * `important` is not decoration: the injected reset copies upstream's
   * `overflow:hidden !important` on `html,body`, and a plain `auto` would lose
   * to it — the frame would report a height, be clamped to the band, and the
   * content past the band would be gone exactly as before.
   */
  const html = fakeStyle()
  const body = fakeStyle()
  html.setProperty('overflow-y', 'hidden', 'important')
  body.setProperty('overflow-y', 'hidden', 'important')

  applyScrollCapability({ html, body }, 1797, 546)

  assert.equal(html.getPropertyValue('overflow-y'), 'auto')
  assert.equal(body.getPropertyValue('overflow-y'), 'auto')
})

test('content that fits takes the scroller back off', () => {
  /*
   * Both elements, not one: the capability is written to `html` and `body` as a
   * pair, because the scrolling element differs by how the card's own CSS pins
   * them — removing only one leaves the other scrolling (or clipping) against
   * the policy's answer.
   */
  const html = fakeStyle()
  const body = fakeStyle()
  html.setProperty('overflow-y', 'auto', 'important')
  body.setProperty('overflow-y', 'auto', 'important')

  applyScrollCapability({ html, body }, 546, 546)

  assert.equal(html.getPropertyValue('overflow-y'), '', 'html keeps no policy of its own')
  assert.equal(body.getPropertyValue('overflow-y'), '', 'body keeps no policy of its own')
})

test('an unchanged capability is not rewritten', () => {
  /*
   * The reporter runs on every measurement — per animation frame on a busy
   * card. Rewriting the style each time would invalidate layout for nothing;
   * the write happens only when the answer actually changed.
   */
  const html = fakeStyle()
  html.setProperty('overflow-y', 'auto', 'important')
  let writes = 0
  const watched: StyleSurface = {
    getPropertyValue: name => html.getPropertyValue(name),
    setProperty: (name, value, priority) => {
      writes += 1
      html.setProperty(name, value, priority)
    },
    removeProperty: name => {
      writes += 1
      html.removeProperty(name)
    },
  }

  applyScrollCapability({ html: watched, body: fakeStyle() }, 1797, 546)
  assert.equal(writes, 0, 'auto over auto is silence')
})

test('a viewport that does not exist yet decides nothing', () => {
  /*
   * The first measurement races the frame's own layout: `clientHeight` 0 must
   * read as "no overflow" — the scroller off — rather than turning it on for
   * every frame's first moments.
   */
  const html = fakeStyle()
  const body = fakeStyle()
  html.setProperty('overflow-y', 'auto', 'important')
  body.setProperty('overflow-y', 'auto', 'important')

  applyScrollCapability({ html, body }, 1797, 0)

  assert.equal(html.getPropertyValue('overflow-y'), '')
  assert.equal(body.getPropertyValue('overflow-y'), '')
})
