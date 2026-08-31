/**
 * Merge and deletion semantics, replicated from Tavern Helper.
 *
 * These rules are compatibility surface, not design choices. Community cards
 * were written against them, so the edge cases matter more than the happy path:
 * arrays REPLACE rather than merge, `insertVariables` lets the existing value
 * win while `insertOrAssignVariables` lets the new one win, and reads hand back
 * a detached copy so a card mutating the result changes nothing until it writes
 * back.
 *
 * Paths are lodash paths (`'角色.络络.好感度'`, `'队伍[0].name'`) because that is
 * what cards write — `_` is injected into every card sandbox as a global.
 *
 * @module @iris/variables/semantics
 */

import cloneDeep from 'lodash-es/cloneDeep.js'
import has from 'lodash-es/has.js'
import mergeWith from 'lodash-es/mergeWith.js'
import unset from 'lodash-es/unset.js'

import type { Variables } from './scope.ts'

/**
 * Upstream's merge customizer: an array on the source side replaces the
 * destination outright instead of being merged element-wise.
 *
 * Without this, `["剑","盾"]` merged over `["法杖"]` would yield `["剑","盾"]`
 * only by accident of length — and `["剑"]` over `["法杖","盾"]` would leave a
 * stray `"盾"` behind.
 * @param _destination - the existing value (unused; only the source shape decides).
 * @param source - the incoming value.
 * @returns the source when it is an array, else `undefined` to fall through to lodash's default merge.
 */
function arraysReplace(_destination: unknown, source: unknown): unknown {
  return Array.isArray(source) ? source : undefined
}

/**
 * Detach a variable table from its store.
 * @param variables - the stored table.
 * @returns a deep copy the caller may mutate freely.
 */
export function detach(variables: Variables): Variables {
  return cloneDeep(variables)
}

/**
 * Insert or overwrite: the incoming value wins.
 * @param current - the stored table (not mutated).
 * @param incoming - values to apply.
 * @returns a new table with `incoming` merged over `current`.
 */
export function insertOrAssign(current: Variables, incoming: Variables): Variables {
  return mergeWith(cloneDeep(current), incoming, arraysReplace) as Variables
}

/**
 * Insert only what is missing: an existing value wins.
 * @param current - the stored table (not mutated).
 * @param incoming - values to apply where nothing is set yet.
 * @returns a new table with `current` layered back over `incoming`.
 */
export function insertMissing(current: Variables, incoming: Variables): Variables {
  return mergeWith({}, incoming, current, arraysReplace) as Variables
}

/** Outcome of a deletion, matching Tavern Helper's return shape. */
export interface DeleteResult {
  variables: Variables
  delete_occurred: boolean
}

/**
 * Remove one path.
 * @param current - the stored table (not mutated).
 * @param path - lodash path to remove.
 * @returns the new table and whether anything was actually there.
 */
export function deletePath(current: Variables, path: string): DeleteResult {
  const variables = cloneDeep(current)
  // `_.unset` reports whether the property is gone afterwards, which is `true`
  // for a path that never existed — so existence has to be checked first.
  const delete_occurred = has(variables, path)
  if (delete_occurred) unset(variables, path)
  return { variables, delete_occurred }
}
