/**
 * A reply's reasoning survives the chat file, in the field SillyTavern keeps it
 * in: `extra.reasoning` (`public/scripts/reasoning.js:415`), per swipe in
 * `swipe_info[i].extra.reasoning`.
 *
 * The case that found this is a reply that is **all** reasoning. In the owner's
 * 黑兽 chats three generations came back from DeepSeek with every completion
 * token billed as reasoning (`reasoningTokens === outputTokens`, 4086 of 4086
 * on the newest) and no `content` at all. Iris kept the trace only on the
 * in-memory candidate, so the file said `mes: ""` and nothing else, and the
 * reply was gone after a reload or any rebuild of the log. The trace below is a
 * redacted stand-in with the real one's shape: the card's planning block, then
 * the prose the model meant as the body, all inside the reasoning.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { appendCandidate, selectCandidate, selectedCandidate } from '@iris/chat'

import {
  exportMessages,
  formatChatFile,
  importChat,
  parseChatFile,
  REASONING_FIELD,
  REASONING_TYPE_FIELD,
  withOriginalKeyOrder,
  type SillyTavernChatHeader,
  type SillyTavernMessage,
} from '../src/index.ts'

const HEADER: SillyTavernChatHeader = {
  user_name: 'User', character_name: '黑兽', create_date: '2026-09-25 @23h59m27s', chat_metadata: {},
}

/** Redacted: the planning block the card asks for, then the body, both inside reasoning. */
const ALL_REASONING = 'Master，小此已经切换到日本語进行思考啦！\n'
  + '<konatan_planning~>\n- 当前什么情况?\n * 时间？夜。\n</konatan_planning~>\n\n'
  + '横杆搁在槽里，门没栓。灯芯压到只剩一粒。'

/** The file as the host writes it: the export with each line's keys in the file's order. */
function fileOf(session: Session): string {
  return formatChatFile({ header: HEADER, messages: exportMessages(session, HEADER).map(withOriginalKeyOrder) })
}

/** One live turn: the user's line, then a reply made of the given blocks. */
function liveTurn(session: Session, turn: number, content: { type: 'text' | 'reasoning', text: string }[][]): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  for (const blocks of content) {
    appendCandidate(session, {
      turn,
      step: 0,
      message: createAssistantMessage({ content: blocks, source: { provider: 'p', model: 'deepseek' } }),
    })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The selected reply of a turn, as reasoning and text. */
function readingOf(session: Session, turn: number): { reasoning: string, text: string } {
  const current = selectedCandidate(session, turn)
  assert.ok(current !== undefined, `turn ${String(turn)} has a reply`)
  const join = (kind: string): string =>
    current.message.content.filter(block => block.type === kind).map(block => ('text' in block ? block.text : '')).join('')
  return { reasoning: join('reasoning'), text: join('text') }
}

test('a reply that is all reasoning keeps its trace in extra.reasoning, and comes back after a reload', () => {
  const session = Session.create(SessionId('all-reasoning'))
  liveTurn(session, 0, [[{ type: 'reasoning', text: ALL_REASONING }]])

  const [, reply] = exportMessages(session, HEADER)
  assert.ok(reply !== undefined)
  assert.equal(reply.mes, '', 'the model sent no body, and none is invented')
  assert.equal(reply.extra?.[REASONING_FIELD], ALL_REASONING, 'the trace is in the file, where upstream keeps it')
  assert.equal(reply.extra?.[REASONING_TYPE_FIELD], 'model', "upstream's ReasoningType.Model")

  const reloaded = importChat(parseChatFile(fileOf(session)), 'all-reasoning')
  assert.deepEqual(readingOf(reloaded, 0), { reasoning: ALL_REASONING, text: '' })
})

test('reasoning beside a body round-trips, and a reply without reasoning gains no extra', () => {
  const session = Session.create(SessionId('with-body'))
  liveTurn(session, 0, [[{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'body' }]])
  liveTurn(session, 1, [[{ type: 'text', text: 'plain' }]])

  const lines = exportMessages(session, HEADER)
  assert.equal(lines[3]?.extra, undefined, 'no reasoning, no extra object')

  const reloaded = importChat(parseChatFile(fileOf(session)), 'with-body')
  assert.deepEqual(readingOf(reloaded, 0), { reasoning: 'think', text: 'body' })
  assert.deepEqual(readingOf(reloaded, 1), { reasoning: '', text: 'plain' })
  // A second save of the reloaded log changes nothing.
  assert.equal(fileOf(reloaded), fileOf(importChat(parseChatFile(fileOf(reloaded)), 'again')))
})

/** A SillyTavern line with two swipes, each with its own trace, the second selected. */
const ST_FILE = [
  JSON.stringify(HEADER),
  '{"name":"User","is_user":true,"mes":"hi","send_date":"2026-09-25 @23h59m28s"}',
  '{"name":"黑兽","is_user":false,"send_date":"x","mes":"B.","extra":{"reasoning":"why B","reasoning_duration":1200,"reasoning_type":"model","token_count":3},"swipes":["A.","B."],"swipe_id":1,'
  + '"swipe_info":[{"send_date":"x","extra":{"reasoning":"why A","reasoning_type":"model"}},{"send_date":"x","extra":{"reasoning":"why B","reasoning_type":"model"}}]}',
].join('\n') + '\n'

test("a SillyTavern file's reasoning is read per swipe, and the untouched file exports byte for byte", () => {
  const session = importChat(parseChatFile(ST_FILE), 'st')
  assert.deepEqual(readingOf(session, 0), { reasoning: 'why B', text: 'B.' })
  selectCandidate(session, 0, 0)
  assert.deepEqual(readingOf(session, 0), { reasoning: 'why A', text: 'A.' }, 'the other swipe reads swipe_info')

  assert.equal(fileOf(importChat(parseChatFile(ST_FILE), 'st2')), ST_FILE)
})

test("a line whose selected swipe has no trace does not keep another swipe's", () => {
  const file = [
    JSON.stringify(HEADER),
    '{"name":"User","is_user":true,"mes":"hi"}',
    '{"name":"黑兽","is_user":false,"mes":"A.","extra":{"reasoning":"why A","reasoning_type":"model","token_count":3},"swipes":["A.","B."],"swipe_id":0}',
  ].join('\n') + '\n'
  const session = importChat(parseChatFile(file), 'stale')
  selectCandidate(session, 0, 1)
  const line = exportMessages(session, HEADER)[1] as SillyTavernMessage
  assert.equal(line.mes, 'B.')
  assert.deepEqual(line.extra, { token_count: 3 }, 'the trace of swipe A is not read back onto swipe B')
})
