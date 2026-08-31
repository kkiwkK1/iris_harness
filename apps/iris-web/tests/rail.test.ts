import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RAIL_MAX_TICKS, railMode, stepReading } from '../src/app/rail.ts'

test('one reading needs no rail at all', () => {
  // Eleven of the nineteen cards on the development machine carry no alternate
  // greetings, so absence is the common case and must cost nothing.
  assert.equal(railMode(1), 'hidden')
  assert.equal(railMode(0), 'hidden')
})

test('the ladder is drawn while its ticks are still countable', () => {
  assert.equal(railMode(2), 'ladder')
  assert.equal(railMode(RAIL_MAX_TICKS), 'ladder')
})

test('past the threshold the rail switches to a fixed-height readout', () => {
  assert.equal(railMode(RAIL_MAX_TICKS + 1), 'compact')
  // The worst real card on this machine: thirteen alternate greetings plus the
  // original is fourteen cells, which a ladder cannot draw beside a one-line
  // reply without being taller than it.
  assert.equal(railMode(14), 'compact')
  // Regenerations have no upper bound.
  assert.equal(railMode(300), 'compact')
})

test('a nonsense count is treated as nothing to choose between', () => {
  assert.equal(railMode(Number.NaN), 'hidden')
  assert.equal(railMode(Number.POSITIVE_INFINITY), 'hidden')
})

test('stepping stops at the ends instead of wrapping', () => {
  // Wrapping from the last reading to the first loses the place of anyone
  // holding the key down, and the ends are where they need the feedback of
  // nothing happening.
  assert.equal(stepReading(0, 3, -1), undefined)
  assert.equal(stepReading(2, 3, 1), undefined)
  assert.equal(stepReading(1, 3, -1), 0)
  assert.equal(stepReading(1, 3, 1), 2)
})
