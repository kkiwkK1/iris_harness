import assert from 'node:assert/strict'
import { test } from 'node:test'

import { serializeRequest } from '../src/serialize.ts'

/**
 * The seed field on the wire.
 *
 * A preset ships `seed: -1` meaning "random" — upstream's own sentinel, kept in
 * the settings verbatim. The wire must not see it: an endpoint that types seed
 * as u64 (measured against DeepSeek) refuses the whole request with a 400, so
 * a sentinel that rode along turned every generation of every preset-carrying
 * chat into a dead turn. Dropped at the serialization boundary, the same place
 * `reasoning_effort: 'auto'` is dropped.
 */

const BASE = {
  provider: 'p',
  model: 'm',
  messages: [],
} as Parameters<typeof serializeRequest>[0]

test('a negative seed — upstream\'s "random" sentinel — never reaches the wire', () => {
  const body = serializeRequest({ ...BASE, sampling: { seed: -1 } })
  assert.equal('seed' in body, false)
})

test('a non-negative seed rides the request', () => {
  const body = serializeRequest({ ...BASE, sampling: { seed: 7 } })
  assert.equal(body['seed'], 7)
})

test('no seed at all sends nothing', () => {
  const body = serializeRequest({ ...BASE })
  assert.equal('seed' in body, false)
})
