/**
 * Attributing an error nothing else could attribute.
 *
 * @module iris-web/tests/failure-attribution
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeFailure } from '../src/sandbox/failure-attribution.ts'

test('after a body ran, the card scheduled it', () => {
  const line = describeFailure('an unhandled rejection', 'boom', {
    bodyRan: true,
    interfaceFrame: false,
  })
  assert.match(line, /after a card body ran/)
  assert.match(line, /code the card scheduled/)
})

test('a script frame with no body yet is the frame’s own setup', () => {
  // The only case where blaming the frame is licensed: nothing of the card's
  // has executed, because a script frame receives its body over the channel.
  const line = describeFailure('an uncaught error', 'boom', {
    bodyRan: false,
    interfaceFrame: false,
  })
  assert.match(line, /belongs to the frame's own setup/)
})

test('an interface frame with no body yet does not blame the frame', () => {
  /*
   * **The bug this exists for.** An interface frame's markup — its `<script>`
   * elements included — runs *while the document parses*, long before any `run`
   * message sets the body flag. So "no card body has started" is not the same
   * fact as "no card code has run", and only the second licenses blaming the
   * frame.
   *
   * A real card produced `ReferenceError: errorCatched is not defined` and it
   * was reported as the frame's own setup. `errorCatched` appears nowhere in the
   * frame's code — it is an upstream global the card expected — so the report
   * sent a reader hunting a bootstrap bug that did not exist.
   */
  const line = describeFailure('an uncaught error', 'errorCatched is not defined', {
    bodyRan: false,
    interfaceFrame: true,
  })

  /*
   * The discriminator is "belongs to" versus "rather than", not the presence of
   * the phrase: the honest message *uses* "the frame's own setup" to contrast
   * against it. A first version of this assertion forbade the substring and
   * failed on the correct output — banning a word is not the same as banning a
   * claim.
   */
  assert.doesNotMatch(line, /belongs to the frame's own setup/, line)
  assert.match(line, /rather than the frame's own setup/, line)
  assert.match(line, /carries the card's markup/)
  assert.match(line, /while the document parses/)
  // Still says it cannot be certain, because it cannot: setup code and inlined
  // markup both run in that window.
  assert.match(line, /most likely/)
})

test('the error text and kind always survive into the message', () => {
  // Whatever else the sentence claims, the two facts it actually has must be in
  // it — an attribution that loses the error text costs a reader the one thing
  // no reasoning can reconstruct.
  for (const interfaceFrame of [true, false]) {
    for (const bodyRan of [true, false]) {
      const line = describeFailure('an unhandled rejection', 'the-original-text', {
        bodyRan,
        interfaceFrame,
      })
      assert.match(line, /an unhandled rejection/)
      assert.match(line, /the-original-text/)
    }
  }
})
