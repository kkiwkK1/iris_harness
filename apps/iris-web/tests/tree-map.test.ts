/**
 * The tree map's layout and the floor badge's list, asserted.
 *
 * One lineage exercises every shape at once: a root, an ordinary branch, a
 * branch of that branch, a swipe turned into a branch (whose lane starts AT
 * its fork floor), and a fresh branch with no floor of its own yet.
 *
 * @module iris-web/tests/tree-map
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatTreeNode, ChatTreeView } from '@iris/protocol'

import { branchesAt, layoutTree, type TreeRow } from '../src/app/tree-map.ts'

function node(chatId: string, floorCount: number, more: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return {
    chatId,
    title: chatId.toUpperCase(),
    updatedAt: 0,
    depth: more.parentChatId === undefined ? 0 : 1,
    floorCount,
    swipes: Array.from({ length: floorCount }, () => 1),
    ...more,
  }
}

/** R ── A(2) ── B(4 of A); R ── S (swipe at 4); R ── F (fresh, cut at 5). */
const TREE: ChatTreeView = {
  rootChatId: 'r',
  chats: [
    node('r', 7, { swipes: [1, 1, 1, 1, 2, 1, 1] }),
    node('a', 6, { parentChatId: 'r', fork: { floor: 2, shared: 3, source: 'recorded' } }),
    node('b', 6, { parentChatId: 'a', depth: 2, fork: { floor: 4, shared: 5, source: 'recorded' } }),
    node('s', 5, { parentChatId: 'r', fork: { floor: 4, shared: 4, source: 'recorded' } }),
    node('f', 6, { parentChatId: 'r', fork: { floor: 5, shared: 6, source: 'recorded' } }),
  ],
  current: { chatId: 'b', floor: 5 },
}

/** A compact picture of the rows, for readable assertions. */
function picture(rows: TreeRow[]): string[] {
  return rows.map(row => row.kind === 'gap'
    ? `gap ${String(row.from)}-${String(row.to)} ×${String(row.count)} [${row.lanes.map(lane => lane.chatId).join(',')}]`
    : `${String(row.floor)}: ${row.nodes.map(cell => `${cell.chatId}${cell.forks > 0 ? `⑂${String(cell.forks)}` : ''}${cell.head ? '^' : ''}${cell.focus ? '*' : ''}`).join(' ')}`)
}

test('one lane per conversation, each starting where it stops sharing its parent', () => {
  const { lanes } = layoutTree(TREE)
  const by = new Map(lanes.map(lane => [lane.chatId, lane]))
  assert.deepEqual(lanes.map(lane => lane.lane), [0, 1, 2, 3, 4])
  assert.deepEqual([by.get('r')?.start, by.get('r')?.end], [0, 6])
  assert.deepEqual([by.get('a')?.start, by.get('a')?.from, by.get('a')?.parentLane], [3, 2, 0])
  assert.deepEqual([by.get('b')?.start, by.get('b')?.from, by.get('b')?.parentLane], [5, 4, 1])
  // The swipe branch owns floor 4 itself, so its connector leaves floor 3.
  assert.deepEqual([by.get('s')?.start, by.get('s')?.from], [4, 3])
  // A fresh branch still gets one dot, level with the floor it was cut at.
  assert.deepEqual([by.get('f')?.start, by.get('f')?.end, by.get('f')?.from], [5, 5, 5])
})

test('linear runs collapse; forks, heads and the focus get their own rows', () => {
  assert.deepEqual(picture(layoutTree(TREE).rows), [
    '0: r',
    'gap 1-1 ×1 [r]',
    '2: r⑂1',
    '3: r a',
    '4: r⑂1 a⑂1 s^',
    '5: r⑂1 a^ b^* f^',
    '6: r^',
  ])
})

test('a long straight conversation is three rows, not a hundred', () => {
  const long: ChatTreeView = { rootChatId: 'x', chats: [node('x', 120)], current: { chatId: 'x', floor: 119 } }
  assert.deepEqual(picture(layoutTree(long).rows), ['0: x', 'gap 1-118 ×118 [x]', '119: x^*'])
})

