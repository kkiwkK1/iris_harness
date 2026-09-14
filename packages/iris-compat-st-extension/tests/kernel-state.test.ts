import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StCompatState, substituteMacrosMinimal, translationsFor } from '../src/runtime/kernel-core.ts'
import { StEventBus } from '../src/runtime/event-bus.ts'
import type { StBridgeContext } from '../src/runtime/protocol.ts'

function context(overrides: Partial<StBridgeContext> = {}): StBridgeContext {
  return {
    chatId: 'chat-1',
    chat: [],
    chatVariables: { 好感度: 0 },
    extensionSettings: { EjsTemplate: { enabled: true }, variables: { global: {} }, regex: [] },
    language: 'zh-cn',
    userName: 'User',
    characterName: 'Aka',
    characterId: 0,
    ...overrides,
  }
}

test('hydration mutates the stable objects instead of replacing them', () => {
  const state = new StCompatState()
  const chat = state.chat
  const metadata = state.chatMetadata
  const settings = state.extensionSettings
  state.applyContext(context())
  assert.equal(state.chat, chat)
  assert.equal(state.chatMetadata, metadata)
  assert.equal(state.extensionSettings, settings)
  assert.deepEqual(metadata['variables'], { 好感度: 0 })
})

test('unchanged floors keep their object identity across rounds', () => {
  const state = new StCompatState()
  state.applyContext(context({ chat: [
    { mes: 'hello', name: 'Aka', is_user: false, is_system: false, swipe_id: 0 },
  ] }))
  const first = state.chat[0]
  state.applyContext(context({ chat: [
    { mes: 'hello', name: 'Aka', is_user: false, is_system: false, swipe_id: 0 },
    { mes: 'new floor', name: 'User', is_user: true, is_system: false, swipe_id: 0 },
  ] }))
  assert.equal(state.chat[0], first)
  assert.equal(state.chat.length, 2)
})

test('a changed floor is mutated in place, so captured references see the new text', () => {
  const state = new StCompatState()
  state.applyContext(context({ chat: [
    { mes: 'before', name: 'Aka', is_user: false, is_system: false, swipe_id: 0 },
  ] }))
  const floor = state.chat[0]
  state.applyContext(context({ chat: [
    { mes: 'after', name: 'Aka', is_user: false, is_system: false, swipe_id: 0 },
  ] }))
  assert.equal(floor, state.chat[0])
  assert.equal(floor!.mes, 'after')
})

test('collect returns the variable layers the upstream code left behind', () => {
  const state = new StCompatState()
  state.applyContext(context())
  ;(state.chatMetadata['variables'] as Record<string, unknown>)['好感度'] = 10
  ;((state.extensionSettings['variables'] as { global: Record<string, unknown> }).global)['last'] = 'x'
  assert.deepEqual(state.collectChatVariables(), { 好感度: 10 })
  assert.deepEqual(state.collectGlobalVariables(), { last: 'x' })
})

test('substituteMacrosMinimal expands the documented set and passes unknown macros through', () => {
  const names = { userName: 'User', characterName: 'Aka' }
  assert.equal(substituteMacrosMinimal('{{char}} likes {{user}}', names), 'Aka likes User')
  assert.equal(substituteMacrosMinimal('{{unknown_macro}}', names), '{{unknown_macro}}')
})

test('translationsFor splits data-i18n into text and attribute edits, skipping unknown keys', () => {
  const table = { 'PT Enable': '是否启用扩展', 'Global switch': '全局开关' }
  const textEdits = translationsFor({ textContent: 'x', attributes: new Map([['data-i18n', 'PT Enable']]) }, table)
  assert.deepEqual(textEdits, [{ kind: 'text', value: '是否启用扩展' }])
  const attrEdits = translationsFor(
    { textContent: 'x', attributes: new Map([['data-i18n', '[title]Global switch']]) },
    table,
  )
  assert.deepEqual(attrEdits, [{ kind: 'attribute', attribute: 'title', value: '全局开关' }])
  assert.deepEqual(translationsFor({ textContent: 'x', attributes: new Map([['data-i18n', 'Missing key']]) }, table), [])
})

test('the event bus awaits handlers in order and honours makeFirst/makeLast/once', async () => {
  const bus = new StEventBus()
  const calls: string[] = []
  bus.makeLast('e', () => { calls.push('last'); return 1 })
  bus.makeFirst('e', async () => {
    calls.push('first')
    await new Promise(resolve => setTimeout(resolve, 5))
    calls.push('first-done')
  })
  const once = bus.once('e', () => { calls.push('once') })
  bus.on('e', () => { calls.push('normal') })
  await bus.emit('e')
  // Registration order: makeLast pushed, then makeFirst unshifted in front of
  // it, then once and on appended. Dispatch runs in that final order and each
  // handler is awaited before the next starts.
  assert.deepEqual(calls, ['first', 'first-done', 'last', 'once', 'normal'])
  await bus.emit('e')
  assert.equal(calls.filter(call => call === 'once').length, 1)
  bus.removeListener('e', once)
})
