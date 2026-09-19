import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isEvent, parseRequest, requestSchemas, RpcCallError, type IrisEvent } from '../src/index.ts'

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

test('an entry with no uid is a valid book write, because the host mints one', () => {
  // The transport-level defect `lorebook-aliases.ts` names for the old lorebook
  // family, fixed at the schema for every caller: upstream's entry type is
  // `PartialDeep`, and the host's own `resolveUidCollisions` opens with
  // `entry.uid ?? <random>`. Requiring `uid` here made that branch unreachable
  // and refused a real card at `entries[110].uid`.
  const result = parseRequest('worldbook.replace', {
    name: '黑兽',
    entries: [{ uid: 0, name: 'existing' }, { name: '开局档案·玩家', content: '【玩家档案】' }],
  })

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.params.entries.length, 2)
})

test('a uid that is present is still bounded', () => {
  assert.equal(
    parseRequest('worldbook.replace', { name: 'b', entries: [{ uid: -1 }] }).ok,
    false,
  )
  assert.equal(
    parseRequest('worldbook.replace', { name: 'b', entries: [{ uid: 1.5 }] }).ok,
    false,
  )
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

test('a call rejection is a real Error that still carries its code', () => {
  // Rejecting with a bare shape loses the stack, and every tool that formats
  // errors degrades to printing `[object Object]`.
  const error = new RpcCallError({ code: 'busy', message: 'that chat is generating' })

  assert.ok(error instanceof Error)
  assert.equal(error.code, 'busy')
  assert.equal(error.message, 'that chat is generating')
  assert.equal(error.name, 'RpcCallError')
  assert.match(String(error.stack), /RpcCallError/)
})
