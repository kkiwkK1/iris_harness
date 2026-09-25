/**
 * The tree map's lane colour, line weight and delete summary (`tree-map.ts`).
 *
 * Chosen where the nearest wrong implementation disagrees: a colour taken
 * from the lane index would change when a branch is added to its left and
 * would differ between the map and the sidebar; a raw hash would give two
 * branches of a small family the same colour; a weight read against
 * `Date.now()` would draw the same tree differently tomorrow; and a linear
 * floor scale would make a 600-floor root drown everything else.
 *
 * @module iris-web/tests/tree-lane-style
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatTreeNode, ChatTreeView } from '@iris/protocol'

import {
  deleteSummary, familyNewest, hashId, laneActivity, laneHues, layoutTree,
  LANE_HUES, TRUNK, WEIGHT_MAX, WEIGHT_MIN,
} from '../src/app/tree-map.ts'

const DAY = 86_400_000

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

/** r ── a(2) ── b(4 of a); r ── s (swipe at 4); r ── f (fresh, cut at 5). */
const TREE: ChatTreeView = {
  rootChatId: 'r',
  chats: [
    node('r', 7, { updatedAt: 10 * DAY }),
    node('a', 6, { parentChatId: 'r', fork: { floor: 2, shared: 3, source: 'recorded' }, updatedAt: 9 * DAY }),
    node('b', 6, { parentChatId: 'a', depth: 2, fork: { floor: 4, shared: 5, source: 'recorded' }, updatedAt: 30 * DAY }),
    node('s', 5, { parentChatId: 'r', fork: { floor: 4, shared: 4, source: 'recorded' }, updatedAt: 2 * DAY }),
    node('f', 6, { parentChatId: 'r', fork: { floor: 5, shared: 6, source: 'recorded' }, updatedAt: 30 * DAY }),
  ],
  current: { chatId: 'b', floor: 5 },
}

// ——— colour ———

test('a root is the trunk; every branch of a small family gets a colour of its own', () => {
  const hues = laneHues(TREE.chats)
  assert.equal(hues.get('r'), TRUNK)
  const branches = ['a', 'b', 's', 'f'].map(id => hues.get(id))
  assert.ok(branches.every(hue => hue !== undefined && hue >= 0 && hue < LANE_HUES))
  assert.equal(new Set(branches).size, 4, `four branches, four colours: ${JSON.stringify(branches)}`)
})

test('the colour belongs to the chat, not to its lane or to the list order', () => {
  const hues = laneHues(TREE.chats)
  // Reversed input (the sidebar's newest-first order): the same answer.
  assert.deepEqual(laneHues([...TREE.chats].reverse()), hues)
  // A branch added on the left (lane 1) moves every lane index; no colour
  // moves unless the newcomer wanted exactly that slot first.
  const added = [TREE.chats[0] as ChatTreeNode, node('new', 3, { parentChatId: 'r', fork: { floor: 1, shared: 2, source: 'recorded' } }), ...TREE.chats.slice(1)]
  const after = laneHues(added)
  const wanted = hashId('new') % LANE_HUES
  for (const id of ['a', 'b', 's', 'f']) {
    if (hues.get(id) !== wanted) assert.equal(after.get(id), hues.get(id), `${id} kept its colour`)
  }
  assert.equal(new Set(['new', 'a', 'b', 's', 'f'].map(id => after.get(id))).size, 5)
})

test('the sidebar rows and the tree nodes of one family get the same colours', () => {
  // The sidebar holds every chat, including other families and a branch whose
  // parent is gone; it names parents by the same ids the tree does.
  const rows = [
    { chatId: 'other' },
    ...TREE.chats.map(one => one.parentChatId === undefined ? { chatId: one.chatId } : { chatId: one.chatId, parentChatId: one.parentChatId }),
    { chatId: 'other-branch', parentChatId: 'other' },
    { chatId: 'stray', parentChatId: 'deleted-long-ago' },
  ]
  const fromList = laneHues(rows)
  const fromTree = laneHues(TREE.chats)
  for (const one of TREE.chats) assert.equal(fromList.get(one.chatId), fromTree.get(one.chatId), one.chatId)
  assert.equal(fromList.get('stray'), TRUNK, 'a branch whose parent is gone is a root, in both views')
})

test('the map hands each lane its colour', () => {
  const { lanes } = layoutTree(TREE)
  const hues = laneHues(TREE.chats)
  for (const lane of lanes) assert.equal(lane.hue, hues.get(lane.chatId))
})

