import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendCandidate, selectCandidate } from '@iris/chat'

import {
  keyedMemoryBackend,
  memoryBackend,
  sessionMessageBackend,
  VariableScopeError,
  VariableStore,
} from '../src/index.ts'

/** A store with the simple scopes backed by memory. */
function memoryStore() {
  return new VariableStore({
    chat: memoryBackend(),
    global: memoryBackend(),
    character: memoryBackend(),
    script: keyedMemoryBackend(option => (option.type === 'script' ? option.script_id ?? '' : '')),
  })
}

test('a scope with no backend is refused rather than reading empty', () => {
  const store = new VariableStore({ chat: memoryBackend() })

  assert.throws(() => store.getVariables({ type: 'global' }), VariableScopeError)
})

test('reads are detached from the store', () => {
  const store = memoryStore()
  store.replaceVariables({ 络络: { 好感度: 5 } }, { type: 'chat' })

  const copy = store.getVariables({ type: 'chat' }) as { 络络: { 好感度: number } }
  copy.络络.好感度 = 99

  assert.deepEqual(store.getVariables({ type: 'chat' }), { 络络: { 好感度: 5 } })
})

test('scopes do not leak into each other', () => {
  const store = memoryStore()
  store.replaceVariables({ a: 1 }, { type: 'chat' })
  store.replaceVariables({ b: 2 }, { type: 'global' })

  assert.deepEqual(store.getVariables({ type: 'chat' }), { a: 1 })
  assert.deepEqual(store.getVariables({ type: 'global' }), { b: 2 })
})

test('the script scope is keyed by script id', () => {
  const store = memoryStore()
  store.replaceVariables({ n: 1 }, { type: 'script', script_id: 'one' })
  store.replaceVariables({ n: 2 }, { type: 'script', script_id: 'two' })

  assert.deepEqual(store.getVariables({ type: 'script', script_id: 'one' }), { n: 1 })
})

test('updateVariablesWith stores what the updater returns', () => {
  const store = memoryStore()
  store.replaceVariables({ 好感度: 5 }, { type: 'chat' })

  const result = store.updateVariablesWith(variables => ({ ...variables, 好感度: 10 }), { type: 'chat' })

  assert.deepEqual(result, { 好感度: 10 })
  assert.deepEqual(store.getVariables({ type: 'chat' }), { 好感度: 10 })
})

test('insertOrAssign lets the incoming value win; insertVariables lets the existing one win', () => {
  const store = memoryStore()
  store.replaceVariables({ 好感度: 5 }, { type: 'chat' })

  store.insertVariables({ 好感度: 99, 体力: 100 }, { type: 'chat' })
  assert.deepEqual(store.getVariables({ type: 'chat' }), { 好感度: 5, 体力: 100 })

  store.insertOrAssignVariables({ 好感度: 20 }, { type: 'chat' })
  assert.deepEqual(store.getVariables({ type: 'chat' }), { 好感度: 20, 体力: 100 })
})

test('deleteVariable reports whether anything was there', () => {
  const store = memoryStore()
  store.replaceVariables({ 络络: { 好感度: 5 } }, { type: 'chat' })

  assert.equal(store.deleteVariable('络络.好感度', { type: 'chat' }).delete_occurred, true)
  assert.equal(store.deleteVariable('络络.好感度', { type: 'chat' }).delete_occurred, false)
})

test('getAllVariables merges with the nearest scope winning', () => {
  const store = memoryStore()
  store.replaceVariables({ who: 'global', g: 1 }, { type: 'global' })
  store.replaceVariables({ who: 'character', c: 1 }, { type: 'character' })
  store.replaceVariables({ who: 'chat', h: 1 }, { type: 'chat' })

  assert.deepEqual(store.getAllVariables(), { who: 'chat', g: 1, c: 1, h: 1 })
})

/** A log with one turn and two candidates. */
function chatWithSwipes() {
  const session = Session.create(SessionId(`vars-${Math.random().toString(36).slice(2)}`))
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'Hello?' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  const reply = (text: string) => createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  appendCandidate(session, { turn: 0, step: 0, message: reply('B') })
  return session
}

test('message variables are per candidate, so a swipe does not inherit state', () => {
  // The whole reason this scope exists: regenerating must not carry the
  // previous reply's consequences forward.
  const session = chatWithSwipes()
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ 好感度: 20 }, { type: 'message' })
  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 20 })

  selectCandidate(session, 0, 0)
  assert.deepEqual(store.getVariables({ type: 'message' }), {}, 'the other candidate has its own state')

  store.replaceVariables({ 好感度: 5 }, { type: 'message' })
  selectCandidate(session, 0, 1)
  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 20 }, 'swiping back restores its own state')
})

test('message writes append to the log rather than overwriting', () => {
  const session = chatWithSwipes()
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ n: 1 }, { type: 'message' })
  store.replaceVariables({ n: 2 }, { type: 'message' })

  assert.equal(session.events.filter(event => event.type === 'iris/variables').length, 2)
  assert.deepEqual(store.getVariables({ type: 'message' }), { n: 2 }, 'the last write is what reads back')
})

test("'latest' and -1 address the same turn", () => {
  const session = chatWithSwipes()
  const store = new VariableStore({ message: sessionMessageBackend(session) })
  store.replaceVariables({ n: 7 }, { type: 'message', message_id: 'latest' })

  assert.deepEqual(store.getVariables({ type: 'message', message_id: -1 }), { n: 7 })
})

test('a turn with no reply cannot hold variables', () => {
  const session = Session.create(SessionId('vars-empty'))
  session.append('turn/start', { turn: 0 })
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  assert.throws(() => store.getVariables({ type: 'message' }), VariableScopeError)
})
