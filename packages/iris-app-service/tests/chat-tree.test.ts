/**
 * The lineage graph `chat.tree` answers with, built from already-read files.
 *
 * Every rule is exercised where the nearest wrong rule would answer
 * differently: the recorded line id against a floor number that has moved, the
 * upstream marker against a prefix that disagrees with it, and the swipe rule
 * against the plain prefix rule on the same floor.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SillyTavernMessage } from '@iris/persistence'

import { buildChatTree, forkOf, lineageOf, projectFloors, type TreeChatInput } from '../src/chat-tree.ts'

/** A user line. */
function user(mes: string, extra: Partial<SillyTavernMessage> = {}): SillyTavernMessage {
  return { name: 'U', is_user: true, mes, ...extra }
}

/** A reply, with its reading set. */
function reply(mes: string, swipes: string[] = [mes], extra: Partial<SillyTavernMessage> = {}): SillyTavernMessage {
  return { name: 'A', is_user: false, mes, swipes, swipe_id: swipes.indexOf(mes), ...extra }
}

/** A graph input from lines. */
function chat(chatId: string, lines: SillyTavernMessage[], more: Partial<TreeChatInput> = {}): TreeChatInput {
  return { chatId, title: more.title ?? chatId, updatedAt: more.updatedAt ?? 0, floors: projectFloors(lines), ...more }
}

const ROOT = [reply('Hello.'), user('q1'), reply('r1'), user('q2'), reply('r2', ['r2', 'r2b']), user('q3'), reply('r3')]

test('a legacy branch forks where the common prefix ends', () => {
  // Cut at floor 2 (r1), then it went its own way.
  const child = chat('child', [...ROOT.slice(0, 3), user('other q'), reply('other r')], { parentChatId: 'root' })
  const fork = forkOf(chat('root', ROOT), child)
  assert.deepEqual(fork, { floor: 2, shared: 3, source: 'prefix' })
})

test('a legacy branch that has not moved on yet forks at its own last floor', () => {
  const child = chat('child', ROOT.slice(0, 4), { parentChatId: 'root' })
  assert.deepEqual(forkOf(chat('root', ROOT), child), { floor: 3, shared: 4, source: 'prefix' })
})

test('a legacy swipe turned into a branch forks AT that floor, not one above it', () => {
  // Same reading set on floor 4, the other reading selected. The plain prefix
  // rule would say "forked after floor 3"; the badge belongs on floor 4.
  const child = chat('child', [...ROOT.slice(0, 4), reply('r2b', ['r2', 'r2b'])], { parentChatId: 'root' })
  assert.deepEqual(forkOf(chat('root', ROOT), child), { floor: 4, shared: 4, source: 'prefix' })
})

test("upstream's extra.branches marker beats the prefix", () => {
  // The child's history was edited after the cut, so its prefix with the parent
  // is shorter than the cut; the parent's marker still names the floor.
  const marked = ROOT.map((line, at) => (at === 4 ? { ...line, extra: { branches: ['Aria - Branch #1'] } } : line))
  const child = chat('child', [ROOT[0] as SillyTavernMessage, user('edited q1'), ...ROOT.slice(2, 5)], {
    title: 'Aria - Branch #1',
    parentChatId: 'root',
  })
  // The child's own lane starts after the marked floor, whose text it still shares.
  assert.deepEqual(forkOf(chat('root', marked), child), { floor: 4, shared: 5, source: 'marker' })
})

test('a recorded branch point follows its line id when the parent lost a floor above it', () => {
  const withIds = ROOT.map((line, at) => ({ ...line, iris_id: `id-${String(at)}` }))
  // Floor 1 and 2 of the parent were deleted after the cut at floor 4.
  const parent = chat('root', [withIds[0], withIds[3], withIds[4], withIds[5]] as SillyTavernMessage[])
  const child = chat('child', withIds.slice(0, 5), { parentChatId: 'root', branchAt: { floor: 4, lineId: 'id-4' } })
  const fork = forkOf(parent, child)
  assert.equal(fork.source, 'recorded')
  assert.equal(fork.floor, 2, 'the id found the line at its new place; the floor number would have said 4')
})

test('a recorded branch point whose line is gone falls back to its floor, clamped to the parent', () => {
  const parent = chat('root', ROOT.slice(0, 3))
  const child = chat('child', ROOT.slice(0, 6), { parentChatId: 'root', branchAt: { floor: 5, lineId: 'nowhere' } })
  const fork = forkOf(parent, child)
  assert.equal(fork.source, 'recorded')
  assert.equal(fork.floor, 2)
})

test('a recorded swipe branch shares only the floors above the cut', () => {
  const child = chat('child', [...ROOT.slice(0, 4), reply('r2b', ['r2', 'r2b'])], {
    parentChatId: 'root',
    branchAt: { floor: 4 },
  })
  assert.deepEqual(forkOf(chat('root', ROOT), child), { floor: 4, shared: 4, source: 'recorded' })
})

