/**
 * Batch rewriting of floor text, which is MVU's generation-time write.
 *
 * @module iris-client-fake/tests/set-chat-messages
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextEvent, testClient } from './helpers.ts'

/** A chat with a settled reply, which is the only thing a card rewrites. */
async function settled(chatId: string) {
  const client = testClient()
  await client.call('chat.send', { chatId, text: 'Begin.' })
  await nextEvent(client, 'stream.end', chatId)
  return client
}

test('a batch rewrites every floor it names', async () => {
  const client = await settled('chat-survey')
  const before = (await client.call('chat.open', { chatId: 'chat-survey' })).view
  assert.ok(before.messages.length >= 2)

  const { view } = await client.call('script.setChatMessages', {
    chatId: 'chat-survey',
    messages: [
      { messageId: 0, message: 'rewritten zero' },
      { messageId: 1, message: 'rewritten one' },
    ],
  })

  assert.equal(view.messages[0]?.text, 'rewritten zero')
  assert.equal(view.messages[1]?.text, 'rewritten one')
  client.dispose()
})

test('a batch naming one bad floor writes none of them', async () => {
  /*
   * The property the arm is shaped around. A card appending a status panel to
   * several floors and getting half of them is worse off than one that was
   * refused: it was told it succeeded, so its own model of the chat is now
   * wrong in a way it will not re-check.
   */
  const client = await settled('chat-survey')
  const before = (await client.call('chat.open', { chatId: 'chat-survey' })).view
  const original = before.messages[0]?.text

  await assert.rejects(
    client.call('script.setChatMessages', {
      chatId: 'chat-survey',
      messages: [
        { messageId: 0, message: 'should not survive' },
        { messageId: 9_999, message: 'no such floor' },
      ],
    }),
  )

  const after = (await client.call('chat.open', { chatId: 'chat-survey' })).view
  assert.equal(
    after.messages[0]?.text,
    original,
    'the good half of a rejected batch was written anyway',
  )
  client.dispose()
})

test('the rewrite survives a swipe away and back', async () => {
  /*
   * Upstream's own bug, and the reason the protocol insists this shares the
   * edit path: a floor’s text lives in its swipe list, so a write that lands
   * somewhere else is silently undone the next time the reader swipes back.
   */
  const client = await settled('chat-lamplighter')
  await client.call('chat.regenerate', { chatId: 'chat-lamplighter' })
  const end = await nextEvent(client, 'stream.end', 'chat-lamplighter')
  const last = end.view.messages.at(-1)
  const id = end.view.messages.length - 1
  const turn = last?.turn ?? 0
  assert.equal(last?.swipes?.count, 2)

  await client.call('script.setChatMessages', {
    chatId: 'chat-lamplighter',
    messages: [{ messageId: id, message: 'panel appended' }],
  })

  await client.call('chat.swipe', { chatId: 'chat-lamplighter', turn, index: 0 })
  const back = await client.call('chat.swipe', { chatId: 'chat-lamplighter', turn, index: 1 })
  assert.equal(
    back.view.messages.at(-1)?.text,
    'panel appended',
    'the rewrite did not land in the swipe list, so swiping undid it',
  )
  client.dispose()
})

test('refresh is accepted and changes nothing', async () => {
  /*
   * Upstream's hint about repainting its own DOM. Rejecting it would make a
   * card written against upstream fail on an argument that means nothing here.
   */
  const client = await settled('chat-survey')
  const { view } = await client.call('script.setChatMessages', {
    chatId: 'chat-survey',
    messages: [{ messageId: 0, message: 'with a hint' }],
    refresh: 'all',
  })
  assert.equal(view.messages[0]?.text, 'with a hint')
  client.dispose()
})
