/**
 * The shell-side fan-out for window events dispatched in a card frame.
 *
 * Small, and that is why it is tested: the whole mechanism it carries is "one
 * dispatch reaches both families", and the two ways it can fail — a dispatch
 * from one half reaching only itself, and a stale teardown silencing the family
 * that replaced it — are both silent from inside a frame.
 *
 * @module iris-web/tests/window-events
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { broadcastWindowEvent, registerWindowEventSink } from '../src/app/window-events.ts'

test('one dispatch reaches every registered family', () => {
  const scripts: string[] = []
  const messages: string[] = []
  const dropScripts = registerWindowEventSink(event => scripts.push(event))
  const dropMessages = registerWindowEventSink(event => messages.push(event))

  broadcastWindowEvent('MvuFloatingBgRequest', { action: 'show' })

  assert.deepEqual(scripts, ['MvuFloatingBgRequest'], 'the script frames heard nothing')
  assert.deepEqual(messages, ['MvuFloatingBgRequest'], 'the message frames heard nothing')
  dropScripts()
  dropMessages()
})

test('the listener-facing shape is built once, where every sender agrees', () => {
  // The DOM contract hands a CustomEvent reader `ev.type` and `ev.detail`; the
  // shape is assembled here so a dispatch from either frame family hands
  // listeners the same one argument.
  let args: readonly unknown[] = []
  const drop = registerWindowEventSink((_event, delivered) => {
    args = delivered
  })

  broadcastWindowEvent('x', { n: 1 })

  assert.deepEqual(args, [{ type: 'x', detail: { n: 1 } }])
  drop()
})

test('a teardown removes exactly its own sink', () => {
  const first: string[] = []
  const second: string[] = []
  const dropFirst = registerWindowEventSink(event => first.push(event))
  const dropSecond = registerWindowEventSink(event => second.push(event))

  dropSecond()
  broadcastWindowEvent('x', undefined)
  dropFirst()

  assert.deepEqual(first, ['x'], 'a sibling’s teardown silenced the survivor')
  assert.deepEqual(second, [], 'a disposed sink was still called')
})
