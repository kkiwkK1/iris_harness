/**
 * The reading that decides which half of the world a reader looks at.
 *
 * This exists because of a rule worth stating plainly: **an instrument that only
 * speaks on an exception has unfalsifiable silence.** Saying nothing could mean
 * nothing went wrong, or that the instrument is broken, and nothing in a green
 * suite distinguishes those. The only thing that does is a test which hands it
 * the trigger and requires it to speak.
 *
 * This one had already been wrong, and it was fixed without being pinned — which
 * left the fix resting on the same judgment that wrote the fault.
 *
 * @module iris-web/tests/import-attempts
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { describeAttempts } from '../src/sandbox/import-attempts.ts'

const BUNDLE = 'https://testingcf.jsdelivr.net/gh/x/y@beta/bundle.js'
const OTHER = 'https://cdn.jsdelivr.net/npm/z/index.js'

test('a request that reached the wire points away from the frame', () => {
  const said = describeAttempts([BUNDLE], [{ name: BUNDLE }])

  assert.match(said, /did send the request/)
  assert.match(said, /not the frame/)
})

test('a request that never reached the wire points at the frame', () => {
  const said = describeAttempts([BUNDLE], [{ name: 'https://example.test/other.js' }])

  assert.match(said, /never sent the request/)
  assert.match(said, /before the wire/)
})

test('no imports at all is neither of those, and used to be reported as one', () => {
  /*
   * The fault this file was extracted for. With no targets the answer used to be
   * "the browser never sent the request", which is false rather than merely
   * unhelpful — there was no request to send. A module parked on a top-level
   * `await` was reported as a network problem, and the reader went to the wrong
   * half of the world.
   */
  const said = describeAttempts([], [{ name: BUNDLE }])

  assert.match(said, /no remote imports/)
  assert.doesNotMatch(said, /never sent the request/, 'the old false answer must not come back')
  assert.doesNotMatch(said, /did send the request/)
})

test('a frame that cannot measure says so, rather than implying nothing was sent', () => {
  // A missing API must not read as a missing request: that is the same
  // substitution in a different costume.
  const said = describeAttempts([BUNDLE], undefined)

  assert.match(said, /unavailable here/)
  assert.doesNotMatch(said, /never sent/)
})

test('a partial answer names which ones went', () => {
  // Neither blanket answer is true here, and choosing one would hide the other.
  const said = describeAttempts([BUNDLE, OTHER], [{ name: BUNDLE }])

  assert.match(said, /only some were sent/)
  assert.match(said, /gh\/x\/y@beta/)
})

test('an empty entry list with real targets is still "never sent"', () => {
  // The other zero case: no entries at all, but something was expected. Unlike
  // zero targets, "never sent" is the true answer here.
  const said = describeAttempts([BUNDLE], [])

  assert.match(said, /never sent the request/)
})
