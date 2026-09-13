import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StCompatBridge } from '../src/host/bridge.ts'
import type { StBridgeResult } from '../src/runtime/protocol.ts'

const REV = 7

function generateResult(): StBridgeResult {
  return { kind: 'generate', messages: [], chatVariables: {}, globalVariables: {} }
}

test('an unarmed bridge resolves begin with null immediately — disabled means raw passthrough, not delay', async () => {
  const bridge = new StCompatBridge()
  const started = Date.now()
  const ticket = bridge.begin({
    extensionId: 'st-prompt-template',
    kind: 'generate',
    revision: REV,
    payload: {},
    deadlineMs: 60_000,
  })
  assert.equal(ticket, null)
  assert.ok(Date.now() - started < 50)
})

test('an armed bridge delivers a valid submit to the waiting caller', async () => {
  const bridge = new StCompatBridge()
  bridge.arm('st-prompt-template', REV)
  const ticket = bridge.begin({
    extensionId: 'st-prompt-template',
    kind: 'generate',
    revision: REV,
    payload: {},
    deadlineMs: 5_000,
  })
  assert.notEqual(ticket, null)
  const submitted = bridge.submit({
    token: ticket!.token,
    kind: 'generate',
    revision: REV,
    result: generateResult(),
  })
  assert.deepEqual(submitted, { ok: true })
  const result = await ticket!.wait
  assert.deepEqual(result, generateResult())
})

test('a revision mismatch is refused and named — a stale frame cannot answer', async () => {
  const bridge = new StCompatBridge()
  bridge.arm('st-prompt-template', REV)
  const ticket = bridge.begin({
    extensionId: 'st-prompt-template',
    kind: 'generate',
    revision: REV,
    payload: {},
    deadlineMs: 30,
  })
  const refused = bridge.submit({
    token: ticket!.token,
    kind: 'generate',
    revision: REV - 1,
    result: generateResult(),
  })
  assert.equal(refused.ok, false)
  assert.match(refused.why, /stale frame/)
  // The round is still pending; the deadline resolves it with null.
  assert.deepEqual(await ticket!.wait, null)
})

test('a wrong kind or unknown token is refused without touching the round', async () => {
  const bridge = new StCompatBridge()
  bridge.arm('st-prompt-template', REV)
  const ticket = bridge.begin({
    extensionId: 'st-prompt-template',
    kind: 'reply',
    revision: REV,
    payload: {},
    deadlineMs: 30,
  })
  assert.equal(bridge.submit({ token: 'nope', kind: 'reply', revision: REV, result: generateResult() }).ok, false)
  assert.equal(bridge.submit({ token: ticket!.token, kind: 'generate', revision: REV, result: generateResult() }).ok, false)
  assert.deepEqual(await ticket!.wait, null)
})

test('the deadline resolves the wait with null so generation proceeds raw', async () => {
  const bridge = new StCompatBridge()
  bridge.arm('st-prompt-template', REV)
  const ticket = bridge.begin({
    extensionId: 'st-prompt-template',
    kind: 'generate',
    revision: REV,
    payload: {},
    deadlineMs: 25,
  })
  assert.deepEqual(await ticket!.wait, null)
})

test('detach fails the extension\'s pending rounds toward the raw passthrough and disarms', async () => {
  const bridge = new StCompatBridge()
  bridge.arm('st-prompt-template', REV)
  const ticket = bridge.begin({
    extensionId: 'st-prompt-template',
    kind: 'reply',
    revision: REV,
    payload: {},
    deadlineMs: 60_000,
  })
  assert.equal(bridge.detach('st-prompt-template'), true)
  assert.deepEqual(await ticket!.wait, null)
  assert.equal(bridge.isArmed('st-prompt-template', REV), false)
})

test('arming a different revision supersedes the old plane', () => {
  const bridge = new StCompatBridge()
  bridge.arm('st-prompt-template', REV)
  bridge.arm('st-prompt-template', REV + 1)
  assert.equal(bridge.isArmed('st-prompt-template', REV), false)
  assert.equal(bridge.isArmed('st-prompt-template', REV + 1), true)
  assert.equal(bridge.armed().length, 1)
})

test('arm validates its inputs', () => {
  const bridge = new StCompatBridge()
  assert.throws(() => bridge.arm('', REV), TypeError)
  assert.throws(() => bridge.arm('x', -1), TypeError)
  assert.throws(() => bridge.arm('x', 1.5), TypeError)
})
