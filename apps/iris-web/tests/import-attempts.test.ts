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
  // Bare entry: no readable timings, which is what a cross-origin resource
  // without `Timing-Allow-Origin` looks like. The answer must still be useful.
  const said = describeAttempts([BUNDLE], [{ name: BUNDLE }])

  assert.match(said, /did send the request/)
  assert.match(said, /cannot read its timings/)
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

test('a completed fetch is distinguished from one still in flight', () => {
  /*
   * "Did send" was true and useless. A real provider sat at fifteen seconds
   * while curl answered the same URL in 46ms, and the verdict pointed at "the
   * network or the server" — correct as far as it went, and it sent a reader to
   * the wrong half of the problem. Sent-and-finished means the delay is *after*
   * the fetch; sent-and-outstanding means it is *in* it.
   */
  const url = 'https://cdn.example/bundle.js'
  const done = describeAttempts([url], [
    { name: url, startTime: 100, responseEnd: 146, requestStart: 105, responseStart: 140, transferSize: 307765 },
  ])
  assert.ok(done.includes('completed in 46ms'))
  assert.ok(done.includes('not where the time went'), 'the reader needs the conclusion, not just numbers')

  const pending = describeAttempts([url], [{ name: url, startTime: 100, responseEnd: 0, responseStart: 0 }])
  assert.ok(pending.includes('has not completed'))
  assert.ok(!pending.includes('completed in'))
})

test('an opaque entry says it cannot be read, rather than reporting zeroes', () => {
  /*
   * Without `Timing-Allow-Origin` every number on a cross-origin entry reads
   * zero. "0ms dns, 0ms connect" looks like data and is an absence — the exact
   * shape of confident wrongness this whole module exists to avoid.
   */
  const url = 'https://cdn.example/bundle.js'
  const opaque = describeAttempts([url], [{ name: url, startTime: 0, responseEnd: 0, responseStart: 0 }])

  assert.ok(opaque.includes('cannot read its timings'))
  assert.ok(opaque.includes('Timing-Allow-Origin'), 'the reader is told what would fix the blindness')
  assert.ok(!opaque.includes('0ms'))
})

test('the phase breakdown names where the time actually went', () => {
  const url = 'https://cdn.example/bundle.js'
  const slow = describeAttempts([url], [
    {
      name: url,
      startTime: 0,
      domainLookupStart: 1,
      domainLookupEnd: 21,
      connectStart: 21,
      connectEnd: 51,
      requestStart: 51,
      responseStart: 9051,
      responseEnd: 9500,
      transferSize: 307765,
    },
  ])
  assert.ok(slow.includes('20ms dns'))
  assert.ok(slow.includes('30ms connect'))
  assert.ok(slow.includes('9000ms waiting for the server'))
  assert.ok(slow.includes('449ms downloading'))
})

test('a cache hit is named as one, so zero bytes is not read as a failure', () => {
  const url = 'https://cdn.example/bundle.js'
  const cached = describeAttempts([url], [
    { name: url, startTime: 0, responseEnd: 3, requestStart: 1, responseStart: 2, transferSize: 0 },
  ])
  assert.ok(cached.includes('came from a cache'))
})

