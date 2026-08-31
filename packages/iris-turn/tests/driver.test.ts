import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { listCandidates } from '@iris/chat'
import type { Contribution } from '@iris/pipeline'

import { historyFromSession, TurnDriver, TurnError } from '../src/index.ts'

/** A stream that emits `text` and completes, recording the request it saw. */
function scriptedStream(replies: string[]) {
  const seen: GenerateOptions[] = []
  let call = 0
  const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    const text = replies[Math.min(call, replies.length - 1)] as string
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return { stream, seen }
}

/** A stream that fails the way a provider does — with a terminal finish, not a throw. */
async function* failingStream(): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream refused', code: 'TRANSPORT' } } }
}

const CONTRIBUTIONS: Contribution[] = [
  { id: 'persona', placement: { kind: 'system', order: 0 }, text: 'You are Aria.' },
  { id: 'jailbreak', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'Stay in character.' },
]

/** A driver over a fresh log. */
function harness(replies: string[]) {
  const scripted = scriptedStream(replies)
  const driver = new TurnDriver({
    stream: scripted.stream,
    provider: 'test',
    model: 'test-model',
    contributions: () => CONTRIBUTIONS,
    history: session => historyFromSession(session),
    budget: { context: 10_000, reserve: 0, count: text => text.length },
  })
  return { driver, session: Session.create(SessionId(`turn-${Math.random().toString(36).slice(2)}`)), seen: scripted.seen }
}

/** Text of a candidate. */
function textOf(candidate: { message: { content: readonly { type: string, text?: string }[] } }): string {
  return candidate.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

test('send opens a turn, streams a reply and records it', async () => {
  const { driver, session } = harness(['Hello, traveller.'])

  const candidate = await driver.send(session, 'Hello?')

  assert.equal(textOf(candidate), 'Hello, traveller.')
  assert.equal(listCandidates(session, 0).length, 1)
  assert.equal(session.events.some(event => event.type === 'turn/end'), true)
})

test('the assembled request carries the system prompt and the depth injection', async () => {
  const { driver, session, seen } = harness(['ok'])
  await driver.send(session, 'Hello?')

  const request = seen[0]
  assert.equal(request?.system, 'You are Aria.')
  const texts = request?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'Stay in character.'], 'the post-history instruction is last')
})

test('raw chunks are logged for replay', async () => {
  const { driver, session } = harness(['Hi.'])
  await driver.send(session, 'Hello?')

  assert.equal(session.events.filter(event => event.type === 'assistant/chunk').length, 4)
})

test('streaming callbacks see the deltas as they arrive', async () => {
  const { driver, session } = harness(['Hello, traveller.'])
  let streamed = ''

  await driver.send(session, 'Hello?', { onText: delta => { streamed += delta } })

  assert.equal(streamed, 'Hello, traveller.')
})

test('regenerating adds a candidate to the same turn, not a new turn', async () => {
  const { driver, session } = harness(['First.', 'Second.'])
  await driver.send(session, 'Hello?')

  const second = await driver.regenerate(session)

  assert.equal(textOf(second), 'Second.')
  const { candidates, selected } = driver.swipes(session, 0)
  assert.equal(candidates.length, 2)
  assert.equal(selected, 1)
  assert.equal(session.events.filter(event => event.type === 'turn/start').length, 1)
})

test('swiping back changes what the next turn is built on', async () => {
  const { driver, session, seen } = harness(['First.', 'Second.', 'Third.'])
  await driver.send(session, 'Hello?')
  await driver.regenerate(session)
  driver.swipe(session, 0, 0)

  await driver.send(session, 'And then?')

  const texts = seen[2]?.messages.map(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text).join('')) ?? []
  assert.deepEqual(texts, ['Hello?', 'First.', 'And then?', 'Stay in character.'])
})

test('a failed generation keeps the user message so the turn can be retried', async () => {
  const driver = new TurnDriver({
    stream: failingStream,
    provider: 'test',
    model: 'test-model',
    contributions: () => CONTRIBUTIONS,
    history: session => historyFromSession(session),
    budget: { context: 10_000, reserve: 0, count: text => text.length },
  })
  const session = Session.create(SessionId('turn-failure'))

  await assert.rejects(() => driver.send(session, 'Hello?'), TurnError)

  assert.equal(session.events.some(event => event.type === 'user/message'), true)
  assert.equal(session.events.some(event => event.type === 'turn/end'), false, 'the turn stays open for a retry')
})

test('regenerating an empty log is refused', async () => {
  const { driver, session } = harness(['x'])

  await assert.rejects(() => driver.regenerate(session), TurnError)
})

test('history pins the opening message against trimming', async () => {
  const { driver, session } = harness(['Hi.'])
  await driver.send(session, 'Hello?')

  assert.equal(historyFromSession(session)[0]?.pinned, true)
})
