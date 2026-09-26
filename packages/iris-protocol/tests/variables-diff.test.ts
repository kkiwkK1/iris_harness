/**
 * The variable diff between two floors (`chat.variablesDiff`).
 *
 * Each case is chosen where the nearest wrong implementation disagrees: a
 * naive `JSON.stringify` compare reports a key reorder, a leaf-only walk
 * reports an added section as dozens of rows, a walk that ignores MVU pairs
 * reports `hp/0`, and one that ignores kinds walks into a string's characters.
 *
 * @module @iris/protocol/tests/variables-diff
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffVariables, isMvuPair, sameVariables } from '../src/variables-diff.ts'

test('identical inputs: no entries, identical, zero counts — and a key reorder is not a change', () => {
  const a = { stat_data: { hp: 3, name: 'x', list: [1, { k: 'v' }] }, other: null }
  const b = { other: null, stat_data: { list: [1, { k: 'v' }], name: 'x', hp: 3 } }
  const diff = diffVariables(a, b)
  assert.deepEqual(diff.entries, [])
  assert.equal(diff.identical, true)
  assert.deepEqual(diff.summary, { added: 0, removed: 0, changed: 0 })
})

test('nested objects: a changed leaf names its full path, with both readings', () => {
  const diff = diffVariables(
    { stat_data: { 角色: { 状态: { 心情: '平静', 体力: 80 } } } },
    { stat_data: { 角色: { 状态: { 心情: '紧张', 体力: 80 } } } },
  )
  assert.deepEqual(diff.entries, [
    { path: ['stat_data', '角色', '状态', '心情'], kind: 'changed', before: '平静', after: '紧张' },
  ])
  assert.equal(diff.identical, false)
})

test('an added and a removed subtree are one entry each, carrying the whole value', () => {
  const section = { a: 1, b: 2, c: { d: 3 } }
  const diff = diffVariables({ old: section, keep: 1 }, { keep: 1, fresh: section })
  assert.deepEqual(diff.entries, [
    { path: ['fresh'], kind: 'added', after: section },
    { path: ['old'], kind: 'removed', before: section },
  ])
  assert.deepEqual(diff.summary, { added: 1, removed: 1, changed: 0 })
})

test('arrays compare by position, and every entry under an index says so', () => {
  const diff = diffVariables({ items: ['钳', '灯芯'] }, { items: ['灯芯', '钳', '伞'] })
  assert.deepEqual(diff.entries, [
    { path: ['items', 0], kind: 'changed', before: '钳', after: '灯芯', notes: ['index'] },
    { path: ['items', 1], kind: 'changed', before: '灯芯', after: '钳', notes: ['index'] },
    { path: ['items', 2], kind: 'added', after: '伞', notes: ['index'] },
  ])
})

test('an array that shrank reports the lost positions as removed; nested objects inside keep the note', () => {
  const diff = diffVariables(
    { npcs: [{ name: 'A', hp: 1 }, { name: 'B', hp: 2 }] },
    { npcs: [{ name: 'A', hp: 5 }] },
  )
  assert.deepEqual(diff.entries, [
    { path: ['npcs', 0, 'hp'], kind: 'changed', before: 1, after: 5, notes: ['index'] },
    { path: ['npcs', 1], kind: 'removed', before: { name: 'B', hp: 2 }, notes: ['index'] },
  ])
})

test('MVU [value, description] pairs compare by value, at the pair own path', () => {
  const diff = diffVariables(
    { stat_data: { 好感度: [30, '她对你的信任'] } },
    { stat_data: { 好感度: [35, '她对你的信任'] } },
  )
  assert.deepEqual(diff.entries, [
    { path: ['stat_data', '好感度'], kind: 'changed', before: 30, after: 35, notes: ['mvu'] },
  ])
})

test('an MVU pair whose description changed falls back to positions', () => {
  const diff = diffVariables({ hp: [30, 'old words'] }, { hp: [30, 'new words'] })
  assert.deepEqual(diff.entries, [
    { path: ['hp', 1], kind: 'changed', before: 'old words', after: 'new words', notes: ['index'] },
  ])
})

test('an MVU pair holding an object walks into the value half', () => {
  const diff = diffVariables({ bag: [{ gold: 1, gems: 0 }, 'purse'] }, { bag: [{ gold: 4, gems: 0 }, 'purse'] })
  assert.deepEqual(diff.entries, [
    { path: ['bag', 'gold'], kind: 'changed', before: 1, after: 4, notes: ['mvu'] },
  ])
})

test('a change of kind is one entry for the whole path, never a walk into mismatched children', () => {
  const diff = diffVariables(
    { a: { x: 1 }, b: '5', c: [1, 2], d: 3, e: null },
    { a: 'gone', b: 5, c: { 0: 1, 1: 2 }, d: [3, 'hp'], e: 0 },
  )
  assert.deepEqual(diff.entries.map(entry => [entry.path, entry.notes]), [
    [['a'], ['type']],
    [['b'], ['type']],
    [['c'], ['type']],
    [['d'], ['type']],
    [['e'], ['type']],
  ])
  assert.deepEqual(diff.entries[1], { path: ['b'], kind: 'changed', before: '5', after: 5, notes: ['type'] })
})

test('a missing snapshot compares as an empty table: every top-level key is one entry', () => {
  const b = { stat_data: { hp: 3 }, flag: true }
  const onlyB = diffVariables(undefined, b)
  assert.deepEqual(onlyB.entries, [
    { path: ['stat_data'], kind: 'added', after: { hp: 3 } },
    { path: ['flag'], kind: 'added', after: true },
  ])
  const onlyA = diffVariables(b, undefined)
  assert.deepEqual(onlyA.summary, { added: 0, removed: 2, changed: 0 })
  assert.equal(diffVariables(undefined, undefined).identical, true)
})

test('__proto__ is a key like any other: compared, reported, and never written through', () => {
  const a = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": 1, "safe": 1}') as unknown
  const b = JSON.parse('{"__proto__": {"polluted": 2}, "safe": 1, "toString": "x"}') as unknown
  const diff = diffVariables(a, b)
  assert.deepEqual(diff.entries, [
    { path: ['__proto__', 'polluted'], kind: 'changed', before: 1, after: 2 },
    { path: ['toString'], kind: 'added', after: 'x' },
    { path: ['constructor'], kind: 'removed', before: 1 },
  ])
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
  // A key the other side lacks is not found on the prototype either.
  assert.deepEqual(diffVariables({}, JSON.parse('{"hasOwnProperty": 1}')).entries, [
    { path: ['hasOwnProperty'], kind: 'added', after: 1 },
  ])
})

test('an empty array re-created, and NaN, are not changes; the shape helpers say what they recognise', () => {
  assert.equal(diffVariables({ list: [], n: Number.NaN }, { list: [], n: Number.NaN }).identical, true)
  assert.equal(sameVariables([1, [2]], [1, [2]]), true)
  assert.equal(sameVariables({ a: 1 }, { a: 1, b: undefined }), false)
  assert.equal(isMvuPair([3, 'hp']), true)
  assert.equal(isMvuPair([[3], 'hp']), false)
  assert.equal(isMvuPair(['a', 'b', 'c']), false)
})
