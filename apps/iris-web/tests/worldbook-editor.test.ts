import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestSchemas, type WorldbookEntry } from '@iris/protocol'

import {
  changedUids,
  DEFAULT_WI_SORT,
  formatKeyList,
  isDirty,
  markSaved,
  openWiEditor,
  parseKeyList,
  searchWiEntries,
  sortWiEntries,
  updateWiEntry,
  wiSearchScore,
  WI_SORTS,
} from '../src/app/worldbook-editor.ts'

/**
 * The entry editor's mechanics, without a DOM or a host.
 *
 * The two halves most worth pinning are the ones that have to agree with
 * SillyTavern: the sort table (compared rule by rule against upstream's
 * `sortWorldInfoEntries`, including its tie-breakers) and the draft's trip
 * through the real `worldbook.replace` request schema, which is what stands
 * between a whole-book save and the host.
 */

/** One entry with only what the test names, filled over a working baseline. */
function entry(uid: number, over: Partial<WorldbookEntry> = {}): WorldbookEntry {
  return {
    uid,
    name: `entry ${uid}`,
    enabled: true,
    strategy: {
      type: 'selective',
      keys: [`k${uid}`],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: { type: 'at_depth', role: 'system', depth: 4, order: 100 },
    content: `content ${uid}`,
    probability: 100,
    useProbability: true,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
    addMemo: true,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    caseSensitive: null,
    matchWholeWords: null,
    outletName: '',
    automationId: '',
    useGroupScoring: null,
    ignoreBudget: false,
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    ...over,
  }
}

const four = [
  entry(1, { position: { type: 'at_depth', role: 'system', depth: 4, order: 30 } }),
  entry(2, { position: { type: 'at_depth', role: 'system', depth: 2, order: 30 } }),
  entry(3, { position: { type: 'at_depth', role: 'system', depth: 2, order: 10 } }),
  entry(4, { position: { type: 'at_depth', role: 'system', depth: 4, order: 20 } }),
]

// ----------------------------------------------------------------------- sorts

test('the sort table is upstream\u2019s selector, one option for one option', () => {
  // Counted off the live 1.18.0 install: fourteen visible options plus the
  // hidden search rule. A sort this table lacks is an order upstream can
  // produce and this shell cannot.
  assert.equal(WI_SORTS.length, 15)
  assert.deepEqual(WI_SORTS.map(row => row.id), [
    'priority', 'custom',
    'title_asc', 'title_desc',
    'tokens_asc', 'tokens_desc',
    'depth_asc', 'depth_desc',
    'order_asc', 'order_desc',
    'uid_asc', 'uid_desc',
    'probability_asc', 'probability_desc',
    'search',
  ])
  assert.equal(DEFAULT_WI_SORT, 'priority', 'upstream opens on Priority')
})

test('priority sorts constant, then normal, then disabled — upstream\u2019s ranks', () => {
  const list = [
    entry(1, { enabled: false }),
    entry(2),
    entry(3, { strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' } }),
    entry(4, { enabled: false }),
  ]
  assert.deepEqual(sortWiEntries(list, 'priority').map(row => row.uid), [3, 2, 1, 4])
})

test('every field sort walks its field in its direction', () => {
  // four: uid 1 (depth 4, order 30), uid 2 (depth 2, order 30),
  //       uid 3 (depth 2, order 10), uid 4 (depth 4, order 20)
  assert.deepEqual(sortWiEntries(four, 'depth_asc').map(row => row.uid), [2, 3, 1, 4])
  assert.deepEqual(sortWiEntries(four, 'depth_desc').map(row => row.uid), [1, 4, 2, 3])
  assert.deepEqual(sortWiEntries(four, 'order_asc').map(row => row.uid), [3, 4, 1, 2])
  assert.deepEqual(sortWiEntries(four, 'order_desc').map(row => row.uid), [1, 2, 4, 3])
  assert.deepEqual(sortWiEntries(four, 'uid_desc').map(row => row.uid), [4, 3, 2, 1])
  const titled = [
    entry(1, { name: 'beta' }),
    entry(2, { name: 'Gamma' }),
    entry(3, { name: 'alpha' }),
    // Mixed-case fixtures stay unambiguous: `localeCompare`'s answer for a
    // case-only difference is ICU's to make, and this pin is about field and
    // direction, not about the collator's case tie.
  ]
  assert.deepEqual(sortWiEntries(titled, 'title_asc').map(row => row.uid), [3, 1, 2])
  assert.deepEqual(sortWiEntries(titled, 'title_desc').map(row => row.uid), [2, 1, 3])
  const sized = [
    entry(1, { content: 'one' }),
    entry(2, { content: 'three!' }),
    entry(3, { content: '' }),
  ]
  assert.deepEqual(sortWiEntries(sized, 'tokens_asc').map(row => row.uid), [3, 1, 2])
  assert.deepEqual(sortWiEntries(sized, 'tokens_desc').map(row => row.uid), [2, 1, 3])
  const chances = [entry(1, { probability: 40 }), entry(2, { probability: 100 })]
  assert.deepEqual(sortWiEntries(chances, 'probability_asc').map(row => row.uid), [1, 2])
  assert.deepEqual(sortWiEntries(chances, 'probability_desc').map(row => row.uid), [2, 1])
})

test('a tie falls to order descending, then uid ascending — upstream\u2019s tie-breakers', () => {
  // depth_asc: 2 and 3 tie on depth 2, and order desc puts 2 (order 30) ahead
  // of 3 (order 10); 1 and 4 tie on depth 4 AND order 30, so uid puts 1 first.
  assert.deepEqual(sortWiEntries(four, 'depth_asc').map(row => row.uid), [2, 3, 1, 4])
  const tied = [
    entry(7, { position: { type: 'at_depth', role: 'system', depth: 4, order: 50 } }),
    entry(3, { position: { type: 'at_depth', role: 'system', depth: 4, order: 50 } }),
    entry(5, { position: { type: 'at_depth', role: 'system', depth: 4, order: 50 } }),
  ]
  assert.deepEqual(sortWiEntries(tied, 'title_asc').map(row => row.uid), [3, 5, 7])
  const tieWithOrders = [
    entry(7, { position: { type: 'at_depth', role: 'system', depth: 4, order: 50 } }),
    entry(3, { position: { type: 'at_depth', role: 'system', depth: 4, order: 90 } }),
    entry(5, { position: { type: 'at_depth', role: 'system', depth: 4, order: 70 } }),
  ]
  assert.deepEqual(sortWiEntries(tieWithOrders, 'title_asc').map(row => row.uid), [3, 5, 7])
})

test('custom keeps the arrival order — the display order worldbook.get answered', () => {
  const list = [entry(9), entry(1), entry(5)]
  assert.deepEqual(sortWiEntries(list, 'custom').map(row => row.uid), [9, 1, 5])
})

test('the search rule sorts by score ascending, missing scores at zero', () => {
  const list = [entry(1), entry(2), entry(3)]
  const sorted = sortWiEntries(list, 'search', new Map([[3, 5], [1, 2]]))
  // uid 2 has no score, so it reads as zero and takes the front.
  assert.deepEqual(sorted.map(row => row.uid), [2, 1, 3])
})

test('no sort mutates the list it is given', () => {
  const list = [entry(3), entry(1), entry(2)]
  const before = JSON.stringify(list)
  for (const sort of WI_SORTS) {
    sortWiEntries(list, sort.id, new Map([[1, 1]]))
  }
  assert.equal(JSON.stringify(list), before)
})

// ---------------------------------------------------------------------- filter

test('the filter matches title, keys, secondary keys, and content, case-insensitively', () => {
  const list = [
    entry(1, { name: 'Tower records' }),
    entry(2, { strategy: { type: 'selective', keys: ['NorthGate'], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' } }),
    entry(3, { strategy: { type: 'selective', keys: [], keys_secondary: { logic: 'and_any', keys: ['SEA'] }, scan_depth: 'same_as_global' } }),
    entry(4, { content: 'the maps are in the west tower' }),
    entry(5),
  ]
  assert.deepEqual(searchWiEntries(list, 'tower').map(row => row.uid), [1, 4])
  assert.deepEqual(searchWiEntries(list, 'northgate').map(row => row.uid), [2])
  assert.deepEqual(searchWiEntries(list, 'sea').map(row => row.uid), [3])
  // Empty keeps everything, in order.
  assert.deepEqual(searchWiEntries(list, '').map(row => row.uid), [1, 2, 3, 4, 5])
})

test('a title hit outranks a content hit of the same text', () => {
  const titled = entry(1, { name: 'dragon', content: 'nothing' })
  const bodied = entry(2, { name: 'other', content: 'a dragon appears' })
  assert.ok(wiSearchScore(titled, 'dragon') > wiSearchScore(bodied, 'dragon'))
})

// --------------------------------------------------------------- draft machine

test('the draft is a copy: editing it cannot rewrite the baseline', () => {
  const original = [entry(1)]
  const state = openWiEditor('Book', original)
  const draft = state.drafts[0]
  assert.ok(draft)
  draft.content = 'mutated'
  assert.equal(state.baseline[0]?.content, 'content 1', 'the baseline changed with the draft')
  assert.equal(original[0]?.content, 'content 1', 'the caller\u2019s list changed too')
  assert.ok(isDirty(state))
})

test('an untouched book is not dirty', () => {
  const state = openWiEditor('Book', [entry(1), entry(2)])
  assert.deepEqual(changedUids(state), [])
  assert.equal(isDirty(state), false)
})

test('one field edit marks exactly its entry, and undoing it unmarks', () => {
  let state = openWiEditor('Book', [entry(1), entry(2)])
  state = updateWiEntry(state, 2, { probability: 40 })
  assert.deepEqual(changedUids(state), [2])
  state = updateWiEntry(state, 2, { probability: 100 })
  assert.deepEqual(changedUids(state), [], 'reverting the field clears the dirty mark')
})

test('a nested edit is seen: keys, position, recursion, effect', () => {
  const state0 = openWiEditor('Book', [entry(1)])
  const draft = state0.drafts[0]
  assert.ok(draft)
  let state = updateWiEntry(state0, 1, { strategy: { ...draft.strategy, keys: ['new'] } })
  assert.ok(isDirty(state))
  state = updateWiEntry(state, 1, { position: { ...state.drafts[0]?.position ?? draft.position, order: 5 } })
  assert.ok(isDirty(state))
  state = updateWiEntry(state, 1, { recursion: { ...draft.recursion, prevent_incoming: true } })
  assert.ok(isDirty(state))
  state = updateWiEntry(state, 1, { effect: { ...draft.effect, sticky: 3 } })
  assert.ok(isDirty(state))
})

test('undefined patch values change nothing', () => {
  const state0 = openWiEditor('Book', [entry(1)])
  // Assembled loose on purpose: the editor never sends an explicit undefined,
  // but a caller that does must not dirty the book with it.
  const patch = { content: undefined } as unknown as Partial<WorldbookEntry>
  const state = updateWiEntry(state0, 1, patch)
  assert.equal(isDirty(state), false)
})

test('markSaved folds the host answer in and clears the dirty state', () => {
  let state = openWiEditor('Book', [entry(1)])
  state = updateWiEntry(state, 1, { probability: 10 })
  assert.ok(isDirty(state))
  // The answer is what the host would send back: the entry as re-stored.
  const saved = markSaved(state, [entry(1, { probability: 10 })])
  assert.equal(isDirty(saved), false)
  assert.equal(saved.baseline[0]?.probability, 10)
})

test('the drafts pass the real worldbook.replace request schema', () => {
  // The save is a whole-book send; this is the exact gate it crosses. A draft
  // shape the schema refuses would turn every save into a host error on a
  // real page, which no amount of UI polish is worth.
  const state = openWiEditor('Book', [
    entry(1, {
      strategy: { type: 'selective', keys: ['tower'], keys_secondary: { logic: 'not_all', keys: ['sea'] }, scan_depth: 6 },
      position: { type: 'outlet', role: 'assistant', depth: 0, order: 7 },
      automationId: 'qr_toggle',
      useGroupScoring: true,
      ignoreBudget: true,
      triggers: ['swipe'],
      characterFilter: { isExclude: true, names: ['Eldoria'], tags: [] },
    }),
    entry(2),
  ])
  const parsed = requestSchemas['worldbook.replace'].parse({
    name: 'Book',
    entries: JSON.parse(JSON.stringify(state.drafts)),
  })
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0]?.automationId, 'qr_toggle')
})

// ------------------------------------------------------------------ key fields

test('keys parse as upstream\u2019s plaintext mode: comma-separated, trimmed, empties dropped', () => {
  assert.deepEqual(parseKeyList('tower, sea ,'), ['tower', 'sea'])
  assert.deepEqual(parseKeyList(''), [])
  assert.deepEqual(parseKeyList('one'), ['one'])
})

test('keys render as the text the input shows', () => {
  assert.equal(formatKeyList(['tower', 'sea']), 'tower, sea')
  assert.equal(formatKeyList([]), '')
})
