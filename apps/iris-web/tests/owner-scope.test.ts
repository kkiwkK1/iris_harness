import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createOwnerScope, refuseIfDisposed, TRACE_MEMBERS } from '../src/sandbox/owner-scope.ts'
import { MEMBER_KINDS } from '../src/sandbox/identity.ts'

/**
 * The primitive on its own: Cordis's effect shape, with the two differences
 * `owner-scope.ts` names (serial reverse order, failures returned).
 */

test('an effect runs at once, and dispose undoes every effect newest first with one row each', () => {
  const scope = createOwnerScope()
  const log: string[] = []
  scope.effect(() => { log.push('do a'); return () => log.push('undo a') }, 'a')
  scope.effect(() => { log.push('do b'); return () => log.push('undo b') }, 'b')
  scope.effect(() => { log.push('do c'); return () => log.push('undo c') }, 'c')
  assert.deepEqual(log, ['do a', 'do b', 'do c'])

  const steps = scope.dispose()
  // Reverse, and serial: Cordis would start all three under one Promise.all.
  assert.deepEqual(log.slice(3), ['undo c', 'undo b', 'undo a'])
  assert.deepEqual(steps.map(step => step.label), ['c', 'b', 'a'])
  assert.ok(steps.every(step => step.ok))
  assert.equal(scope.size(), 0)
})

test('an undo that throws is a failed row, and the ones after it still run', () => {
  const scope = createOwnerScope()
  const log: string[] = []
  scope.effect(() => () => log.push('undo a'), 'a')
  scope.effect(() => () => { throw new Error('stuck') }, 'b')
  scope.effect(() => () => log.push('undo c'), 'c')

  const steps = scope.dispose()
  assert.deepEqual(log, ['undo c', 'undo a'], 'a failure stopped the sweep')
  assert.deepEqual(steps, [
    { label: 'c', ok: true },
    { label: 'b', ok: false, detail: 'stuck' },
    { label: 'a', ok: true },
  ])
})

test('an early release undoes one effect and teardown does not repeat it', () => {
  const scope = createOwnerScope()
  let undone = 0
  const release = scope.effect(() => () => { undone += 1 }, 'a')
  release()
  release()
  assert.equal(undone, 1)
  assert.deepEqual(scope.dispose(), [])
  assert.equal(undone, 1)
})

test('a disposed owner cannot register anything more', () => {
  const scope = createOwnerScope()
  scope.dispose()
  let ran = false
  assert.throws(() => scope.effect(() => { ran = true; return () => undefined }, 'late'), /disposed/u)
  // Refused before the effect ran, which is the point: a late listener that
  // was added and then refused would still be on the bus.
  assert.equal(ran, false)
  assert.throws(() => refuseIfDisposed(scope, 'eventOn'), /eventOn/u)
})

test('every trace member is a member the card surface actually has', () => {
  // A name misspelled here would be wrapped by nothing and compared by nothing.
  for (const name of Object.keys(TRACE_MEMBERS)) {
    assert.ok(Object.hasOwn(MEMBER_KINDS, name), `${name} is not in MEMBER_KINDS`)
  }
})
