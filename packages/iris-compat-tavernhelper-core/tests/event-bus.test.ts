/**
 * The bus answers for its deliveries: `listenerCount` is the shell's own
 * observability over "did this event reach anyone" — the question the
 * settled-generation chain once answered with silence (MagVarUpdate not
 * hearing `MESSAGE_RECEIVED` looked identical to a working chain from every
 * side but this one).
 *
 * @module iris-compat-tavernhelper-core/tests/event-bus
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '../src/events.ts'

test('listenerCount answers per event name, and 0 for nothing subscribed', () => {
  const bus = new EventBus()
  assert.equal(bus.listenerCount('message_received'), 0)

  const stop = bus.eventOn('message_received', () => {})
  bus.eventOn('message_received', () => {})
  assert.equal(bus.listenerCount('message_received'), 2)

  bus.eventOnce('message_received', () => {})
  assert.equal(bus.listenerCount('message_received'), 3, 'once counts until it fires')

  stop.stop()
  assert.equal(bus.listenerCount('message_received'), 2, 'the subscription handle removes its own listener')
  assert.equal(bus.listenerCount('generation_ended'), 0, 'another event name starts at 0')
})
