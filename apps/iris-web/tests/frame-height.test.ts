/**
 * When a frame scrolls itself, and the two ways that decision goes wrong.
 *
 * @module iris-web/tests/frame-height
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { OVERFLOW_SLACK_PX, overflowsViewport } from '../src/sandbox/frame-height.ts'

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
