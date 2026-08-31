import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAssistantMessage, createUserMessage, type AssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { appendCandidate, listCandidates, selectCandidate, selectedCandidate, SwipeError } from '../src/index.ts'

const PROVENANCE = { provider: 'test', model: 'test-model' } as const

/** A fresh log with one user message already on the surface. */
function chatWithPrompt(text = 'Hello?'): Session {
  const session = Session.create(SessionId(`test-${Math.random().toString(36).slice(2)}`))
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  return session
}

/** An assistant message carrying one line of text. */
function reply(text: string): AssistantMessage {
  return createAssistantMessage({ content: [{ type: 'text', text }], source: PROVENANCE })
}

/** The text of every message the model would currently see. */
function modelView(session: Session): string[] {
  return session.deriveMessages().map(message =>
    message.content.map(block => (block.type === 'text' ? block.text : `<${block.type}>`)).join(''))
}

test('the first generation extends the surface', () => {
  const session = chatWithPrompt()
  const candidate = appendCandidate(session, { turn: 0, step: 0, message: reply('A') })

  assert.equal(candidate.index, 0)
  assert.deepEqual(modelView(session), ['Hello?', 'A'])
  assert.equal(listCandidates(session, 0).length, 1)
})

test('regenerating shadows the previous candidate but keeps it in the log', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  appendCandidate(session, { turn: 0, step: 0, message: reply('B') })

  // The model sees exactly one reply...
  assert.deepEqual(modelView(session), ['Hello?', 'B'])
  // ...while both generations remain available as swipes.
  assert.deepEqual(listCandidates(session, 0).map(candidate => candidate.index), [0, 1])
  assert.equal(selectedCandidate(session, 0)?.index, 1)
  assert.equal(session.events.filter(event => event.type === 'assistant/message').length, 2)
})

test('selecting an earlier candidate puts it back in front of the model', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  appendCandidate(session, { turn: 0, step: 0, message: reply('B') })

  const chosen = selectCandidate(session, 0, 0)

  assert.equal(chosen.index, 0)
  assert.deepEqual(modelView(session), ['Hello?', 'A'])
  assert.equal(selectedCandidate(session, 0)?.index, 0)
})

test('a re-selection does not become a new swipe', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  appendCandidate(session, { turn: 0, step: 0, message: reply('B') })
  selectCandidate(session, 0, 0)
  selectCandidate(session, 0, 1)
  selectCandidate(session, 0, 0)

  // Three materializations happened, but the swipe list is still A and B.
  assert.deepEqual(
    listCandidates(session, 0).map(candidate =>
      candidate.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')),
    ['A', 'B'],
  )
  assert.deepEqual(modelView(session), ['Hello?', 'A'])
})

test('selecting the already-current candidate appends nothing', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  const before = session.seq

  selectCandidate(session, 0, 0)

  assert.equal(session.seq, before)
})

test('a candidate index outside the swipe list is refused', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })

  assert.throws(() => selectCandidate(session, 0, 3), SwipeError)
})

test('swipes of a turn that already has a successor are settled', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  appendCandidate(session, { turn: 0, step: 0, message: reply('B') })
  session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

  // A second exchange lands on top of the first.
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'And then?' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  appendCandidate(session, { turn: 1, step: 0, message: reply('C') })

  assert.throws(() => selectCandidate(session, 0, 0), SwipeError)
  // The newest turn is still swipeable.
  appendCandidate(session, { turn: 1, step: 0, message: reply('D') })
  assert.equal(selectCandidate(session, 1, 0).index, 0)
  assert.deepEqual(modelView(session), ['Hello?', 'B', 'And then?', 'C'])
})

test('candidates are tracked per turn', () => {
  const session = chatWithPrompt()
  appendCandidate(session, { turn: 0, step: 0, message: reply('A') })
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: 'More' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  appendCandidate(session, { turn: 1, step: 0, message: reply('B') })
  appendCandidate(session, { turn: 1, step: 0, message: reply('C') })

  assert.equal(listCandidates(session, 0).length, 1)
  assert.equal(listCandidates(session, 1).length, 2)
})
