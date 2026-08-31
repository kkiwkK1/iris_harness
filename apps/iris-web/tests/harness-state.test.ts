/**
 * The harness's own record, tested because it is an instrument.
 *
 * An instrument that reports the previous run's observation as this run's is
 * worse than no instrument: it sends whoever reads it to debug a state the code
 * is not in. This file exists because that has already happened twice here —
 * once with `stopped (unmounted)` reporting React's simulated unmount, once with
 * `started` claiming a body had begun before the frame existed.
 *
 * @module iris-web/tests/harness-state
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { getHarness, resetObservations, setHarness } from '../src/dev/harness-state.ts'

test('a new run does not inherit the previous run identity', () => {
  /*
   * The sequence that would lie: run a card script from `script.list` (which has
   * an id), then drag a file in from disk (which has none). A patched reset would
   * leave the first id standing, and the harness would claim `getScriptId()`
   * answers something the second body never received.
   */
  setHarness({ scriptId: 'from-the-list' })
  resetObservations('loading bootstrap…')

  assert.equal(getHarness().scriptId, undefined, 'the identity must not survive into the next run')
})

test('the previous run ending survives a reset, because it is the one thing worth keeping', () => {
  setHarness({ lastRun: { label: 'a card', result: 'threw', detail: 'boom' } })
  resetObservations('loading bootstrap…')

  assert.deepEqual(getHarness().lastRun, { label: 'a card', result: 'threw', detail: 'boom' })
  assert.equal(getHarness().status, 'loading bootstrap…')
})

test('reset clears the observations a run accumulates', () => {
  setHarness({ errors: ['x'], slash: ['/echo'], blocked: [{ host: 'h', directive: 'd' }], height: 40 })
  resetObservations('idle')
  const state = getHarness()

  assert.deepEqual([state.errors, state.slash, state.blocked], [[], [], []])
  assert.equal(state.height, undefined, 'a stale height would size the next frame from the last one')
})
