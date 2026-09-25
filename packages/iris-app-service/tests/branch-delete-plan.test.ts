/**
 * Deleting one conversation of a lineage: what happens to its children
 * (`planBranchDelete`), checked through the graph `chat.tree` then builds.
 *
 * Chosen where the nearest wrong rule disagrees. "Keep the child's own
 * `branchAt`" answers 5 for a child cut below the deleted branch's fork, where
 * the truth is 4; "take the deleted branch's fork" answers 4 for a child cut
 * above it, where the truth is 2; and a deleted branch that was another
 * reading of its fork floor makes the re-attached child's lane start AT that
 * floor, which only a plan that goes through the fork rules gets right.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SillyTavernMessage } from '@iris/persistence'

import { buildChatTree, planBranchDelete, projectFloors, type BranchDeletePlan, type TreeChatInput } from '../src/chat-tree.ts'

/** A user line. */
function user(mes: string, id?: string): SillyTavernMessage {
  return { name: 'U', is_user: true, mes, ...id === undefined ? {} : { iris_id: id } }
}

/** A reply, with its reading set. */
function reply(mes: string, swipes: string[] = [mes], id?: string): SillyTavernMessage {
  return { name: 'A', is_user: false, mes, swipes, swipe_id: swipes.indexOf(mes), ...id === undefined ? {} : { iris_id: id } }
}

/** A graph input from lines. */
function chat(chatId: string, lines: SillyTavernMessage[], more: Partial<TreeChatInput> = {}): TreeChatInput {
  return { chatId, title: more.title ?? chatId, updatedAt: more.updatedAt ?? 0, floors: projectFloors(lines), ...more }
}

/** The root's floors, each with a durable id `g-<floor>`. */
const G = [
  reply('Hello.', undefined, 'g-0'), user('q1', 'g-1'), reply('r1', undefined, 'g-2'), user('q2', 'g-3'),
  reply('r2', ['r2', 'r2b'], 'g-4'), user('q3', 'g-5'), reply('r3', undefined, 'g-6'),
]
/** Without ids, for the legacy case. */
const PLAIN = G.map(({ iris_id: _id, ...line }) => line as SillyTavernMessage)

/** A swipe branch of g at floor 4 (the other reading), which then wrote two floors of its own. */
const V = [...G.slice(0, 4), reply('r2b', ['r2', 'r2b'], 'g-4'), user('v q', 'v-5'), reply('v r', undefined, 'v-6')]

/** g → v → { shallow (cut at 2, above v's fork), deep (cut at v's own floor 5) → grandchild }. */
function family(): TreeChatInput[] {
  return [
    chat('g', G, { updatedAt: 10 }),
    chat('v', V, { parentChatId: 'g', branchAt: { floor: 4, lineId: 'g-4' }, updatedAt: 20 }),
    chat('deep', [...V.slice(0, 6), user('deep q')], { parentChatId: 'v', branchAt: { floor: 5, lineId: 'v-5' }, updatedAt: 30 }),
    chat('shallow', [...G.slice(0, 3), user('shallow q')], { parentChatId: 'v', branchAt: { floor: 2, lineId: 'g-2' }, updatedAt: 40 }),
    chat('grandchild', [...V.slice(0, 6), user('deep q'), reply('gc r')], { parentChatId: 'deep', branchAt: { floor: 6 }, updatedAt: 50 }),
  ]
}

/** The inputs after a plan is carried out: deleted ones dropped, relinks applied. */
function applied(inputs: readonly TreeChatInput[], plan: BranchDeletePlan): TreeChatInput[] {
  const moved = new Map(plan.relinks.map(relink => [relink.chatId, relink]))
  return inputs
    .filter(input => !plan.deleted.includes(input.chatId))
    .map(input => {
      const relink = moved.get(input.chatId)
      if (relink === undefined) return input
      const { parentChatId: _parent, branchAt: _at, ...rest } = input
      return {
        ...rest,
        ...relink.parent === undefined ? {} : { parentChatId: relink.parent.chatId },
        ...relink.branchAt === undefined ? {} : { branchAt: relink.branchAt },
      }
    })
}

test('deleting a middle branch re-attaches its children to its parent, each at the fork it really has there', () => {
  const inputs = family()
  const plan = planBranchDelete(inputs, 'v', 'reattach')
  assert.ok(plan !== undefined)
  assert.deepEqual(plan.deleted, ['v'])
  assert.equal(plan.successor, 'g')
  assert.equal(plan.promoted, undefined)
  // Lane order: shallow leaves v at 2, deep at 5.
  assert.deepEqual(plan.relinks, [
    // Cut above v's own fork: those floors were g's all along, so the cut stands.
    { chatId: 'shallow', parent: { chatId: 'g', title: 'g' }, branchAt: { floor: 2, lineId: 'g-2' } },
    // Cut below it: relative to g, deep leaves where v left, at floor 4 and g's line g-4.
    { chatId: 'deep', parent: { chatId: 'g', title: 'g' }, branchAt: { floor: 4, lineId: 'g-4' } },
  ])

  const tree = buildChatTree(applied(inputs, plan), 'grandchild')
  assert.ok(tree !== undefined)
  const by = new Map(tree.chats.map(node => [node.chatId, node]))
  assert.equal(tree.rootChatId, 'g')
  assert.deepEqual(by.get('shallow')?.fork, { floor: 2, shared: 3, source: 'recorded' })
  // v was the other reading of floor 4 and deep inherited it: its lane starts AT 4.
  assert.deepEqual(by.get('deep')?.fork, { floor: 4, shared: 4, source: 'recorded' })
  // A grandchild keeps its own parent; only the deleted branch's children move.
  assert.equal(by.get('grandchild')?.parentChatId, 'deep')
  assert.deepEqual(by.get('grandchild')?.fork, { floor: 6, shared: 7, source: 'recorded' })
  // No orphaned lane: one root, and every other node has its parent in the tree.
  assert.equal(tree.chats.filter(node => node.parentChatId === undefined).length, 1)
  assert.ok(tree.chats.every(node => node.detachedFrom === undefined))
  assert.deepEqual(tree.chats.map(node => node.chatId), ['g', 'shallow', 'deep', 'grandchild'])
})

