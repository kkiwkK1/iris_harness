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

test('a turn with no reply still reads what the conversation carried, and holds no write', () => {
  const session = Session.create(SessionId('vars-empty'))
  session.append('turn/start', { turn: 0 })
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  // Nothing earlier to inherit: the read answers empty, not an error.
  assert.deepEqual(store.getVariables({ type: 'message' }), {})
  // A write still has nowhere to go: there is no candidate to attach to.
  assert.throws(
    () => store.replaceVariables({ n: 1 }, { type: 'message' }),
    VariableScopeError,
  )
})

test('a user line awaiting its reply reads the state it was founded on', () => {
  // The founding-console shape: a card writes its variables onto the settled
  // reply, appends a user floor with `createChatMessages` (a new turn that has
  // no candidate yet), and every status surface keeps reading `latest`. The
  // window used to read as an error, which the STATE panel rendered as an
  // empty panel — the write had survived, but nothing could see it.
  const session = chatWithTurns(1)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'founding decree' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ 国名: '测试共和国' }, { type: 'message', message_id: 0 })

  // Both spellings of "newest" — the panel's no-id read and a card's
  // `message_id: 'latest'` — see the carried table until the reply lands.
  assert.deepEqual(store.getVariables({ type: 'message' }), { 国名: '测试共和国' })
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 'latest' }), { 国名: '测试共和国' })
  // And the appended floor by its own index reads the same, one turn on.
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { 国名: '测试共和国' })
})

/** The exact shape `recordImpersonation` lands: a closed turn with a user floor and no candidate. */
function chatWithImpersonatedFloor() {
  const session = chatWithTurns(1)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: '(as user) I pocket the key' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 0 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

test('an impersonated user floor is a floor a card can write on', () => {
  // 代我发言 lands turn/start + a user line and nothing else — no candidate. A
  // card script writing `latest` in that window used to be refused with "turn
  // N has no generated reply to attach variables to", and the scheduled
  // rejection took the whole card body down (the user 8790 report). The
  // floor is the turn's one message, so its own seq is the attach point.
  const session = chatWithImpersonatedFloor()
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ 好感度: 30 }, { type: 'message' })

  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 30 })
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 'latest' }), { 好感度: 30 })
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { 好感度: 30 })
})

test('a reply on an impersonated turn reads the floor until it writes its own', () => {
  const session = chatWithImpersonatedFloor()
  const store = new VariableStore({ message: sessionMessageBackend(session) })
  store.replaceVariables({ 好感度: 30 }, { type: 'message' })

  // The reply generates onto the same turn (a reroll or retry of the open
  // floor) and changes nothing: it reads the floor's state and writes it back,
  // so the table is not copied onto the candidate.
  appendCandidate(session, {
    turn: 1,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'a1' }],
      source: { provider: 'test', model: 'test' },
    }),
  })
  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 30 }, 'the reply reads its floor')
  assert.equal(storedTables(session), 1, 'the inherited table was not copied onto the reply')

  // The reply's own change is its own, and from then on it wins over the floor.
  store.replaceVariables({ 好感度: 40 }, { type: 'message' })
  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 40 })
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { 好感度: 40 })
})

test('a silent swipe of an impersonated turn reads the floor, never the other swipe', () => {
  // The floor's table is the turn's foundation, not one swipe's change, so it
  // must not travel between swipes the way inheritance must not: the second
  // take reads the floor's state, and swiping back to the first take finds the
  // first take's own write where it wrote one.
  const session = chatWithImpersonatedFloor()
  const store = new VariableStore({ message: sessionMessageBackend(session) })
  store.replaceVariables({ 好感度: 30 }, { type: 'message' })

  const reply = (text: string) => createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
  appendCandidate(session, { turn: 1, step: 0, message: reply('first take') })
  store.replaceVariables({ 好感度: 40 }, { type: 'message' })
  appendCandidate(session, { turn: 1, step: 0, message: reply('second take') })

  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 30 }, 'the silent take reads the floor')

  selectCandidate(session, 1, 0)
  assert.deepEqual(store.getVariables({ type: 'message' }), { 好感度: 40 }, 'the first take kept its own')
})

/** A log with `turns` settled turns, one candidate each. */
function chatWithTurns(turns: number) {
  const session = Session.create(SessionId(`vars-${Math.random().toString(36).slice(2)}`))
  for (let turn = 0; turn < turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 0 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: `q${String(turn)}` }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    appendCandidate(session, {
      turn,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `a${String(turn)}` }],
        source: { provider: 'test', model: 'test' },
      }),
    })
  }
  return session
}

/** How many variable tables the log is actually carrying. */
function storedTables(session: Session): number {
  return session.events.filter(event => event.type === 'iris/variables').length
}

test('a turn that changed nothing stores nothing and reads what the last one settled', () => {
  const session = chatWithTurns(4)
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ mood: 'calm' }, { type: 'message', message_id: 0 })
  // Turns 1–3 write the same table they already read. Upstream stores a table
  // only where its variable engine ran, and so should we.
  for (const turn of [1, 2, 3]) {
    store.replaceVariables({ mood: 'calm' }, { type: 'message', message_id: turn })
  }

  assert.equal(storedTables(session), 1, 'three redundant copies were not written')
  // And every turn still reads the state, because the read inherits it.
  for (const turn of [0, 1, 2, 3]) {
    assert.deepEqual(store.getVariables({ type: 'message', message_id: turn }), { mood: 'calm' })
  }
})

test('inheritance walks back by turn, so one swipe never inherits the other’s change', () => {
  const session = chatWithTurns(1)
  // Add a second turn with two candidates.
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const reply = (text: string) => createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'test', model: 'test' },
  })
  appendCandidate(session, { turn: 1, step: 0, message: reply('first take') })
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ score: 10 }, { type: 'message', message_id: 0 })
  store.replaceVariables({ score: 15 }, { type: 'message', message_id: 1 })

  // A second candidate for the same turn, which changes nothing.
  appendCandidate(session, { turn: 1, step: 0, message: reply('second take') })
  store.replaceVariables({ score: 10 }, { type: 'message', message_id: 1 })

  // The second take must see turn 0's settled state, not the first take's — two
  // candidates of one turn are alternatives, not a sequence.
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { score: 10 })

  selectCandidate(session, 1, 0)
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { score: 15 }, 'the first take kept its own')
})

test('a candidate’s own table always wins over what it would inherit', () => {
  const session = chatWithTurns(2)
  const store = new VariableStore({ message: sessionMessageBackend(session) })

  store.replaceVariables({ n: 1 }, { type: 'message', message_id: 0 })
  store.replaceVariables({ n: 2 }, { type: 'message', message_id: 1 })
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { n: 2 })

  // Writing back the inherited value on a candidate that already has its own is
  // a real change and must be recorded, not skipped as "same as inherited".
  store.replaceVariables({ n: 1 }, { type: 'message', message_id: 1 })
  assert.deepEqual(store.getVariables({ type: 'message', message_id: 1 }), { n: 1 })
})
