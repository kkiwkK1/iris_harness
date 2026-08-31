import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deletePath, detach, insertMissing, insertOrAssign } from '../src/index.ts'

test('reads are detached from the store', () => {
  const stored = { 角色: { 络络: { 好感度: 5 } } }
  const copy = detach(stored) as typeof stored

  copy.角色.络络.好感度 = 99

  assert.equal(stored.角色.络络.好感度, 5)
})

test('insertOrAssign lets the incoming value win, and merges deeply', () => {
  // The example from Tavern Helper's own documentation.
  const before = { 爱城华恋: { 好感度: 5 } }
  const after = insertOrAssign(before, { 爱城华恋: { 好感度: 10 }, 神乐光: { 好感度: 5, 认知度: 0 } })

  assert.deepEqual(after, { 爱城华恋: { 好感度: 10 }, 神乐光: { 好感度: 5, 认知度: 0 } })
  assert.deepEqual(before, { 爱城华恋: { 好感度: 5 } }, 'the stored table must not be mutated')
})

test('insertMissing lets the existing value win', () => {
  const before = { 爱城华恋: { 好感度: 5 } }
  const after = insertMissing(before, { 爱城华恋: { 好感度: 10 }, 神乐光: { 好感度: 5, 认知度: 0 } })

  assert.deepEqual(after, { 爱城华恋: { 好感度: 5 }, 神乐光: { 好感度: 5, 认知度: 0 } })
})

test('an incoming array replaces rather than merging element-wise', () => {
  // The failure this rule exists to prevent: element-wise merge would leave
  // "盾" behind, so the character would still be carrying a dropped item.
  const before = { 络络: { 着装: ['法杖', '盾'] } }
  const after = insertOrAssign(before, { 络络: { 着装: ['剑'] } })

  assert.deepEqual(after, { 络络: { 着装: ['剑'] } })
})

test('an existing array also survives insertMissing intact', () => {
  const before = { 络络: { 着装: ['法杖', '盾'] } }
  const after = insertMissing(before, { 络络: { 着装: ['剑'] } })

  assert.deepEqual(after, { 络络: { 着装: ['法杖', '盾'] } })
})

test('deleting a present path reports that it happened', () => {
  const before = { 爱城华恋: { 好感度: 5 } }
  const result = deletePath(before, '爱城华恋.好感度')

  assert.equal(result.delete_occurred, true)
  assert.deepEqual(result.variables, { 爱城华恋: {} })
  assert.deepEqual(before, { 爱城华恋: { 好感度: 5 } }, 'the stored table must not be mutated')
})

test('deleting an absent path is a no-op that says so', () => {
  const result = deletePath({ 爱城华恋: { 好感度: 5 } }, '神乐光.好感度')

  assert.equal(result.delete_occurred, false)
  assert.deepEqual(result.variables, { 爱城华恋: { 好感度: 5 } })
})

test('lodash bracket paths address array elements', () => {
  const result = deletePath({ 队伍: [{ name: '露露' }, { name: '络络' }] }, '队伍[0].name')

  assert.equal(result.delete_occurred, true)
  assert.deepEqual(result.variables, { 队伍: [{}, { name: '络络' }] })
})
