import assert from 'node:assert/strict'
import { test } from 'node:test'

import { approximateWords, since } from '../src/app/format.ts'
import { asRpcError, describeError } from '../src/client/errors.ts'

const NOON = Date.UTC(2026, 7, 31, 12, 0, 0)

test('recent activity reads as an interval, not a clock time', () => {
  // In a sidebar the useful question is how stale a row is, and a wall-clock
  // time makes the reader do the subtraction.
  assert.equal(since(NOON - 20 * 1000, NOON), 'just now')
  assert.equal(since(NOON - 4 * 60 * 1000, NOON), '4m ago')
  assert.equal(since(NOON - 3 * 60 * 60 * 1000, NOON), '3h ago')
  assert.equal(since(NOON - 5 * 24 * 60 * 60 * 1000, NOON), '5d ago')
})

test('a future timestamp does not produce a negative interval', () => {
  assert.equal(since(NOON + 60_000, NOON), 'just now')
})

test('a Chinese paragraph is not counted as one word', () => {
  // A whitespace split reports 1 for text with no spaces in it, which would make
  // the reasoning disclosure lie about its length for half this project's cards.
  assert.equal(approximateWords('雨从傍晚下到现在'), 8)
  assert.equal(approximateWords('two words'), 2)
  assert.equal(approximateWords('混合 mixed text'), 4)
  assert.equal(approximateWords('   '), 0)
})

test('a rejection carrying a code keeps it', () => {
  const error = asRpcError(Object.assign(new Error('nope'), { code: 'busy' }))
  assert.equal(error.code, 'busy')
  assert.equal(error.message, 'nope')
})

test('a plain object rejection is accepted, since the contract does not promise an Error', () => {
  const error = asRpcError({ code: 'provider-error', message: 'upstream refused' })
  assert.equal(error.code, 'provider-error')
  assert.equal(error.message, 'upstream refused')
})

test('an unrecognized failure is reported as internal rather than guessed at', () => {
  assert.equal(asRpcError(new Error('boom')).code, 'internal')
  assert.equal(asRpcError('boom').code, 'internal')
  assert.equal(asRpcError(Object.assign(new Error('x'), { code: 'nonsense' })).code, 'internal')
})

test('the reader sees guidance for codes whose detail is only an identifier', () => {
  const shown = describeError({ code: 'not-found', message: 'no chat "chat-7"' })
  assert.doesNotMatch(shown, /chat-7/)
  assert.match(shown, /reload/)
})

test('a provider refusal keeps its own words, because those are the information', () => {
  assert.equal(
    describeError({ code: 'provider-error', message: 'context length exceeded' }),
    'context length exceeded',
  )
})
