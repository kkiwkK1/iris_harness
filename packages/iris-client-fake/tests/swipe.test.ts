import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextEvent, testClient } from './helpers.ts'

/** Send once and wait for the turn to settle. */
async function settledSend(chatId: string, text: string) {
  const client = testClient()
  await client.call('chat.send', { chatId, text })
  await nextEvent(client, 'stream.end', chatId)
  return client
}

test('regenerate adds a reading instead of replacing one', async () => {
  const client = await settledSend('chat-survey', 'Again, differently.')
  const before = (await client.call('chat.open', { chatId: 'chat-survey' })).view.messages.at(-1)
  assert.equal(before?.swipes?.count, 1)
  const first = before?.text

  await client.call('chat.regenerate', { chatId: 'chat-survey' })
  const end = await nextEvent(client, 'stream.end', 'chat-survey')

  const after = end.view.messages.at(-1)
  assert.equal(after?.swipes?.count, 2)
  // The new reading is selected, and the old one is still there to go back to.
  assert.equal(after?.swipes?.index, 1)
  assert.notEqual(after?.text, first)

  const back = await client.call('chat.swipe', {
    chatId: 'chat-survey',
    turn: after?.turn ?? 0,
    index: 0,
  })
  assert.equal(back.view.messages.at(-1)?.text, first)

  client.dispose()
})

test('swipe addresses a turn, not a message index', async () => {
  const client = await settledSend('chat-lamplighter', '继续。')
  const view = (await client.call('chat.open', { chatId: 'chat-lamplighter' })).view
  const last = view.messages.at(-1)
  assert.ok(last !== undefined)
  const turn = last.turn
  assert.ok(turn !== undefined)

  await client.call('chat.regenerate', { chatId: 'chat-lamplighter' })
  await nextEvent(client, 'stream.end', 'chat-lamplighter')

  // Delete an earlier message so every index shifts, then swipe by turn. If the
  // fake addressed by index this would land on the wrong message or throw.
  await client.call('chat.deleteMessage', { chatId: 'chat-lamplighter', id: 0 })
  const swiped = await client.call('chat.swipe', { chatId: 'chat-lamplighter', turn, index: 0 })

  const target = swiped.view.messages.find(message => message.turn === turn && message.role === 'assistant')
  assert.equal(target?.swipes?.index, 0)

  client.dispose()
})

test('swiping past the last reading is refused', async () => {
  const client = await settledSend('chat-survey', 'Once.')
  const turn = (await client.call('chat.open', { chatId: 'chat-survey' })).view.messages.at(-1)?.turn ?? 0

  await assert.rejects(
    () => client.call('chat.swipe', { chatId: 'chat-survey', turn, index: 7 }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )

  client.dispose()
})

test('regenerating an empty chat is refused rather than inventing a turn', async () => {
  const client = testClient()
  const created = await client.call('chat.create', { characterId: 'aria-vance' })

  await assert.rejects(
    () => client.call('chat.regenerate', { chatId: created.view.chatId }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )

  client.dispose()
})

test('editing a message leaves the other readings alone', async () => {
  const client = await settledSend('chat-survey', 'Draft it.')
  await client.call('chat.regenerate', { chatId: 'chat-survey' })
  const end = await nextEvent(client, 'stream.end', 'chat-survey')

  const last = end.view.messages.at(-1)
  assert.ok(last !== undefined)
  const turn = last.turn ?? 0
  const original = last.text

  await client.call('chat.editMessage', { chatId: 'chat-survey', id: last.id, text: 'Rewritten by hand.' })
  const edited = await client.call('chat.open', { chatId: 'chat-survey' })
  assert.equal(edited.view.messages.at(-1)?.text, 'Rewritten by hand.')

  const other = await client.call('chat.swipe', { chatId: 'chat-survey', turn, index: 0 })
  assert.notEqual(other.view.messages.at(-1)?.text, 'Rewritten by hand.')

  const backToEdited = await client.call('chat.swipe', { chatId: 'chat-survey', turn, index: 1 })
  assert.equal(backToEdited.view.messages.at(-1)?.text, 'Rewritten by hand.')
  assert.notEqual(original, 'Rewritten by hand.')

  client.dispose()
})
