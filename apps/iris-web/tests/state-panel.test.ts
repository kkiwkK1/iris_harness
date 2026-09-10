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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASIDE_FROM,
  ASIDE_TRACK,
  ASIDE_YIELD_BELOW,
  ASIDE_YIELD_QUERY,
  asideShowing,
  branchPaths,
  changeSentence,
  changedAt,
  changedPaths,
  diffStats,
  DRAWER_TRACK,
  DRAWER_TRACK_FROM,
  EMPTY_DIFF,
  filterByName,
  keepChanged,
  loadAsideOpen,
  loadFoldMemory,
  loadLastTree,
  previewValue,
  RANGED_RIGHT_LIMIT,
  READING_FLOOR,
  ROUND_QUIET_MS,
  sameValue,
  saveAsideOpen,
  saveFoldMemory,
  saveLastTree,
  SIDEBAR_TRACK,
} from '../src/app/state-panel.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

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

/* ------------------------------------------------------ the margin's own state */

test('the reader’s collapse survives a remount, because it is read from storage', () => {
  /*
   * The remount half of "per device, not per session". `StatePanel` initialises
   * its state *from* `loadAsideOpen` (pinned below), so a round trip through the
   * store is exactly what a fresh mount does — a reload, a theme switch that
   * remounts the tree, tomorrow morning.
   */
  const cell = new Map<string, string>()
  const like = {
    getItem: (key: string) => cell.get(key) ?? null,
    setItem: (key: string, value: string) => void cell.set(key, value),
    removeItem: (key: string) => void cell.delete(key),
  }

  // Never touched: open, because the margin is the reason a wide window is not
  // empty. Absence of a record is not a collapsed margin.
  assert.equal(loadAsideOpen(like), true)

  saveAsideOpen(false, like)
  assert.equal(loadAsideOpen(like), false, 'a collapsed margin did not survive the remount')
  // The key is in the `iris.` family, beside `iris.theme` and `iris.reading`,
  // and in localStorage rather than sessionStorage — a browser review looked for
  // it by prefix and reported it missing.
  assert.deepEqual([...cell.keys()], ['iris.state.open'])
  assert.equal(cell.get('iris.state.open'), 'shut')

  saveAsideOpen(true, like)
  assert.equal(loadAsideOpen(like), true)

  // A refused store is a default, not a crash: a reader with site data blocked
  // still gets a working margin.
  const refusing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
    removeItem: () => {},
  }
  assert.doesNotThrow(() => saveAsideOpen(false, refusing))
  assert.equal(loadAsideOpen(refusing), true)
})

test('the margin yields to the drawer only where the window cannot pay for both', () => {
  // All four combinations, because the rule is a conjunction and three of them
  // must leave the reader's choice showing.
  assert.equal(asideShowing(true, false, false), true)
  assert.equal(asideShowing(true, true, false), true, 'a wide window pays for both')
  assert.equal(asideShowing(true, false, true), true, 'a closed drawer costs nothing')
  assert.equal(asideShowing(true, true, true), false, 'the margin should have yielded')
  // A reader who folded it away stays folded in every one of them.
  for (const drawer of [false, true]) {
    for (const tight of [false, true]) {
      assert.equal(asideShowing(false, drawer, tight), false)
    }
  }
})

