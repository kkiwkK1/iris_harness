/**
 * The retirement tracker behind the swap-on-ready mechanism.
 *
 * A rebuild costs the replacement its whole boot — members, preset, bootstrap,
 * ready; about a second on a fast machine — and disposing the old frames at
 * the text change turns that whole span into a blank rectangle. The tracker is
 * the decidable core of the fix: which instances are still covered, and the
 * three ways the wait ends.
 *
 * @module iris-web/tests/interface-swap
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { beginRetirement } from '../src/app/interface-swap.ts'

/** A clock the tests drive by hand, standing in for the cap timer. */
function manualClock(): {
  schedule: (fn: () => void, ms: number) => () => void
  fire(): void
  at(): number
} {
  let fn: (() => void) | undefined
  let at = 0
  return {
    schedule: run => {
      fn = run
      return () => {
        fn = undefined
      }
    },
    fire: () => {
      const run = fn
      fn = undefined
      run?.()
    },
    at: () => at,
  }
}

test('an empty park settles immediately, because there is nothing to cover', () => {
  let settled = 0
  const clock = manualClock()
  const retirement = beginRetirement([], () => {
    settled += 1
  }, 10_000, clock.schedule)

  assert.equal(retirement.settled, true, 'a park with no frames waited anyway')
  assert.equal(settled, 1)
})

test('every replacement resolving settles the wait exactly once', () => {
  let settled = 0
  const clock = manualClock()
  const retirement = beginRetirement([0, 1], () => {
    settled += 1
  }, 10_000, clock.schedule)

  assert.equal(retirement.settled, false, 'covered instances are settled before the swap')
  retirement.replaced(0)
  assert.equal(retirement.settled, false, 'one replacement still booting held the park')
  retirement.replaced(1)
  assert.equal(retirement.settled, true)
  assert.equal(settled, 1, 'settled twice for one park')
  retirement.replaced(0)
  assert.equal(settled, 1, 'a late duplicate re-settled')
})

test('a claimed replacement does not resolve; the phases a reader sees do', () => {
  /*
   * `claimed` is the boot itself — exactly the state the park exists to ride
   * out. Resolving on it would swap in a blank frame and reintroduce the
   * flicker, one render later.
   */
  let settled = 0
  const clock = manualClock()
  const retirement = beginRetirement([0], () => {
    settled += 1
  }, 10_000, clock.schedule)

  // The controller calls `replaced` only for resolved phases; the point here
  // is that an unreplaced instance keeps the park open.
  assert.equal(retirement.settled, false)
  retirement.replaced(0)
  assert.equal(retirement.settled, true)
  assert.equal(settled, 1)
})

test('the cap settles a park whose replacement never resolves', () => {
  let settled = 0
  const clock = manualClock()
  beginRetirement([0], () => {
    settled += 1
  }, 10_000, clock.schedule)

  clock.fire()
  assert.equal(settled, 1, 'a broken boot held a stale interface past the cap')
})

test('a replaced park cancels the cap, so a stale timer cannot double-settle', () => {
  let settled = 0
  const clock = manualClock()
  const retirement = beginRetirement([0], () => {
    settled += 1
  }, 10_000, clock.schedule)

  retirement.replaced(0)
  assert.equal(retirement.settled, true)
  clock.fire()
  assert.equal(settled, 1, 'the cap fired after the wait was already over')
})

test('a second resolution after the cap is inert', () => {
  let settled = 0
  const clock = manualClock()
  const retirement = beginRetirement([0], () => {
    settled += 1
  }, 10_000, clock.schedule)

  clock.fire()
  retirement.replaced(0)
  assert.equal(settled, 1)
  assert.equal(retirement.settled, true)
})
