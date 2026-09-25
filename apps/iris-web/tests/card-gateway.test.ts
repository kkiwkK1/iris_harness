/**
 * The card-call gateway, table-driven over every routable card method.
 *
 * The store tests drive the gateway through `runCardAction` for the methods
 * whose shape has a history; this file asks the same three questions of every
 * entry in `CARD_METHODS`, so a method added later cannot quietly sit outside
 * the rule.
 *
 * @module iris-web/tests/card-gateway
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shapeCardCall, type FrameBinding, type LiveScope } from '../src/client/card-gateway.ts'
import { CARD_METHODS } from '../src/sandbox/card-api.ts'

const BINDING: FrameBinding = { kind: 'script', chatId: 'c1', characterId: 'aria', runId: 'c1:1' }
const LIVE: LiveScope = { openChatId: 'c1', currentRun: { runId: 'c1:1', chatId: 'c1' } }
const ENTRIES = Object.entries(CARD_METHODS)

test('every card method is compared, not only the ones with a history', () => {
  // A floor, so a table that shrank to nothing could not pass the loops below.
  assert.ok(ENTRIES.length >= 37, `only ${String(ENTRIES.length)} card methods were compared`)
})

test('every card method refuses a frame-supplied chatId, characterId or runId of another scope', () => {
  for (const [method, wire] of ENTRIES) {
    for (const [key, value] of [['chatId', 'c2'], ['characterId', 'bea'], ['runId', 'c2:9']] as const) {
      const shaped = shapeCardCall(method, wire, { [key]: value }, BINDING, LIVE)
      assert.equal(shaped.ok, false, `${method} forwarded a frame-supplied ${key}`)
      if (!shaped.ok) assert.match(shaped.reason, new RegExp(`^${method} was refused: the frame sent ${key}`))
    }
  }
})

test('every card method stamps the bound chat last and forwards the rest untouched', () => {
  for (const [method, wire] of ENTRIES) {
    const shaped = shapeCardCall(method, wire, { chatId: 'c1', payload: 1 }, BINDING, LIVE)
    assert.ok(shaped.ok, `${method} refused a frame naming its own chat`)
    assert.equal(shaped.params['chatId'], 'c1')
    assert.equal(shaped.params['payload'], 1)
    assert.equal(
      shaped.params['runId'],
      wire === 'script.setExtensionPrompt' ? 'c1:1' : undefined,
      `${method} carried a run id it has no use for`,
    )
  }
})

test('every card method is refused from a frame whose chat is no longer open', () => {
  for (const [method, wire] of ENTRIES) {
    const shaped = shapeCardCall(method, wire, {}, BINDING, { openChatId: 'c2', currentRun: undefined })
    assert.equal(shaped.ok, false, `${method} went through from a frame of a chat that is gone`)
  }
})
