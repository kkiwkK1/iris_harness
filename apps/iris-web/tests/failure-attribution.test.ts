/**
 * Attributing an error nothing else could attribute.
 *
 * @module iris-web/tests/failure-attribution
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeFailure, topFrame } from '../src/sandbox/failure-attribution.ts'

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
test('a throw carries the frame it came from', () => {
  const error = new Error('Failed to read the \'localStorage\' property from \'Window\'')
  error.stack = [
    'Error: Failed to read the \'localStorage\' property from \'Window\'',
    '    at readSetting (blob:http://127.0.0.1:8787/abc:12:9)',
    '    at boot (blob:http://127.0.0.1:8787/abc:88:3)',
  ].join('\n')

  assert.equal(topFrame(error), ' at readSetting (blob:http://127.0.0.1:8787/abc:12:9)')
})

test('a multi-line message does not push the frame out of reach', () => {
  /*
   * **Why this is not `lines[1]`.** V8 writes `Error: message` first and the
   * frames after — but a multi-line message occupies as many lines as it has,
   * and `UnsupportedApiError` writes one while a `ZodError` writes several. So
   * the second line of the stack is the second line of the *message* for
   * exactly the errors whose location is hardest to guess from their text.
   */
  const error = new Error('two lines')
  error.stack = [
    'ZodError: [',
    '  { "code": "invalid_type", "path": ["stat"] }',
    ']',
    '    at parse (blob:http://127.0.0.1:8787/z:4:1)',
  ].join('\n')

  assert.equal(topFrame(error), ' at parse (blob:http://127.0.0.1:8787/z:4:1)')
})

test('no stack yields nothing rather than a placeholder', () => {
  // A report ending in "at unknown" reads as a failed lookup; in these cases the
  // browser genuinely provided nothing, and the empty string says that by
  // leaving the sentence as it was.
  const bare = new Error('no stack here')
  bare.stack = undefined as unknown as string
  assert.equal(topFrame(bare), '')
  assert.equal(topFrame('a thrown string'), '')
  assert.equal(topFrame(undefined), '')

  // A stack with a message and no frames at all — the shape a cross-origin
  // redaction leaves behind.
  const redacted = new Error('Script error.')
  redacted.stack = 'Error: Script error.'
  assert.equal(topFrame(redacted), '')
})

test('a frame carrying an inlined source is bounded', () => {
  // A `blob:` or `data:` frame name can contain the whole inlined source, and
  // this ends up on one panel line.
  const error = new Error('boom')
  error.stack = `Error: boom\n    at eval (data:text/javascript,${'x'.repeat(500)}:1:1)`
  const frame = topFrame(error)
  assert.ok(frame.length <= 202, `${String(frame.length)} characters reached the panel`)
  assert.match(frame, /\u2026$/, 'a truncation must say it truncated')
})
