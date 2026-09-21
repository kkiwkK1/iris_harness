/**
 * The one depth computation, pinned where both of its consumers can see it.
 *
 * The display projection (`views.ts`) and the prompt history (`service.ts`)
 * must count depth identically — a rule aimed at "the last two floors" that
 * the two stages measure differently lands on different floors, and nothing
 * in the output names the cause.
 *
 * @module iris-app-service/tests/depth-from-end
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { depthFromEnd } from '../src/regex.ts'

test('depth counts from the end: 0 is the newest floor', () => {
  assert.equal(depthFromEnd(2, 7), 4)
  assert.equal(depthFromEnd(6, 7), 0)
  assert.equal(depthFromEnd(0, 7), 6)
})

test('a one-floor conversation is depth 0', () => {
  assert.equal(depthFromEnd(0, 1), 0)
})
