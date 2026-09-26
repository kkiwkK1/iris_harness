import assert from 'node:assert/strict'
import { test } from 'node:test'

import { testClient } from './helpers.ts'

/**
 * `chat.variablesDiff` on the fake, which the compare mode is developed
 * against: the seeded lamplighter floors carry per-reading tables, a branch
 * copies them, and the host's missing-side answers are the fake's too.
 */

test('the seeded floors differ the way the seed says, and a named reading is read', async () => {
  const client = testClient()
  const chatId = 'chat-lamplighter'
  const { diff } = await client.call('chat.variablesDiff', { a: { chatId, floor: 0 }, b: { chatId, floor: 4 } })
  assert.deepEqual(diff.entries.map(entry => [entry.path.join('/'), entry.kind]), [
    ['stat_data/好感度', 'changed'],
    ['stat_data/物品/0', 'changed'],
    ['stat_data/物品/1', 'added'],
    ['stat_data/线索', 'added'],
  ])
  const swiped = await client.call('chat.variablesDiff', { a: { chatId, floor: 2 }, b: { chatId, floor: 2, swipe: 1 } })
  assert.equal(swiped.diff.b.swipe, 1)
  assert.equal(swiped.diff.summary.changed, 2)
  client.dispose()
})

test('a branch compares against its parent, and missing sides are told apart', async () => {
  const client = testClient()
  const chatId = 'chat-lamplighter'
  const branch = (await client.call('chat.branch', { chatId, id: 2, swipeId: 1 })).view.chatId
  const { diff } = await client.call('chat.variablesDiff', { a: { chatId, floor: 2 }, b: { chatId: branch, floor: 2 } })
  // The branch took the other reading of floor 2, so its selected table is swipe 1's.
  assert.equal(diff.b.swipe, 1)
  assert.equal(diff.identical, false)

  const user = await client.call('chat.variablesDiff', { a: { chatId, floor: 1 }, b: { chatId: branch, floor: 9 } })
  assert.equal(user.diff.a.missing, 'no-table')
  assert.equal(user.diff.b.missing, 'no-floor')
  await assert.rejects(() => client.call('chat.variablesDiff', { a: { chatId: 'nope', floor: 0 }, b: { chatId, floor: 0 } }))
  client.dispose()
})