test('the focus can sit on a shared floor, drawn on the ancestor lane that owns it', () => {
  const rows = layoutTree(TREE, { chatId: 'b', floor: 1 }).rows
  assert.deepEqual(picture(rows).slice(0, 3), ['0: r', '1: r*', '2: r⑂1'])
})

test('the on-screen history is marked lane by lane up to the root', () => {
  const by = new Map(layoutTree(TREE).lanes.map(lane => [lane.chatId, lane]))
  assert.equal(by.get('b')?.pathEnd, 5)
  assert.equal(by.get('a')?.pathEnd, 4)
  assert.equal(by.get('r')?.pathEnd, 2)
  assert.equal(by.get('s')?.pathEnd, undefined)
  assert.equal(by.get('b')?.current, true)
})

test('swipes are a count on the node, never lanes', () => {
  const floor4 = layoutTree(TREE).rows.find(row => row.kind === 'floor' && row.floor === 4)
  assert.ok(floor4?.kind === 'floor')
  assert.equal(floor4.nodes.find(cell => cell.chatId === 'r')?.swipes, 2)
  assert.equal(layoutTree(TREE).lanes.length, TREE.chats.length)
})

test('the floor badge lists every other road from that floor', () => {
  // From the root's floor 4, the swipe branch leaves.
  assert.deepEqual(branchesAt(TREE, 'r', 4).map(link => [link.chatId, link.relation]), [['s', 'child']])
  // From b's floor 4 — the floor b was cut at — going on in a is the other road.
  assert.deepEqual(branchesAt(TREE, 'b', 4).map(link => [link.chatId, link.relation]), [['a', 'parent']])
  // From b's floor 2, which b holds only because a copied it from r.
  assert.deepEqual(branchesAt(TREE, 'b', 2).map(link => [link.chatId, link.relation]), [['r', 'parent']])
  // A floor nothing leaves from.
  assert.deepEqual(branchesAt(TREE, 'b', 3), [])
  // Siblings cut at the same floor list each other, after the parent.
  const withSibling: ChatTreeView = {
    ...TREE,
    chats: [...TREE.chats, node('a2', 4, { parentChatId: 'r', fork: { floor: 2, shared: 3, source: 'prefix' } })],
  }
  assert.deepEqual(branchesAt(withSibling, 'a', 2).map(link => [link.chatId, link.relation]), [['r', 'parent'], ['a2', 'sibling']])
  assert.deepEqual(branchesAt(undefined, 'a', 2), [])
})

test('a branch cut at a floor its parent only copied leaves from the lane that draws that floor', () => {
  // The acceptance run's shape: a fresh branch A (cut at 2, nothing of its
  // own), and B cut from A at floor 1 — a floor A holds only because r wrote it.
  const tree: ChatTreeView = {
    rootChatId: 'r',
    chats: [
      node('r', 31),
      node('a', 3, { parentChatId: 'r', fork: { floor: 2, shared: 3, source: 'recorded' } }),
      node('b', 2, { parentChatId: 'a', depth: 2, fork: { floor: 1, shared: 2, source: 'recorded' } }),
    ],
    current: { chatId: 'b', floor: 1 },
  }
  const layout = layoutTree(tree)
  const by = new Map(layout.lanes.map(lane => [lane.chatId, lane]))
  assert.equal(by.get('b')?.parentLane, 0, 'from r’s lane, not from a’s, which does not reach floor 1')
  assert.equal(by.get('b')?.from, 1)
  // The badge for b sits on r's floor 1, where the reader can see it.
  const floor1 = layout.rows.find(row => row.kind === 'floor' && row.floor === 1)
  assert.ok(floor1?.kind === 'floor')
  assert.equal(floor1.nodes.find(cell => cell.chatId === 'r')?.forks, 1)
  // The reader's history: b's own dot, then r up to floor 0 — a is not on it.
  assert.equal(by.get('b')?.pathEnd, 1)
  assert.equal(by.get('a')?.pathEnd, undefined)
  assert.equal(by.get('r')?.pathEnd, 0)
})
