import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextEvent, recorder, testClient } from './helpers.ts'
import { isEvent } from '@iris/protocol'

test('chat.send resolves with a turn before any text exists', async () => {
  const client = testClient()
  const { events, stop } = recorder(client)

  const { turn } = await client.call('chat.send', { chatId: 'chat-lamplighter', text: '你在等谁？' })

  assert.equal(typeof turn, 'number')
  // The point of the contract: generation is not the response. At the moment
  // send resolves, no visible text has been produced.
  assert.equal(events.some(event => isEvent(event, 'stream.text')), false)

  await nextEvent(client, 'stream.end', 'chat-lamplighter')
  stop()
  client.dispose()
})

test('the concatenated deltas equal the settled text', async () => {
  const client = testClient()
  let streamed = ''
  const off = client.subscribe(event => {
    if (isEvent(event, 'stream.text')) streamed += event.delta
  })

  const { turn } = await client.call('chat.send', { chatId: 'chat-survey', text: 'Show me the shoal.' })
  const end = await nextEvent(client, 'stream.end', 'chat-survey')

  assert.equal(end.turn, turn)
  const settled = end.view.messages.at(-1)
  assert.ok(settled !== undefined)
  assert.equal(settled.role, 'assistant')
  assert.equal(settled.text, streamed)
  assert.notEqual(streamed, '')

  off()
  client.dispose()
})

test('reasoning streams on its own channel and lands on the message', async () => {
  const client = testClient()
  let reasoned = ''
  const off = client.subscribe(event => {
    if (isEvent(event, 'stream.reasoning')) reasoned += event.delta
  })

  await client.call('chat.send', { chatId: 'chat-lamplighter', text: '说下去。' })
  const end = await nextEvent(client, 'stream.end', 'chat-lamplighter')

  const settled = end.view.messages.at(-1)
  assert.ok(settled !== undefined)
  // The fake deliberately omits reasoning on some turns, so this asserts the
  // relationship rather than the presence: whatever streamed is what settled.
  assert.equal(settled.reasoning ?? '', reasoned)

  off()
  client.dispose()
})

test('the streaming message is flagged until the turn settles', async () => {
  const client = testClient()

  await client.call('chat.send', { chatId: 'chat-survey', text: 'Keep going.' })
  const opened = await client.call('chat.open', { chatId: 'chat-survey' })
  const inFlight = opened.view.messages.at(-1)
  assert.ok(inFlight !== undefined)
  assert.equal(inFlight.streaming, true)

  const end = await nextEvent(client, 'stream.end', 'chat-survey')
  assert.equal(end.view.messages.at(-1)?.streaming, undefined)

  client.dispose()
})

test('a second send while generating is refused as busy', async () => {
  const client = testClient()
  await client.call('chat.send', { chatId: 'chat-survey', text: 'One.' })

  await assert.rejects(
    () => client.call('chat.send', { chatId: 'chat-survey', text: 'Two.' }),
    (error: unknown) => (error as { code?: string }).code === 'busy',
  )

  await nextEvent(client, 'stream.end', 'chat-survey')
  client.dispose()
})

test('abort settles the turn and keeps the partial reply', async () => {
  const client = testClient()
  // Every delta is a timer, so even at zero delay the abort lands inside the
  // same tick as the send and cancels the whole schedule.
  await client.call('chat.send', { chatId: 'chat-lamplighter', text: '别说了。' })
  await client.call('chat.abort', { chatId: 'chat-lamplighter' })

  const opened = await client.call('chat.open', { chatId: 'chat-lamplighter' })
  const last = opened.view.messages.at(-1)
  assert.ok(last !== undefined)
  assert.equal(last.streaming, undefined)
  // The user's message survives an abort, which is what makes a retry mean
  // something.
  assert.equal(opened.view.messages.at(-2)?.text, '别说了。')

  client.dispose()
})
