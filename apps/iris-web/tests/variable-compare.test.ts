/**
 * The compare mode's decisions: how picks advance, how a stale answer is
 * dropped, and how the host's diff paths become the variable tree's marks.
 *
 * `compareMarks` is chosen where the nearest wrong mapping disagrees: a
 * zero-based index (the host's) looked up in a one-based tree, a position
 * inside a list the tree draws as one row, and a path through an MVU pair
 * holding an object, which the tree draws as a two-row branch.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeClient } from '@iris/client-fake'
import { diffVariables, type IrisClient } from '@iris/protocol'

import { compareMarks } from '../src/app/state-panel.ts'
import { createIrisStore } from '../src/client/store.ts'
import { nextPicks } from '../src/client/variable-compare.ts'

const A = { chatId: 'c', floor: 0 }
const B = { chatId: 'c', floor: 4 }
const C = { chatId: 'd', floor: 2 }

test('picks go A, then B, then start over at A; the same floor twice is not a pair', () => {
  assert.deepEqual(nextPicks(undefined, A), { a: A })
  assert.deepEqual(nextPicks({ a: A, loading: false }, A), { a: A })
  assert.deepEqual(nextPicks({ a: A, loading: false }, B), { a: A, b: B })
  assert.deepEqual(nextPicks({ a: A, b: B, loading: false }, C), { a: C })
})

test('marks: a one-based list row, a flat list as one row, and an MVU pair holding an object', () => {
  const a = { stat_data: { tags: ['x', 'y'], npcs: [{ name: 'A', hp: 1 }], bag: [{ gold: 1 }, 'purse'], hp: [3, 'health'] } }
  const b = { stat_data: { tags: ['x', 'z'], npcs: [{ name: 'A', hp: 2 }], bag: [{ gold: 4 }, 'purse'], hp: [5, 'health'] } }
  const marks = compareMarks(diffVariables(a, b).entries, { a, b }, 'en')
  assert.deepEqual([...marks.changed.keys()], [
    '/stat_data/tags',
    '/stat_data/npcs/1/hp',
    '/stat_data/bag/1/gold',
    '/stat_data/hp',
  ])
  assert.equal(marks.changed.get('/stat_data/tags'), 'x, y → x, z')
  assert.equal(marks.changed.get('/stat_data/hp'), '3 → 5')
  assert.equal(marks.byIndex, true)
  assert.deepEqual(marks.entries, Object.entries(b))
})

test('marks: what only A holds is listed with a readable path; a missing B leaves an empty tree', () => {
  const a = { stat_data: { gone: { deep: 1 }, npcs: [{ n: 1 }, { n: 2 }] } }
  const b = { stat_data: { npcs: [{ n: 1 }] } }
  const marks = compareMarks(diffVariables(a, b).entries, { a, b }, 'en')
  assert.deepEqual(marks.removed.map(row => [row.path, row.label]), [
    ['/stat_data/npcs/2', 'stat_data / npcs / 2'],
    ['/stat_data/gone', 'stat_data / gone'],
  ])
  const missing = compareMarks(diffVariables(a, undefined).entries, { a }, 'en')
  assert.deepEqual(missing.entries, [])
  assert.deepEqual(missing.removed.map(row => row.path), ['/stat_data'])
})

test('the store asks for the diff when both sides are set, and drops an answer for picks since replaced', async () => {
  const fake = createFakeClient({ chunkDelayMs: 0 })
  const held: (() => void)[] = []
  let asked = 0
  const client = {
    call: async (method: string, params: unknown) => {
      if (method === 'chat.variablesDiff') {
        asked += 1
        // The first answer is held back until the reader has moved on.
        if (asked === 1) await new Promise<void>(resolve => held.push(resolve))
      }
      return await (fake as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => fake.subscribe(listener),
    get connected() { return fake.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => fake.onConnectionChange(listener),
  } as unknown as IrisClient
  const { store, dispose } = createIrisStore(client, { transport: 'fake', origin: 'variable compare store test' })
  const chatId = 'chat-lamplighter'

  store.getState().setCompareMode(true)
  store.getState().pickCompare({ chatId, floor: 0 })
  assert.equal(asked, 0, 'one side is not a comparison')
  store.getState().pickCompare({ chatId, floor: 4 })
  assert.equal(store.getState().compare?.loading, true)
  // The reader moves B before the first answer lands.
  store.getState().setCompareFloor('b', 2)
  for (let tries = 0; tries < 100 && store.getState().compare?.result === undefined; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  const second = store.getState().compare?.result
  assert.equal(second?.b.floor, 2)
  held.forEach(release => release())
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(store.getState().compare?.result?.b.floor, 2, 'the late answer for floor 4 was dropped')
  assert.equal(store.getState().compare?.loading, false)

  store.getState().swapCompare()
  for (let tries = 0; tries < 100 && store.getState().compare?.result?.a.floor !== 2; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.deepEqual([store.getState().compare?.a?.floor, store.getState().compare?.b?.floor], [2, 0])
  store.getState().setCompareMode(false)
  assert.equal(store.getState().compare, undefined)
  dispose()
  fake.dispose()
})