test('past the palette, colours repeat rather than fail', () => {
  const big = [node('r', 3), ...Array.from({ length: 9 }, (_, at) => node(`k${String(at)}`, 2, { parentChatId: 'r' }))]
  const hues = laneHues(big)
  const used = new Set(big.slice(1).map(one => hues.get(one.chatId)))
  assert.equal(used.size, LANE_HUES, 'every colour is used before any repeats')
})

// ——— weight ———

test('activity: own floors on a log scale, blended with recency against the family’s newest', () => {
  const newest = 100 * DAY
  // Nothing of its own, long untouched: the thinnest line.
  assert.equal(laneActivity({ floorCount: 4, fork: { floor: 3, shared: 4, source: 'recorded' }, updatedAt: 0 }, newest).width, WEIGHT_MIN)
  // 64 floors of its own and the newest in the family: the thickest.
  const full = laneActivity({ floorCount: 70, fork: { floor: 5, shared: 6, source: 'recorded' }, updatedAt: newest }, newest)
  assert.deepEqual([full.own, full.ageDays, full.score, full.width], [64, 0, 1, WEIGHT_MAX])
  // Bounded above: a 600-floor root is no thicker than 64 floors.
  assert.equal(laneActivity({ floorCount: 600, updatedAt: newest }, newest).width, WEIGHT_MAX)
  // Log, not linear: 8 own floors are half the floor term, not an eighth.
  const eight = laneActivity({ floorCount: 8, updatedAt: 0 }, 1000 * DAY)
  assert.ok(Math.abs(eight.score - 0.7 * Math.log2(9) / Math.log2(65)) < 1e-9)
  assert.ok(eight.score > 0.7 * 8 / 64 * 2, 'a log scale lifts a short branch well above its linear share')
  // Recency halves every 7 days: same floors, a week older, the recency term halves.
  const now = laneActivity({ floorCount: 0, updatedAt: newest }, newest)
  const week = laneActivity({ floorCount: 0, updatedAt: newest - 7 * DAY }, newest)
  assert.ok(Math.abs(now.score - 0.3) < 1e-9)
  assert.ok(Math.abs(week.score - 0.15) < 1e-9)
})

test('the layout’s widths are pure: read against the tree, not the clock', () => {
  const first = layoutTree(TREE).lanes.map(lane => lane.activity.width)
  const realNow = Date.now
  Date.now = () => realNow() + 365 * DAY
  try {
    assert.deepEqual(layoutTree(TREE).lanes.map(lane => lane.activity.width), first)
  } finally {
    Date.now = realNow
  }
  assert.equal(familyNewest(TREE), 30 * DAY)
  const by = new Map(layoutTree(TREE).lanes.map(lane => [lane.chatId, lane.activity]))
  // b and f are equally recent; b wrote one floor of its own, f none.
  assert.equal(by.get('b')?.own, 1)
  assert.equal(by.get('f')?.own, 0)
  assert.ok((by.get('b')?.width ?? 0) > (by.get('f')?.width ?? 0))
  // s wrote one floor too, but four weeks before the newest: thinner than b.
  assert.ok((by.get('s')?.width ?? 0) < (by.get('b')?.width ?? 0))
  for (const lane of by.values()) assert.ok(lane.width >= WEIGHT_MIN && lane.width <= WEIGHT_MAX)
})

// ——— the delete dialog ———

test('the delete summary names the floors, the parent the children go to, and the promoted root', () => {
  const middle = deleteSummary(TREE, 'a')
  assert.deepEqual(middle, { chatId: 'a', title: 'A', floors: 6, parent: { chatId: 'r', title: 'R' }, children: 1, descendants: 1 })
  // The root: its first child in lane order (the host's order) is promoted.
  const root = deleteSummary(TREE, 'r')
  assert.equal(root?.parent, undefined)
  assert.deepEqual(root?.promoted, { chatId: 'a', title: 'A' })
  assert.equal(root?.children, 3)
  assert.equal(root?.descendants, 4)
  // A leaf.
  assert.deepEqual(deleteSummary(TREE, 'f'), { chatId: 'f', title: 'F', floors: 6, parent: { chatId: 'r', title: 'R' }, children: 0, descendants: 0 })
  assert.equal(deleteSummary(TREE, 'nope'), undefined)
  assert.equal(deleteSummary(undefined, 'a'), undefined)
})
