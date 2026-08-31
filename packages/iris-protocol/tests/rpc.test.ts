import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isEvent, parseRequest, requestSchemas, type IrisEvent } from '../src/index.ts'

test('a well-formed request parses', () => {
  const result = parseRequest('chat.send', { chatId: 'c1', text: '你好' })

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.params.text, '你好')
})

test('a malformed request is refused rather than thrown', () => {
  // The transport has to answer with a frame; throwing would take the socket
  // down and with it every other page watching the same host.
  const result = parseRequest('chat.send', { chatId: 'c1' })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'invalid-request')
})

test('an unknown method is refused by name', () => {
  const result = parseRequest('chat.teleport' as never, {})

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'unsupported')
})

test('an oversized prompt is refused at the boundary', () => {
  const result = parseRequest('chat.send', { chatId: 'c1', text: 'x'.repeat(32_001) })

  assert.equal(result.ok, false)
})

test('an empty message is refused', () => {
  assert.equal(parseRequest('chat.send', { chatId: 'c1', text: '' }).ok, false)
})

test('a negative swipe index is refused', () => {
  assert.equal(parseRequest('chat.swipe', { chatId: 'c1', turn: 0, index: -1 }).ok, false)
  assert.equal(parseRequest('chat.swipe', { chatId: 'c1', turn: 0, index: 0 }).ok, true)
})

test('every method has a request schema', () => {
  // The guard against a method reaching the host without validation.
  for (const [method, schema] of Object.entries(requestSchemas)) {
    assert.ok(schema !== undefined, `${method} has no schema`)
    assert.equal(typeof schema.safeParse, 'function')
  }
})

test('events narrow by type', () => {
  const event: IrisEvent = { type: 'stream.text', chatId: 'c1', turn: 0, delta: 'hi' }

  assert.equal(isEvent(event, 'stream.text'), true)
  assert.equal(isEvent(event, 'stream.end'), false)
  if (isEvent(event, 'stream.text')) assert.equal(event.delta, 'hi')
})