test('a child cut at the very floor its parent left from forks there too', () => {
  const inputs = [
    chat('g', G),
    chat('v', [...G.slice(0, 3), user('v q')], { parentChatId: 'g', branchAt: { floor: 2, lineId: 'g-2' } }),
    chat('k', [...G.slice(0, 3), user('k q')], { parentChatId: 'v', branchAt: { floor: 2, lineId: 'g-2' } }),
  ]
  const plan = planBranchDelete(inputs, 'v', 'reattach') as BranchDeletePlan
  assert.deepEqual(plan.relinks, [{ chatId: 'k', parent: { chatId: 'g', title: 'g' }, branchAt: { floor: 2, lineId: 'g-2' } }])
  const tree = buildChatTree(applied(inputs, plan), 'k')
  assert.deepEqual(tree?.chats.find(node => node.chatId === 'k')?.fork, { floor: 2, shared: 3, source: 'recorded' })
})

test('a legacy child with no recorded fork is re-attached with one', () => {
  // No branchAt and no ids anywhere: both forks are inferred, and the relink records the result.
  const inputs = [
    chat('g', PLAIN),
    chat('v', [...PLAIN.slice(0, 3), user('v q'), reply('v r')], { parentChatId: 'g' }),
    chat('k', [...PLAIN.slice(0, 3), user('v q'), reply('v r'), user('k q')], { parentChatId: 'v' }),
  ]
  const plan = planBranchDelete(inputs, 'v', 'reattach') as BranchDeletePlan
  assert.deepEqual(plan.relinks, [{ chatId: 'k', parent: { chatId: 'g', title: 'g' }, branchAt: { floor: 2 } }])
  const tree = buildChatTree(applied(inputs, plan), 'k')
  assert.deepEqual(tree?.chats.find(node => node.chatId === 'k')?.fork, { floor: 2, shared: 3, source: 'recorded' })
})

test('deleting the root promotes its first child in lane order, and the others fork from that one', () => {
  const inputs = [
    chat('root', G),
    // Touched earlier but leaves later: lane order is by fork floor first.
    chat('late', [...G.slice(0, 5), user('late q')], { parentChatId: 'root', branchAt: { floor: 4, lineId: 'g-4' }, updatedAt: 5 }),
    chat('early', [...G.slice(0, 3), user('early q')], { parentChatId: 'root', branchAt: { floor: 2, lineId: 'g-2' }, updatedAt: 9 }),
    chat('mine', [...G.slice(0, 3), user('early q'), reply('mine r')], { parentChatId: 'early', branchAt: { floor: 3 } }),
  ]
  const plan = planBranchDelete(inputs, 'root', 'reattach')
  assert.ok(plan !== undefined)
  assert.equal(plan.promoted, 'early')
  assert.equal(plan.successor, 'early')
  assert.deepEqual(plan.relinks, [
    { chatId: 'early' },
    { chatId: 'late', parent: { chatId: 'early', title: 'early' }, branchAt: { floor: 2, lineId: 'g-2' } },
  ])
  const tree = buildChatTree(applied(inputs, plan), 'late')
  assert.ok(tree !== undefined)
  assert.equal(tree.rootChatId, 'early')
  assert.deepEqual(tree.chats.map(node => node.chatId), ['early', 'late', 'mine'])
  assert.deepEqual(tree.chats.find(node => node.chatId === 'late')?.fork, { floor: 2, shared: 3, source: 'recorded' })
  assert.equal(tree.chats.find(node => node.chatId === 'mine')?.parentChatId, 'early')
  assert.equal(tree.chats[0]?.detachedFrom, undefined)
})

test('a root with no branches, and a leaf, delete as themselves alone', () => {
  assert.deepEqual(planBranchDelete([chat('solo', G)], 'solo', 'reattach'), { deleted: ['solo'], relinks: [] })
  assert.deepEqual(planBranchDelete(family(), 'grandchild', 'reattach'), { deleted: ['grandchild'], relinks: [], successor: 'deep' })
  assert.equal(planBranchDelete(family(), 'nope', 'reattach'), undefined)
})

test("'delete' removes the branch and every descendant, parents first, and re-attaches nothing", () => {
  const plan = planBranchDelete([...family(), chat('stranger', G)], 'v', 'delete')
  assert.deepEqual(plan, { deleted: ['v', 'shallow', 'deep', 'grandchild'], relinks: [], successor: 'g' })
  // From the root: the whole family, and nowhere left to go.
  assert.deepEqual(planBranchDelete(family(), 'g', 'delete'), { deleted: ['g', 'v', 'shallow', 'deep', 'grandchild'], relinks: [] })
})
