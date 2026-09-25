/**
 * The durable line id (owner ruling 6, 2026-09-25): lines Iris writes carry a
 * minted top-level `iris_id`; lines that came in from a file are left alone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendCandidate } from '@iris/chat'

import {
  exportMessages,
  formatChatFile,
  importChat,
  LINE_ID_KEY,
  lineIdOf,
  parseChatFile,
  withOriginalKeyOrder,
  type SillyTavernChatHeader,
} from '../src/index.ts'

/**
 * The file as the host writes it: the export, with each line's keys put back
 * in the order the file had them — the codec path `ChatEntry.toFile` takes.
 */
function exportChatFile(session: Session, header: SillyTavernChatHeader): string {
  return formatChatFile({ header, messages: exportMessages(session, header).map(withOriginalKeyOrder) })
}

/**
 * A SillyTavern file as text, with key orders and fields Iris does not model —
 * the byte-identical check is only worth something when the file has shapes a
 * re-serialiser could disturb.
 */
const ST_FILE = [
  '{"user_name":"Traveller","character_name":"Aria","create_date":"2026-08-31 @00h00m00s","chat_metadata":{"note_prompt":"","tainted":false}}',
  '{"name":"Aria","is_user":false,"is_system":false,"send_date":"2026-08-31 @00h00m01s","mes":"Welcome.","extra":{},"swipes":["Welcome."],"swipe_id":0}',
  '{"extra":{"bias":""},"name":"Traveller","is_user":true,"mes":"Hello there.","send_date":"2026-08-31 @00h01m00s","force_avatar":"x.png"}',
  '{"name":"Aria","is_user":false,"send_date":"2026-08-31 @00h01m05s","mes":"B.","extra":{"token_count":12},"swipes":["A.","B."],"swipe_id":1,"gen_started":"2026-08-31T00:01:01.000Z"}',
].join('\n') + '\n'

/**
 * Append one user line and its reply the way a live turn does: no
 * `iris/st-meta`, because nothing was imported.
 */
function writeTurn(session: Session, turn: number, user: string, reply: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  appendCandidate(session, {
    turn,
    step: 0,
    message: createAssistantMessage({ content: [{ type: 'text', text: reply }], source: { provider: 'p', model: 'm' } }),
  })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('an imported, untouched file exports byte for byte and gains no line id', () => {
  const chat = parseChatFile(ST_FILE)
  const out = exportChatFile(importChat(chat, 'untouched'), chat.header)
  assert.equal(out, ST_FILE)
  assert.equal(out.includes(LINE_ID_KEY), false)
})

test('lines Iris writes carry a minted id at the top level; imported ones do not', () => {
  const chat = parseChatFile(ST_FILE)
  const session = importChat(chat, 'grown')
  writeTurn(session, 2, 'And then?', 'Then this.')

  const lines = exportMessages(session, chat.header)
  assert.equal(lines.length, 5)
  // The three imported lines are untouched.
  for (const line of lines.slice(0, 3)) assert.equal(lineIdOf(line), undefined)
  const [user, reply] = [lines[3], lines[4]]
  assert.ok(user !== undefined && reply !== undefined)
  assert.match(lineIdOf(user) ?? '', /^[0-9a-f-]{36}$/u)
  assert.match(lineIdOf(reply) ?? '', /^[0-9a-f-]{36}$/u)
  assert.notEqual(lineIdOf(user), lineIdOf(reply), 'each line has its own id')
  assert.equal(typeof user[LINE_ID_KEY], 'string', 'top-level key, not inside extra')
  assert.equal(user.extra?.[LINE_ID_KEY], undefined)
})

test('the id is durable: the same log exports it again, and a reload keeps it', () => {
  const chat = parseChatFile(ST_FILE)
  const session = importChat(chat, 'durable')
  writeTurn(session, 2, 'And then?', 'Then this.')

  const first = exportChatFile(session, chat.header)
  const second = exportChatFile(session, chat.header)
  assert.equal(second, first, 'a second save of the same log writes the same ids')

  const reloaded = parseChatFile(first)
  const again = exportChatFile(importChat(reloaded, 'durable-2'), reloaded.header)
  assert.equal(again, first, 'reload → export is byte-identical, ids included')

  // And the imported prefix of that file is still the original bytes.
  assert.ok(first.startsWith(ST_FILE))
})

test('a line that already carries an id keeps it rather than being re-minted', () => {
  const withId = ST_FILE.replace('"mes":"Hello there."', '"mes":"Hello there.","iris_id":"fixed-id"')
  const chat = parseChatFile(withId)
  const lines = exportMessages(importChat(chat, 'kept'), chat.header)
  assert.equal(lineIdOf(lines[1] ?? { name: '', is_user: true, mes: '' }), 'fixed-id')
  assert.equal(exportChatFile(importChat(chat, 'kept-2'), chat.header), withId)
})
