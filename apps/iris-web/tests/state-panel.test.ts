/**
 * The state margin's decisions, asserted.
 *
 * Every function here decides what a reader sees in the margin — what counts as
 * changed, what a search keeps, what a fold remembers — and every one was built
 * against a real MVU card's tree shape (`stat_data` with 34-item sections), not
 * a fixture shaped like the code's own beliefs.
 *
 * @module iris-web/tests/state-panel
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  branchPaths,
  changeSentence,
  changedAt,
  changedPaths,
  diffStats,
  EMPTY_DIFF,
  filterByName,
  keepChanged,
  loadFoldMemory,
  loadLastTree,
  previewValue,
  RANGED_RIGHT_LIMIT,
  ROUND_QUIET_MS,
  sameValue,
  saveFoldMemory,
  saveLastTree,
} from '../src/app/state-panel.ts'

test('diffStats marks a new leaf, a changed leaf with both readings, and a removed leaf', () => {
  const before = {
    stat_data: { 政局: { 支持: 40, 大选: '未开始' }, 经济: { 金币: 100 } },
  }
  const after = {
    stat_data: { 政局: { 支持: 47, 大选: ' campaigning ' }, 经济: { 金币: 100, 债券: 3 } },
  }

  const diff = diffStats(before, after)

  assert.deepEqual(diff.added, ['/stat_data/经济/债券'])
  assert.equal(diff.changed.length, 2)
  const support = changedAt(diff, '/stat_data/政局/支持')
  assert.equal(support?.from, 40)
  assert.equal(support?.to, 47)
  const election = changedAt(diff, '/stat_data/政局/大选')
  assert.equal(election?.from, '未开始')
  assert.deepEqual(diff.removed, [])
})

test('diffStats reports a removed branch whole, with the value it held', () => {
  const before = { stat_data: { 政局: { 支持: 40 }, 旧内阁: { 首相: '甲', 外相: '乙' } } }
  const after = { stat_data: { 政局: { 支持: 40 } } }

  const diff = diffStats(before, after)

  // One row for the section, not one per leaf — a removal that expanded into
  // every leaf would rebuild the wall this panel exists to end.
  assert.deepEqual(diff.removed, [{ path: '/stat_data/旧内阁', value: { 首相: '甲', 外相: '乙' } }])
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.changed, [])
})

test('diffStats marks a newly created branch once, not once per leaf', () => {
  const before = { stat_data: {} }
  const after = { stat_data: { 政局: { 支持: 40, 议席: 120, 民调: 0.31 } } }

  const diff = diffStats(before, after)

  assert.deepEqual(diff.added, ['/stat_data/政局'])
  assert.deepEqual(diff.changed, [])
  assert.deepEqual(diff.removed, [])
})

test('a flat array that grew changes at its own path, the row it actually renders as', () => {
  const before = { stat_data: { 内阁: ['甲', '乙'] } }
  const after = { stat_data: { 内阁: ['甲', '乙', '丙'] } }

  const diff = diffStats(before, after)

  // The tree draws a flat array as one joined line, never as numbered rows —
  // so a diff path inside it would decorate nothing. One change at the path
  // the reader can see, with both readings on hover.
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.changed, [{ path: '/stat_data/内阁', from: ['甲', '乙'], to: ['甲', '乙', '丙'] }])
})

test('a structural array (mixed content) that grew gains an added position', () => {
  const before = { stat_data: { 事件: [{ 名: '甲', 天: 1 }] } }
  const after = { stat_data: { 事件: [{ 名: '甲', 天: 1 }, { 名: '乙', 天: 2 }] } }

  const diff = diffStats(before, after)

  // The tree numbers a structural array's children one-based, so the diff's
  // paths have to match the rows they will decorate.
  assert.deepEqual(diff.added, ['/stat_data/事件/2'])
  assert.deepEqual(diff.changed, [])
})

test('diffStats is empty between identical trees, whatever the key order', () => {
  const before = { stat_data: { 政局: { 支持: 40 }, 经济: { 金币: 1 } } }
  const after = { stat_data: { 经济: { 金币: 1 }, 政局: { 支持: 40 } } }

  assert.deepEqual(diffStats(before, after), EMPTY_DIFF)
})

test('diffStats reports a kind change (branch to scalar) as one change of that path', () => {
  const before = { stat_data: { 大选: { 轮次: 1, 计票中: true } } }
  const after = { stat_data: { 大选: '已结束' } }

  const diff = diffStats(before, after)

  assert.deepEqual(diff.changed, [{ path: '/stat_data/大选', from: { 轮次: 1, 计票中: true }, to: '已结束' }])
})

test('diffStats on a first sighting (no previous floor) is empty', () => {
  assert.deepEqual(diffStats(undefined, { stat_data: { 支持: 40 } }), EMPTY_DIFF)
  assert.deepEqual(diffStats({ stat_data: { 支持: 40 } }, undefined), EMPTY_DIFF)
})

test('sameValue compares branches by content, not identity or key order', () => {
  assert.equal(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(sameValue({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }), true)
  assert.equal(sameValue({ a: 1 }, { a: 2 }), false)
  assert.equal(sameValue({ a: [] }, { a: {} }), false)
  assert.equal(sameValue(NaN, NaN), true)
  assert.equal(sameValue('1', 1), false)
  // The host re-materialises tables wholesale, so an equal array under a new
  // identity is not a change — the first live diff reported an empty list as
  // moved exactly this way.
  assert.equal(sameValue([], []), true)
  assert.equal(sameValue([1, 2], [1, 2]), true)
  assert.equal(sameValue([1, 2], [1, 2, 3]), false)
})

test('keepChanged prunes the tree to marked paths plus the headings above them', () => {
  const tree = [
    ['stat_data', { 政局: { 支持: 47, 民调: 0.31 }, 经济: { 金币: 100, 债券: 3 } }],
  ] as [string, unknown][]

  const keep = changedPaths({
    added: [],
    changed: [{ path: '/stat_data/政局/支持', from: 40, to: 47 }],
    removed: [],
  })

  const kept = keepChanged(tree, keep)

  assert.deepEqual(kept, [['stat_data', { 政局: { 支持: 47 } }]])
})

test('keepChanged keeps an added branch whole', () => {
  const tree = [['stat_data', { 政局: { 支持: 40 }, 新设: { 甲: 1, 乙: 2 } }]] as [string, unknown][]
  const keep = changedPaths({ added: ['/stat_data/新设'], changed: [], removed: [] })

  const kept = keepChanged(tree, keep)

  assert.deepEqual(kept, [['stat_data', { 新设: { 甲: 1, 乙: 2 } }]])
})

test('filterByName keeps a hit with its whole subtree and prunes siblings', () => {
  const tree = [
    ['stat_data', { 政局: { 大选年份: 1848, 支持: 40 }, 经济: { 金币: 100 } }],
  ] as [string, unknown][]

  const hits = filterByName(tree, '大选')

  assert.deepEqual(hits, [['stat_data', { 政局: { 大选年份: 1848 } }]])
})

test('filterByName matches inside deeper keys and keeps the path of headings to them', () => {
  const tree = [['stat_data', { 政局: { 内阁改选: '待定' } }]] as [string, unknown][]

  const hits = filterByName(tree, '改选')

  assert.deepEqual(hits, [['stat_data', { 政局: { 内阁改选: '待定' } }]])
})

test('filterByName is case-blind on Latin keys and returns undefined when nothing hits', () => {
  const tree = [['stat_data', { Treasury: { gold: 1 } }]] as [string, unknown][]

  assert.deepEqual(filterByName(tree, 'treasury'), [['stat_data', { Treasury: { gold: 1 } }]])
  assert.equal(filterByName(tree, '不存在'), undefined)
  // An empty query is no filter at all.
  assert.deepEqual(filterByName(tree, ''), tree)
})

test('branchPaths lists every disclosure the expand-all button has to reach', () => {
  const tree = [
    ['stat_data', { 政局: { 大选: { 轮次: 1 } }, 经济: { 金币: 1 } }],
    ['initialized_lorebooks', { 世界书: [] }],
  ] as [string, unknown][]

  assert.deepEqual(branchPaths(tree), [
    '/stat_data',
    '/stat_data/政局',
    '/stat_data/政局/大选',
    '/stat_data/经济',
    '/initialized_lorebooks',
  ])
})

test('fold memory round-trips per chat and refuses to remember junk', () => {
  const storage = new Map<string, string>()
  const like = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }

  // No record yet: defaults, not an error.
  assert.equal(loadFoldMemory('chat-a', like).size, 0)

  saveFoldMemory('chat-a', new Map([['/stat_data/政局', false], ['/stat_data', true]]), like)
  assert.deepEqual(
    [...loadFoldMemory('chat-a', like)],
    [['/stat_data/政局', false], ['/stat_data', true]],
  )
  // Chat-scoped: another chat's folds stay where they belong.
  assert.equal(loadFoldMemory('chat-b', like).size, 0)

  // A damaged record is a default, not a crash.
  storage.set('iris.state.folds.chat-c', '{not json')
  assert.equal(loadFoldMemory('chat-c', like).size, 0)
  storage.set('iris.state.folds.chat-d', '["a string"]')
  assert.equal(loadFoldMemory('chat-d', like).size, 0)

  // An empty override set removes the record rather than storing {}.
  saveFoldMemory('chat-a', new Map(), like)
  assert.equal(storage.has('iris.state.folds.chat-a'), false)
})

test('a refused storage write is dropped, not raised', () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota')
    },
    removeItem: () => {},
  }
  assert.doesNotThrow(() => saveFoldMemory('chat-a', new Map([['/x', true]]), refusing))
  assert.doesNotThrow(() => loadFoldMemory('chat-a', refusing))
})

test('the last-seen round round-trips per chat and treats a damaged record as absent', () => {
  const storage = new Map<string, string>()
  const like = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }

  // Nothing witnessed yet in this session.
  assert.equal(loadLastTree('chat-a', like), undefined)

  const sight = { tree: { stat_data: { 政局: { 支持: 47 } } }, at: 1_745_000_000_000 }
  saveLastTree('chat-a', sight, like)
  assert.deepEqual(loadLastTree('chat-a', like), sight)
  // Chat-scoped, like the fold memory.
  assert.equal(loadLastTree('chat-b', like), undefined)

  // A damaged record is no baseline, not a crash.
  storage.set('iris.state.lastTree.chat-c', '{not json')
  assert.equal(loadLastTree('chat-c', like), undefined)
  storage.set('iris.state.lastTree.chat-d', '{"tree": {"a": 1}}')
  assert.equal(loadLastTree('chat-d', like), undefined, 'a round without its arrival time is not one')
  storage.set('iris.state.lastTree.chat-e', '["a string"]')
  assert.equal(loadLastTree('chat-e', like), undefined)

  // A storage that refuses writes costs one lost diff, not an error.
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota')
    },
    removeItem: () => {},
  }
  assert.doesNotThrow(() => saveLastTree('chat-a', sight, refusing))
  assert.doesNotThrow(() => loadLastTree('chat-a', refusing))
})

test('the quiet window makes a burst of snapshots sum into one round', () => {
  /*
   * The rule the round hook applies, asserted on its constant's meaning: a
   * snapshot landing inside the window continues the round (the baseline
   * stays), one landing after it opens a new round from the tree just seen.
   * The window has to cover a status-bar card's trailing writes — observed to
   * bury a whole turn's diff when every snapshot was its own baseline.
   */
  assert.equal(typeof ROUND_QUIET_MS, 'number')
  assert.ok(ROUND_QUIET_MS >= 60_000, 'shorter than a minute cannot cover a card storm after a turn')
})

test('previewValue flattens a value to what a hover or a removed row can show', () => {
  assert.equal(previewValue('已结束', 'en'), '已结束')
  assert.equal(previewValue(47, 'en'), '47')
  assert.equal(previewValue(null, 'en'), '—')
  // A branch is a size, never a serialisation.
  assert.equal(previewValue({ 甲: 1, 乙: 2, 丙: 3 }, 'en'), '3 items')
  assert.equal(previewValue({ 甲: 1 }, 'zh'), '1 项')
})

test('changeSentence renders the old-to-new reading a changed row hovers', () => {
  assert.equal(changeSentence(40, 47, 'en'), '40 → 47')
  assert.equal(changeSentence('未开始', '计票中', 'zh'), '未开始 → 计票中')
  // Long readings clip, or a hover on a paragraph value is itself a paragraph.
  const long = '一'.repeat(120)
  const sentence = changeSentence(long, '新值', 'zh')
  assert.ok(sentence.startsWith(`${'一'.repeat(77)}… → `))
  assert.ok(sentence.endsWith('… → 新值'))
})

test('the ranged-right limit still separates tallies from notes', () => {
  assert.equal(RANGED_RIGHT_LIMIT, 22)
})
