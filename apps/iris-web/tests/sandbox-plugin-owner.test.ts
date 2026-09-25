import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sandboxPluginOwnerId } from '@iris/protocol'

import { contextFor, pluginRealm } from './plugin-owner-realm.ts'

/**
 * The frame half of `sandbox-plugin-state-keyed-per-card`: a plugin's card
 * surface is bound as its conversation's owner id, not as the bare plugin id.
 *
 * The host half (isolation, forget on remove and on chat delete, copy on
 * branch) is `packages/iris-app-service/tests/sandbox-plugin-owner-state.test.ts`.
 * It keys everything by `sandboxPluginOwnerId`, so the property that ties the
 * two together is the one checked here: the id the frame actually sends is
 * that id.
 */

type Member = (...args: unknown[]) => unknown

test('a plugin’s surface names its conversation in every per-card call it makes', () => {
  const realm = pluginRealm(contextFor('aria-chat-A'))
  const surface = realm.sandbox.cardSurface('01-x')

  // The tooth: `cardSurface: owner => ({ ...tavernHelper, ...viewFor(owner) })`,
  // the pre-fix binding, answers `01-x` here and sends `01-x` below.
  assert.equal((surface['getScriptId'] as Member)(), sandboxPluginOwnerId('aria-chat-A', '01-x'))

  void (surface['insertOrAssignVariables'] as Member)({ turns: 1 }, { type: 'script' })
  const write = realm.calls().find(call => call.method === 'setVariables')
  assert.equal(write?.params['scope'], 'script')
  assert.equal(write?.params['scriptId'], 'sp:aria-chat-A:01-x')
})

test('the same plugin id in another conversation is a different owner', () => {
  const inA = pluginRealm(contextFor('aria-chat-A')).sandbox.cardSurface('01-x')
  const inB = pluginRealm(contextFor('aria-chat-B')).sandbox.cardSurface('01-x')
  assert.notEqual((inA['getScriptId'] as Member)(), (inB['getScriptId'] as Member)())
})

test('without a chat id the plugin has no script identity, rather than a shared one', () => {
  const realm = pluginRealm(contextFor('ignored', { chatId: undefined }))
  const surface = realm.sandbox.cardSurface('01-x')
  // Undefined, which the script scope refuses by name. The wrong implementation
  // is a fall back to the bare `01-x`, which is exactly the per-card table the
  // owner id exists to keep plugins out of.
  assert.equal((surface['getScriptId'] as Member)(), undefined)
  assert.throws(() => (surface['getVariables'] as Member)({ type: 'script' }), /script_id/u)
})
