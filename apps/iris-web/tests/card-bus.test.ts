/**
 * The one road from the interface into a running card.
 *
 * @module iris-web/tests/card-bus
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { emitToCard, registerCardEmitter } from '../src/app/card-bus.ts'

/** A recorder, plus the disposer that unregisters it. */
function emitter() {
  const seen: { event: string, args: readonly unknown[] }[] = []
  const off = registerCardEmitter((event, args) => seen.push({ event, args }))
  return { seen, off }
}

test('an emit reaches the registered card', () => {
  const one = emitter()
  try {
    assert.equal(emitToCard('abc_123', []), true)
    assert.deepEqual(one.seen, [{ event: 'abc_123', args: [] }])
  } finally {
    one.off()
  }
})

test('with no card running, an emit reports rather than vanishing', () => {
  /*
   * The return value is the whole point. A press that reached nothing and a
   * press that reached a card with no listener look identical from here, and
   * only the first is worth telling somebody about — so the caller needs to be
   * able to tell them apart, and `false` is how.
   */
  assert.equal(emitToCard('nobody', []), false)
})

test('a late teardown from the previous card does not silence the current one', () => {
  /*
   * The hazard this module is shaped around. React cleanups do not run in a
   * guaranteed order relative to the next effect's setup: closing one chat and
   * opening another can register the new emitter *before* the old one's cleanup
   * fires. A disposer that cleared unconditionally would then unregister the
   * card that just arrived.
   *
   * The symptom would be buttons that do nothing, only for the chat you switched
   * *to*, only sometimes — which is close to unreportable.
   */
  const first = emitter()
  const second = emitter()

  // The old card's cleanup arrives late.
  first.off()

  assert.equal(emitToCard('after-switch', []), true, 'the current card was unregistered')
  assert.deepEqual(second.seen.map(one => one.event), ['after-switch'])
  assert.deepEqual(first.seen, [], 'the replaced emitter must not still be receiving')

  second.off()
})

test('registering replaces rather than accumulating', () => {
  // Iris runs one card's scripts — the foreground chat's. A second registration
  // means the first set is gone, not that two are live; delivering to both would
  // emit into frames that have been torn down.
  const first = emitter()
  const second = emitter()

  emitToCard('once', [])

  assert.deepEqual(first.seen, [])
  assert.equal(second.seen.length, 1)
  second.off()
  first.off()
})

test('the disposer leaves nothing behind', () => {
  const one = emitter()
  one.off()
  assert.equal(emitToCard('gone', []), false)
})

test('arguments travel', () => {
  const one = emitter()
  try {
    emitToCard('with-args', [1, 'two'])
    assert.deepEqual(one.seen[0]?.args, [1, 'two'])
  } finally {
    one.off()
  }
})
