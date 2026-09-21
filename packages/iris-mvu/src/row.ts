/**
 * The shape of one floor's variable table, as the two readers of MVU state
 * admit it.
 *
 * **Two predicates, because the two readers genuinely disagree.** The host's
 * own walks (which floor a turn inherits from) accept a table carrying
 * `stat_data` alone — that is the loosest reading that keeps old chats
 * working, and it is what `hasMvuState` states. MagVarUpdate's own baseline
 * walk, which runs inside the card's bundle, is stricter: it requires the row
 * to carry **both** `stat_data` and `schema`, and skips rows missing either.
 * A seed or migration that wrote only the first key therefore produced a chat
 * whose every round folded its commands onto nothing — measured on 黑兽
 * (2026-09-20): `replace` ops no-oped against the missing base and a panel
 * read empty strings for a whole conversation, while `add` ops (which create
 * their own path) were the only ones that ever landed.
 *
 * Anything that writes a floor's table must go through
 * {@link admissibleMvuSeed} (or otherwise guarantee both keys); anything that
 * reads a floor as a candidate baseline must say which contract it is
 * applying by importing the matching predicate from here rather than
 * re-declaring the shape locally.
 *
 * @module iris-mvu/row
 */

import type { MvuData } from './apply.ts'

/**
 * Whether a stored table is an MVU state tree by the host's reading:
 * it carries a `stat_data` tree.
 *
 * This is the **lenient** contract, and the one the host's own baseline walks
 * apply — a row written before the schema key was known still carries real
 * state, and refusing it would throw old chats' baselines away.
 * @param value - the candidate.
 * @returns true when it carries a `stat_data` tree.
 */
export function hasMvuState(value: unknown): value is MvuData {
  return typeof value === 'object' && value !== null && 'stat_data' in value
}

/**
 * Whether MagVarUpdate's own baseline walk would admit this row.
 *
 * The bundle requires `_.has(row, 'stat_data') && _.has(row, 'schema')` and
 * skips a floor missing either — silently, with no report anywhere. The
 * observability that keys off this (`plugins/mvu.ts`'s baseline note) is what
 * turns that silence into a sentence.
 * @param value - the candidate.
 * @returns true when both keys are present, which is the bundle's admission
 *   contract.
 */
export function bundleAdmitsMvuRow(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null
    && 'stat_data' in value && 'schema' in value
  )
}

/**
 * The seed shape for a floor's table: the declared tree plus the
 * admissibility key.
 *
 * `{}` because presence is the whole contract — the bundle derives the real
 * template from `stat_data` at its init and rewrites the key, and a
 * zod-managed card replaces it outright. Nothing in Iris computes an MVU
 * schema template of its own.
 * @param initial - the declared tree (`[InitVar]` folded in).
 * @returns the row to store, admissible to the bundle's baseline walk.
 */
export function admissibleMvuSeed(initial: MvuData): MvuData {
  return { ...initial, schema: {} }
}
