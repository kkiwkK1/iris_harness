/**
 * The interim depth window, and the value that inverts the feature.
 *
 * @module iris-web/tests/render-window
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { floorsToRender } from '../src/sandbox/render-window.ts'

/** A conversation of plain floors. */
function floors(count: number): { id: number }[] {
  return Array.from({ length: count }, (_unused, id) => ({ id }))
}

test('depth 0 means every floor, which is upstream’s default', () => {
  /*
   * The reading that inverts the feature. `0` is upstream's own default and it
   * means "no window" — taken as "none", a reader turns rendering off for
   * everyone while believing they left it alone.
   */
  const allowed = floorsToRender(floors(5), { depth: 0 })
  assert.equal(allowed.size, 5)
})

test('a depth counts back from the end', () => {
  const allowed = floorsToRender(floors(10), { depth: 3 })

  assert.deepEqual([...allowed].sort((a, b) => a - b), [7, 8, 9])
})

test('a depth larger than the conversation keeps all of it', () => {
  const allowed = floorsToRender(floors(2), { depth: 50 })
  assert.equal(allowed.size, 2)
})

test('hidden floors do not spend the budget when they are being ignored', () => {
  /*
   * Upstream splits its own function in two for this. With `ignoreHidden`, a run
   * of system messages at the end must not push every real message out of the
   * window — the user would see rendering stop for no visible reason.
   */
  const conversation = [
    { id: 0 },
    { id: 1 },
    { id: 2 },
    { id: 3, isSystem: true },
    { id: 4, isSystem: true },
  ]

  const counting = floorsToRender(conversation, { depth: 2 })
  assert.deepEqual([...counting].sort((a, b) => a - b), [3, 4], 'without the flag, hidden floors count')

  const ignoring = floorsToRender(conversation, { depth: 2, ignoreHidden: true })
  assert.deepEqual([...ignoring].sort((a, b) => a - b), [1, 2], 'with it, real messages keep the budget')
})

test('an empty conversation allows nothing, without special-casing', () => {
  assert.equal(floorsToRender([], { depth: 0 }).size, 0)
  assert.equal(floorsToRender([], { depth: 5 }).size, 0)
})

test('a negative depth is treated as "all" rather than as a smaller window', () => {
  // Defensive but deliberate: `slice(-n)` with a negative `n` would silently
  // return the whole array anyway, so the explicit branch makes the two agree
  // instead of relying on a coincidence of `slice`.
  assert.equal(floorsToRender(floors(4), { depth: -1 }).size, 4)
})
