/**
 * The floor-row contract, now owned in one place.
 *
 * This module exists because the two readers of an MVU row admit different
 * things, and the difference was invisible until it wasn't: the host's walks
 * accept `stat_data` alone, the bundle's baseline walk requires `schema` too,
 * and a seed that satisfied only the first produced a chat whose every round
 * folded its commands onto nothing (黑兽, 2026-09-20). These tests pin both
 * predicates and the seed builder so neither reading can drift.
 *
 * @module iris-mvu/tests/row
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { admissibleMvuSeed, bundleAdmitsMvuRow, hasMvuState } from '../src/row.ts'

const DECLARED = { initialized_lorebooks: {}, stat_data: { 世界: {} } }

test('the lenient contract is stat_data alone, so pre-schema rows keep their state', () => {
  assert.equal(hasMvuState({ stat_data: {} }), true)
  assert.equal(hasMvuState({ stat_data: {}, schema: '没有用别管这个' }), true)
  assert.equal(hasMvuState({ initialized_lorebooks: {} }), false, 'no tree, no state')
  assert.equal(hasMvuState(null), false)
  assert.equal(hasMvuState('stat_data'), false)
})

test('the bundle contract requires schema beside the tree', () => {
  assert.equal(bundleAdmitsMvuRow({ stat_data: {} }), false, 'the divergence that emptied a whole chat')
  assert.equal(bundleAdmitsMvuRow({ stat_data: {}, schema: {} }), true)
  assert.equal(bundleAdmitsMvuRow(null), false)
})

test('the seed builder writes the admissibility key and nothing more', () => {
  const seeded = admissibleMvuSeed(DECLARED)
  assert.equal(bundleAdmitsMvuRow(seeded), true, 'the seed is admissible to the bundle walk')
  assert.deepEqual(seeded.stat_data, DECLARED.stat_data, 'the declared tree travels untouched')
  assert.deepEqual(seeded.initialized_lorebooks, DECLARED.initialized_lorebooks)
})