test('nested branches: the tree is found from any member, root first, depth-first', () => {
  const inputs = [
    chat('root', ROOT),
    chat('a', [...ROOT.slice(0, 3), user('a q'), reply('a r'), user('a q2')], { parentChatId: 'root', branchAt: { floor: 2 } }),
    chat('b', [...ROOT.slice(0, 3), user('a q'), reply('a r'), user('b q')], { parentChatId: 'a', branchAt: { floor: 4 } }),
    chat('c', ROOT.slice(0, 2), { parentChatId: 'root', branchAt: { floor: 1 } }),
    chat('stranger', [reply('Elsewhere.')]),
  ]
  const tree = buildChatTree(inputs, 'b')
  assert.ok(tree !== undefined)
  assert.equal(tree.rootChatId, 'root')
  // c forks at floor 1, a at floor 2: lanes follow fork order.
  assert.deepEqual(tree.chats.map(node => node.chatId), ['root', 'c', 'a', 'b'])
  assert.deepEqual(tree.chats.map(node => node.depth), [0, 1, 1, 2])
  assert.equal(tree.chats.find(node => node.chatId === 'b')?.fork?.floor, 4)
  assert.equal(tree.chats.find(node => node.chatId === 'b')?.parentChatId, 'a')
  assert.deepEqual(tree.current, { chatId: 'b', floor: 5 })
  assert.equal(tree.chats[0]?.fork, undefined, 'the root has no fork')
  assert.deepEqual(tree.chats[0]?.swipes, [1, 1, 1, 1, 2, 1, 1], 'readings per floor, not branches')
  assert.equal(tree.chats[0]?.floorCount, 7)

  // The same graph from the root's side.
  assert.deepEqual(buildChatTree(inputs, 'root')?.chats.map(node => node.chatId), ['root', 'c', 'a', 'b'])
})

test('a parent that is not there makes its branch a root, and says so', () => {
  const tree = buildChatTree([chat('child', ROOT.slice(0, 3), { parentChatId: 'never-imported' })], 'child')
  assert.equal(tree?.rootChatId, 'child')
  assert.equal(tree?.chats[0]?.detachedFrom, 'never-imported')
  assert.equal(tree?.chats[0]?.fork, undefined)
})

test('deleting a middle conversation detaches its branches rather than losing them', () => {
  // root → a → b, and a was deleted: b names a parent that is gone.
  const inputs = [
    chat('root', ROOT),
    chat('b', ROOT.slice(0, 5), { parentChatId: 'a', branchAt: { floor: 4 } }),
  ]
  const fromRoot = buildChatTree(inputs, 'root')
  assert.deepEqual(fromRoot?.chats.map(node => node.chatId), ['root'])
  const fromB = buildChatTree(inputs, 'b')
  assert.equal(fromB?.rootChatId, 'b')
  assert.equal(fromB?.chats[0]?.detachedFrom, 'a')
})

test('an unreadable file is a node with no floors, not a missing node', () => {
  const tree = buildChatTree([chat('root', ROOT), { chatId: 'broken', title: 'broken', updatedAt: 0, parentChatId: 'root' }], 'root')
  const broken = tree?.chats.find(node => node.chatId === 'broken')
  assert.equal(broken?.unreadable, true)
  assert.equal(broken?.floorCount, 0)
})

test('a parent cycle in hand-edited files still yields a tree', () => {
  const inputs = [chat('x', ROOT, { parentChatId: 'y' }), chat('y', ROOT, { parentChatId: 'x' })]
  const tree = buildChatTree(inputs, 'x')
  assert.ok(tree !== undefined)
  assert.equal(tree.chats.length, 2)
  assert.equal(new Set(tree.chats.map(node => node.chatId)).size, 2)
  // The loop is cut at one edge: the root claims no parent, the other one does.
  assert.equal(tree.chats[0]?.parentChatId, undefined)
  assert.equal(tree.chats[0]?.fork, undefined)
  assert.equal(tree.chats.filter(node => node.parentChatId !== undefined).length, 1)
})

test('the lineage is decided from list rows, so only the family is read', () => {
  const rows = [
    { chatId: 'root' },
    { chatId: 'a', parentChatId: 'root' },
    { chatId: 'b', parentChatId: 'a' },
    { chatId: 'c', parentChatId: 'root' },
    { chatId: 'stranger' },
    { chatId: 'orphan', parentChatId: 'gone' },
  ]
  assert.deepEqual([...lineageOf(rows, 'b')].sort(), ['a', 'b', 'c', 'root'])
  assert.deepEqual([...lineageOf(rows, 'orphan')], ['orphan'])
  assert.deepEqual([...lineageOf(rows, 'stranger')], ['stranger'])
})

test('an unknown chat has no tree', () => {
  assert.equal(buildChatTree([chat('root', ROOT)], 'nope'), undefined)
})