test('yielding cannot write the reader’s choice: nothing on that path can reach storage', () => {
  /*
   * The invariant the browser review asked for, in both halves it can fail in.
   *
   * `asideShowing` takes no storage and returns a boolean — it *cannot* persist
   * — but that is only half the guarantee: a component that recomputed the yield
   * and then "helpfully" remembered it would put the window's decision into a
   * per-device preference, and the reader would find their margin folded
   * tomorrow with no idea what folded it. So the second half is pinned on the
   * component: exactly one call to `saveAsideOpen`, and it is the click.
   */
  const panel = readFileSync(join(SRC, 'app', 'StatePanel.tsx'), 'utf8')
  const writes = [...panel.matchAll(/saveAsideOpen\(/g)]
  assert.equal(
    writes.length,
    1,
    `${String(writes.length)} calls to saveAsideOpen in StatePanel.tsx; the yield must not be one of them`,
  )
  // …and that one call is the toggle's own handler, reading the click's value.
  assert.match(
    panel,
    /const next = !asideOpen\s*\n\s*setAsideOpen\(next\)\s*\n\s*saveAsideOpen\(next\)/,
    'the one write is no longer the collapse click',
  )
  // The stored choice is what a fresh mount starts from, which is what makes the
  // remount test above a statement about this component.
  assert.match(panel, /useState\(loadAsideOpen\)/, 'the margin no longer initialises from storage')
  // And what is on screen is the derived value, not the stored one.
  assert.match(panel, /asideShowing\(asideOpen, drawerOpen, tight\)/, 'the yield is no longer derived')
  assert.match(panel, /data-iris-aside=\{showing \? 'open' : 'shut'\}/, 'the attribute is not the derived value')
})

test('the yield range is derived from the tracks the stylesheets actually declare', () => {
  /*
   * Four of these numbers are copies of CSS declarations, and a copy of a
   * measurement drifts silently — the arithmetic would go on producing a
   * plausible breakpoint for a layout that had moved. So each one is read back
   * out of the file that owns it.
   */
  const tokens = readFileSync(join(SRC, 'theme', 'tokens.css'), 'utf8')
  const shell = readFileSync(join(SRC, 'app', 'shell.css'), 'utf8')
  const panels = readFileSync(join(SRC, 'app', 'panels.css'), 'utf8')

  assert.ok(
    tokens.includes(`--iris-aside: ${String(ASIDE_TRACK)}px`),
    `--iris-aside is no longer ${String(ASIDE_TRACK)}px`,
  )
  assert.ok(
    tokens.includes(`--iris-drawer-w: min(${String(DRAWER_TRACK)}px`),
    `--iris-drawer-w is no longer ${String(DRAWER_TRACK)}px`,
  )
  /*
   * Read off `.iris-sidebar`, not off `.iris-shell`.
   *
   * The number moved when the panel learned to fold: the shell's first track is
   * `auto` now so that one transition on the panel animates both it and the
   * reading area beside it, and the width it animates lives on the panel. What
   * the arithmetic needs is unchanged - the *expanded* width, because a media
   * query cannot ask whether the reader has folded it (`state-panel.ts` says
   * which direction that errs in).
   */
  const sidebarRule = shell.slice(shell.indexOf('.iris-sidebar {'))
  assert.ok(sidebarRule.startsWith('.iris-sidebar {'), 'the sidebar has no base rule to read a width from')
  assert.ok(
    sidebarRule.slice(0, sidebarRule.indexOf('}')).includes(`width: ${String(SIDEBAR_TRACK)}px`),
    `the sidebar is no longer ${String(SIDEBAR_TRACK)}px wide when it is open`,
  )
  assert.ok(
    shell.includes('grid-template-columns: auto minmax(0, 1fr)'),
    'the shell no longer sizes its first track to the sidebar, so the width above decides nothing',
  )
  assert.ok(
    panels.includes(`@media (min-width: ${String(ASIDE_FROM)}px)`),
    `the margin no longer appears at ${String(ASIDE_FROM)}px`,
  )

  // The arithmetic itself: at the boundary the reading column is exactly the
  // floor, so the yield applies strictly below it.
  assert.equal(ASIDE_YIELD_BELOW, SIDEBAR_TRACK + ASIDE_TRACK + DRAWER_TRACK + READING_FLOOR)
  assert.equal(DRAWER_TRACK_FROM, SIDEBAR_TRACK + DRAWER_TRACK + READING_FLOOR)
  assert.ok(
    panels.includes(`@media (min-width: ${String(DRAWER_TRACK_FROM)}px)`),
    `the drawer no longer becomes a track at ${String(DRAWER_TRACK_FROM)}px - one reading floor for both flanks`,
  )
  assert.equal(ASIDE_YIELD_BELOW - SIDEBAR_TRACK - ASIDE_TRACK - DRAWER_TRACK, READING_FLOOR)
  // The measured case that started this: 1440 with all three flanks up.
  assert.ok(1440 < ASIDE_YIELD_BELOW, '1440px must be inside the yield range, it was measured at 539px of prose')
  assert.equal(
    ASIDE_YIELD_QUERY,
    `(min-width: ${String(ASIDE_FROM)}px) and (max-width: ${String(ASIDE_YIELD_BELOW - 1)}px)`,
    'the media query and the arithmetic have come apart',
  )
})
