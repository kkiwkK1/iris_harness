/**
 * The library-cost instrument, and the ambiguity it exists to remove.
 *
 * This was asked for as a two-way test — `transferSize === 0` means cached — and
 * the middle test below is why it is three-way instead. An experiment run on the
 * two-way version would have read a frame that said *nothing* as a frame that
 * said *cached*, and concluded that caching is shared across frame origins from
 * evidence that contained no information at all.
 *
 * @module iris-web/tests/transfer-cost
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { describeTransferCost, transferVerdict } from '../src/sandbox/transfer-cost.ts'

test('bytes over the wire are reported as a real download', () => {
  const verdict = transferVerdict({
    name: 'http://h/sandbox/preset-abc.js',
    transferSize: 768_967,
    decodedBodySize: 742_000,
    duration: 91,
  })

  assert.deepEqual(verdict, { kind: 'transferred', bytes: 768_967, ms: 91 })
})

test('a cache hit is told apart from an unreadable entry', () => {
  /*
   * The distinction the whole module exists for. Both report
   * `transferSize === 0`; only one of them knows how big the body was.
   *
   * Without `decodedBodySize` these are the same reading, and the question being
   * investigated — is the HTTP cache partitioned per frame origin — would be
   * answered "no, the second frame transferred nothing" by a frame that had
   * simply failed to measure. That is the opposite of the truth, reached from a
   * zero that meant two things.
   */
  const cached = transferVerdict({ name: 'x', transferSize: 0, decodedBodySize: 742_000 })
  assert.deepEqual(cached, { kind: 'cached', bytes: 742_000 })

  const opaque = transferVerdict({ name: 'x', transferSize: 0, decodedBodySize: 0 })
  assert.deepEqual(opaque, { kind: 'unreadable' })

  assert.notEqual(cached.kind, opaque.kind, 'these must never collapse into one answer')
})

test('missing fields are treated as unreadable, not as free', () => {
  // An entry from a browser that reports neither field says nothing. Reading it
  // as a cache hit would be inventing a measurement.
  assert.deepEqual(transferVerdict({ name: 'x' }), { kind: 'unreadable' })
})

test('the sentence names the number, because the number is the finding', () => {
  const line = describeTransferCost(
    [
      { name: 'http://h/sandbox/preset-abc.js', transferSize: 768_967, decodedBodySize: 742_000, duration: 91 },
      { name: 'http://h/sandbox/message-preset-def.js', transferSize: 0, decodedBodySize: 2_400_000 },
    ],
    url => url.slice(url.lastIndexOf('/') + 1),
  )

  assert.ok(line !== undefined)
  assert.ok(line.includes('751 KB'), `expected a size, got: ${line}`)
  assert.ok(line.includes('91ms'))
  assert.ok(line.includes('came from cache'))
  assert.ok(line.includes('2.29 MB'), 'megabyte-scale costs should read as megabytes')
  // Shortened, or the hashed names push the numbers off the end of a panel line.
  assert.ok(!line.includes('http://h/sandbox/'))
})

test('an unreadable entry says so rather than reporting zero bytes', () => {
  const line = describeTransferCost([{ name: 'p.js', transferSize: 0, decodedBodySize: 0 }])

  assert.ok(line !== undefined)
  assert.ok(line.includes('no timings'))
  assert.ok(!line.includes('0 KB'), 'a zero that means "unknown" must not be printed as a size')
})

test('a frame with no libraries reports nothing at all', () => {
  /*
   * The probe frame loads none by design, and a line saying "cost: nothing"
   * would be a permanent entry in every panel that says only that this frame is
   * the one that was always going to be free.
   */
  assert.equal(describeTransferCost([]), undefined)
})
