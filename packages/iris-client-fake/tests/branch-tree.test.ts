import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextEvent, testClient } from './helpers.ts'

/**
 * `chat.branch` and `chat.tree` on the fake, which the tree map is developed
 * against: the host's rules for the cut, and a lineage graph whose forks the
 * fake records rather than infers.
 */

test('a branch cuts inclusively, leaves the parent alone, and opens on the chosen reading', async () => {
  const client = testClient()
  const chatId = 'chat-lamplighter'
  await client.call('chat.send', { chatId, text: 'One.' })
  await nextEvent(client, 'stream.end', chatId)
  await client.call('chat.regenerate', { chatId })
  await nextEvent(client, 'stream.end', chatId)
  const parent = (await client.call('chat.open', { chatId })).view
  const last = parent.messages.at(-1)
  assert.ok(last?.swipes !== undefined && last.swipes.count === 2)

  const { view, chats } = await client.call('chat.branch', { chatId, id: last.id, swipeId: 0 })
  assert.equal(view.messages.length, parent.messages.length)
  assert.equal(view.messages.at(-1)?.swipes?.index, 0)
  assert.match(view.title, / - Branch #1$/u)
  assert.equal(chats.find(row => row.chatId === view.chatId)?.parentChatId, chatId)
  const again = (await client.call('chat.open', { chatId })).view
  assert.equal(again.messages.at(-1)?.swipes?.index, 1, 'the parent keeps the reading it showed')

  await assert.rejects(() => client.call('chat.branch', { chatId, id: 999 }), /no message 999/u)
  client.dispose()
})

test('chat.tree draws the lineage from any member, with recorded forks', async () => {
  const client = testClient()
  const chatId = 'chat-lamplighter'
  const root = (await client.call('chat.open', { chatId })).view
  const a = (await client.call('chat.branch', { chatId, id: 0 })).view
  const b = (await client.call('chat.branch', { chatId: a.chatId, id: 0 })).view

  const { tree } = await client.call('chat.tree', { chatId: b.chatId })
  assert.equal(tree.rootChatId, chatId)
  assert.deepEqual(tree.chats.map(node => node.chatId), [chatId, a.chatId, b.chatId])
  assert.deepEqual(tree.chats.map(node => node.depth), [0, 1, 2])
  assert.deepEqual(tree.chats[1]?.fork, { floor: 0, shared: 1, source: 'recorded' })
  assert.equal(tree.chats[0]?.floorCount, root.messages.length)
  assert.deepEqual(tree.current, { chatId: b.chatId, floor: 0 })
  client.dispose()
})
