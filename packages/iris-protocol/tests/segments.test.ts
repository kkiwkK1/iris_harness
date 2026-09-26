import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ownerOfFloor, segmentAt, segmentsOf } from '../src/segments.ts'
import type { ChatTreeNode } from '../src/views.ts'

/**
 * Where branch segments begin and end, over `chat.tree` graphs.
 *
 * The cases are the four the owner's request names — a root alone, one fork,
 * nested forks, a swipe turned into a branch — plus the two shapes where the
 * nearest wrong rule disagrees: a grandchild cut from floors its parent had
 * only copied (the cut belongs on the root's lane, not the parent's), and a
 * branch that wrote nothing (it cuts, and owns nothing).
 */

/** A node with only what the segment rule reads. */
function node(chatId: string, floorCount: number, fork?: { parent: string, floor: number, shared: number }): ChatTreeNode {
  return {
    chatId,
    title: chatId,
    updatedAt: 0,
    depth: 0,
    floorCount,
    swipes: Array.from({ length: floorCount }, () => 1),
    ...fork === undefined
      ? {}
      : { parentChatId: fork.parent, fork: { floor: fork.floor, shared: fork.shared, source: 'recorded' as const } },
  }
}

test('a root alone is one segment, floor 0 to its newest', () => {
  assert.deepEqual(segmentsOf({ chats: [node('root', 12)] }), [{ chatId: 'root', from: 0, to: 11 }])
})

test('an empty conversation has no segment', () => {
  assert.deepEqual(segmentsOf({ chats: [node('root', 0)] }), [])
})

test('one fork: the shared prefix, the root’s own tail, and the branch’s own run (黑兽’s shape)', () => {
  // A root of 33 floors (0–32) and a branch made from floor 30 that wrote two more.
  const tree = { chats: [node('root', 33), node('b', 33, { parent: 'root', floor: 30, shared: 31 })] }
  assert.deepEqual(segmentsOf(tree), [
    { chatId: 'root', from: 0, to: 30 },
    { chatId: 'root', from: 31, to: 32 },
    { chatId: 'b', from: 31, to: 32 },
  ])
  // The prefix is the root's, whichever conversation asks.
  assert.equal(ownerOfFloor(tree, 'b', 12), 'root')
  assert.equal(ownerOfFloor(tree, 'b', 31), 'b')
  assert.deepEqual(segmentAt(segmentsOf(tree), 'root', 30), { chatId: 'root', from: 0, to: 30 })
})

test('nested forks: a grandchild cut from its parent’s own floors cuts the parent', () => {
  const tree = {
    chats: [
      node('root', 20),
      node('b', 18, { parent: 'root', floor: 9, shared: 10 }),
      node('c', 16, { parent: 'b', floor: 13, shared: 14 }),
    ],
  }
  assert.deepEqual(segmentsOf(tree), [
    { chatId: 'root', from: 0, to: 9 },
    { chatId: 'root', from: 10, to: 19 },
    { chatId: 'b', from: 10, to: 13 },
    { chatId: 'b', from: 14, to: 17 },
    { chatId: 'c', from: 14, to: 15 },
  ])
})

test('nested forks: a grandchild cut from floors its parent only copied cuts the lane that owns them', () => {
  // `c` is a branch of `b`, made from floor 4 — a floor `b` copied from the
  // root. The nearest wrong rule cuts `b` (which owns nothing there) and
  // leaves the root's 0–9 whole.
  const tree = {
    chats: [
      node('root', 20),
      node('b', 18, { parent: 'root', floor: 9, shared: 10 }),
      node('c', 8, { parent: 'b', floor: 4, shared: 5 }),
    ],
  }
  assert.deepEqual(segmentsOf(tree), [
    { chatId: 'root', from: 0, to: 4 },
    { chatId: 'root', from: 5, to: 9 },
    { chatId: 'root', from: 10, to: 19 },
    { chatId: 'b', from: 10, to: 17 },
    { chatId: 'c', from: 5, to: 7 },
  ])
})

test('a swipe turned into a branch parts the lanes at the fork floor itself', () => {
  // Cut *at* floor 6 with another reading shown: `shared` is 6, so the root's
  // own reading of floor 6 starts a segment rather than ending one.
  const tree = { chats: [node('root', 9), node('s', 8, { parent: 'root', floor: 6, shared: 6 })] }
  assert.deepEqual(segmentsOf(tree), [
    { chatId: 'root', from: 0, to: 5 },
    { chatId: 'root', from: 6, to: 8 },
    { chatId: 's', from: 6, to: 7 },
  ])
})

test('a branch that wrote nothing still cuts its parent, and owns no segment', () => {
  const tree = { chats: [node('root', 10), node('e', 5, { parent: 'root', floor: 4, shared: 5 })] }
  assert.deepEqual(segmentsOf(tree), [
    { chatId: 'root', from: 0, to: 4 },
    { chatId: 'root', from: 5, to: 9 },
  ])
  assert.equal(ownerOfFloor(tree, 'e', 4), 'root')
})

test('two branches from one floor cut the parent once', () => {
  const tree = {
    chats: [
      node('root', 10),
      node('a', 8, { parent: 'root', floor: 4, shared: 5 }),
      node('b', 7, { parent: 'root', floor: 4, shared: 5 }),
    ],
  }
  assert.deepEqual(segmentsOf(tree), [
    { chatId: 'root', from: 0, to: 4 },
    { chatId: 'root', from: 5, to: 9 },
    { chatId: 'a', from: 5, to: 7 },
    { chatId: 'b', from: 5, to: 6 },
  ])
})
