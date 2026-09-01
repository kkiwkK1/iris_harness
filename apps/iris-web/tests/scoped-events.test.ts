/**
 * Per-script teardown over a shared bus.
 *
 * The property under test is the one co-location removes for free: upstream
 * gives each script its own frame, so `eventClearAll` structurally cannot reach
 * a sibling. Sharing a realm hands that back unless ownership is rebuilt, and
 * the failure is quiet — a silently unhooked listener looks exactly like an
 * event that was never emitted.
 *
 * @module iris-web/tests/scoped-events
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '@iris/compat-tavernhelper-core'

import { scopedEvents } from '../src/sandbox/scoped-events.ts'

/** The frame's real guard: an event name must be a non-empty string. */
const guard = (member: string, event: unknown): string => {
  if (typeof event !== 'string' || event === '') throw new Error(`${member}: bad event`)
  return event
}

/** Two scripts of one card, sharing a bus. */
function card() {
  const bus = new EventBus()
  return { bus, one: scopedEvents(bus, guard), two: scopedEvents(bus, guard) }
}

test('emission reaches every script of the card', async () => {
  // The half that must stay shared: this is how one script's work becomes
  // another's input.
  const { bus, one, two } = card()
  const heard: string[] = []
  one.eventOn('tick', () => heard.push('one'))
  two.eventOn('tick', () => heard.push('two'))

  await bus.eventEmit('tick')

  assert.deepEqual(heard, ['one', 'two'])
})

test('clearing everything clears only the script that asked', async () => {
  /*
   * The load-bearing case. Upstream fires `eventClearAll` from `predefine.js` on
   * `pagehide`, per frame — so a script's listeners die with the script and a
   * sibling's are untouchable. One frame per card must not turn that into a
   * card-wide wipe.
   */
  const { bus, one, two } = card()
  const heard: string[] = []
  one.eventOn('tick', () => heard.push('one'))
  two.eventOn('tick', () => heard.push('two'))

  one.eventClearAll()
  await bus.eventEmit('tick')

  assert.deepEqual(heard, ['two'], "a sibling's listener was removed by a teardown that was not its own")
})

test('clearing one event clears only this script’s listeners for it', async () => {
  // The bus's own `eventClearEvent` deletes the whole slot; scoped, it must
  // intersect with what this script registered.
  const { bus, one, two } = card()
  const heard: string[] = []
  one.eventOn('tick', () => heard.push('one'))
  two.eventOn('tick', () => heard.push('two'))

  one.eventClearEvent('tick')
  await bus.eventEmit('tick')

  assert.deepEqual(heard, ['two'])
})

test('clearing by function reaches only the caller’s registrations', async () => {
  // Two scripts registering the *same* function object: clearing it from one
  // must leave the other's subscription alive.
  const { bus, one, two } = card()
  const heard: string[] = []
  const listener = (): void => {
    heard.push('x')
  }
  one.eventOn('tick', listener)
  two.eventOn('tick', listener)

  one.eventClearListener(listener)
  await bus.eventEmit('tick')

  assert.equal(heard.length, 1, "the sibling's registration of the same function was removed too")
})

test('a subscription handle stops only its own listener', async () => {
  const { bus, one } = card()
  const heard: string[] = []
  const first = one.eventOn('tick', () => heard.push('first'))
  one.eventOn('tick', () => heard.push('second'))

  first.stop()
  await bus.eventEmit('tick')

  assert.deepEqual(heard, ['second'])
})

test('a stopped subscription is not torn down twice', async () => {
  // The handle forgets as well as stops, so teardown does not later try to
  // remove a listener the bus no longer holds.
  const { bus, one, two } = card()
  const heard: string[] = []
  const handle = one.eventOn('tick', () => heard.push('one'))
  two.eventOn('tick', () => heard.push('two'))

  handle.stop()
  one.eventClearAll()
  await bus.eventEmit('tick')

  assert.deepEqual(heard, ['two'])
})

test('a bad event name is refused before it is recorded', () => {
  // Otherwise a missing table entry registers under the string "undefined" and
  // the record grows an owner for an event nobody can emit.
  const { one } = card()

  assert.throws(() => one.eventOn(undefined as never, () => undefined), /eventOn: bad event/)
})
