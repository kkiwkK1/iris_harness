import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listCandidates, selectedCandidate } from '@iris/chat'

import { exportChatFile, importChat, parseChatFile, type SillyTavernChat } from '../src/index.ts'

/** A chat file as SillyTavern writes one, including fields Iris does not model. */
const FIXTURE: SillyTavernChat = {
  header: {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-08-31 @00h00m00s',
    chat_metadata: { note_prompt: '', tainted: false },
  },
  messages: [
    {
      name: 'Traveller',
      is_user: true,
      is_system: false,
      send_date: '2026-08-31 @00h01m00s',
      mes: 'Hello there.',
      extra: {},
    },
    {
      name: 'Aria',
      is_user: false,
      is_system: false,
      send_date: '2026-08-31 @00h01m05s',
      mes: 'Candidate B.',
      extra: { token_count: 12, reasoning: 'weighed it' },
      swipes: ['Candidate A.', 'Candidate B.', 'Candidate C.'],
      swipe_id: 1,
      gen_started: '2026-08-31T00:01:01.000Z',
    },
  ],
}

/** Import the fixture into a fresh log. */
function imported() {
  return importChat(FIXTURE, 'st-import-test')
}

test('a chat file parses into a header plus messages', () => {
  const text = exportChatFile(imported(), FIXTURE.header)
  const parsed = parseChatFile(text)

  assert.equal(parsed.header.character_name, 'Aria')
  assert.equal(parsed.messages.length, 2)
})

test('swipes come back as real candidates, not a flattened reply', () => {
  const session = imported()
  const candidates = listCandidates(session, 0)

  assert.equal(candidates.length, 3)
  assert.equal(selectedCandidate(session, 0)?.index, 1, 'swipe_id selects the current candidate')
})

test('the selected swipe is what the model would see', () => {
  const session = imported()
  const view = session.deriveMessages().map(message =>
    message.content.map(block => (block.type === 'text' ? block.text : '')).join(''))

  assert.deepEqual(view, ['Hello there.', 'Candidate B.'])
})

test('a chat file round-trips without losing unmodelled fields', () => {
  const text = exportChatFile(imported(), FIXTURE.header)
  const parsed = parseChatFile(text)

  const reply = parsed.messages[1]
  assert.equal(reply?.mes, 'Candidate B.')
  assert.equal(reply?.swipe_id, 1)
  assert.deepEqual(reply?.swipes, ['Candidate A.', 'Candidate B.', 'Candidate C.'])
  // The compatibility promise: another extension's payload survives the trip.
  assert.deepEqual(reply?.extra, { token_count: 12, reasoning: 'weighed it' })
  assert.equal(reply?.gen_started, '2026-08-31T00:01:01.000Z')
  assert.equal(parsed.messages[0]?.send_date, '2026-08-31 @00h01m00s')
})

test('a second round trip is stable', () => {
  const once = exportChatFile(imported(), FIXTURE.header)
  const twice = exportChatFile(importChat(parseChatFile(once), 'again'), FIXTURE.header)

  assert.equal(twice, once)
})

test('a reply with no swipes still exports a one-entry swipe list', () => {
  const chat: SillyTavernChat = {
    header: FIXTURE.header,
    messages: [
      { name: 'Traveller', is_user: true, mes: 'Hi.' },
      { name: 'Aria', is_user: false, mes: 'Only one.' },
    ],
  }
  const parsed = parseChatFile(exportChatFile(importChat(chat, 'single'), chat.header))

  assert.deepEqual(parsed.messages[1]?.swipes, ['Only one.'])
  assert.equal(parsed.messages[1]?.swipe_id, 0)
})

test('an empty file is refused rather than producing an empty chat', () => {
  assert.throws(() => parseChatFile('   \n'), /empty/)
})
