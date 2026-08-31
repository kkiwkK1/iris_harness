import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextEvent, recorder, testClient } from './helpers.ts'
import { isEvent } from '@iris/protocol'
import { reasoningFor } from '../src/index.ts'

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
  assert.ok(settled.turn !== undefined)

  // Asking the corpus what this turn owes, instead of comparing the streamed
  // text to the settled text and calling that a pass. Those are both empty on a
  // turn that emits no reasoning, so the earlier version of this test could not
  // fail even with the whole reasoning channel disconnected.
  const owed = reasoningFor(settled.turn, 0)
  assert.ok(owed !== undefined, 'fixture drifted: this turn no longer emits reasoning')

  assert.notEqual(reasoned, '', 'nothing arrived on the reasoning channel')
  assert.equal(reasoned, owed)
  assert.equal(settled.reasoning, owed)

  off()
  client.dispose()
})

test('a turn that owes no reasoning produces no reasoning block', async () => {
  // The other branch, and the reason the assertion above cannot be "reasoning is
  // always present": a UI that only ever sees messages with a thinking block
  // never gets its no-block layout exercised.
  const client = testClient()
  let sawReasoning = false
  const off = client.subscribe(event => {
    if (isEvent(event, 'stream.reasoning')) sawReasoning = true
  })

  // Regenerate until the corpus reaches a candidate slot it withholds reasoning
  // for, rather than hard-coding which slot that is.
  await client.call('chat.send', { chatId: 'chat-survey', text: 'Again.' })
  let end = await nextEvent(client, 'stream.end', 'chat-survey')
  let last = end.view.messages.at(-1)
  assert.ok(last?.turn !== undefined)
  const turn = last.turn

  for (let candidate = 1; candidate < 6; candidate += 1) {
    if (reasoningFor(turn, candidate) !== undefined) {
      await client.call('chat.regenerate', { chatId: 'chat-survey' })
      end = await nextEvent(client, 'stream.end', 'chat-survey')
      continue
    }
    sawReasoning = false
    await client.call('chat.regenerate', { chatId: 'chat-survey' })
    end = await nextEvent(client, 'stream.end', 'chat-survey')
    last = end.view.messages.at(-1)
    assert.equal(sawReasoning, false, 'reasoning was streamed for a turn that owes none')
    assert.equal(last?.reasoning, undefined)
    off()
    client.dispose()
    return
  }

  off()
  client.dispose()
  assert.fail('no candidate slot without reasoning was reached')
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
