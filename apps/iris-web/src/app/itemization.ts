/**
 * Reading a prompt breakdown.
 *
 * One measurement decided this module's shape: on a real preset and card, 1920 of
 * 2929 prompt tokens — 66% — were a single world-info injection. So an
 * itemization is not a list of comparable parts, it is **one column and a pile of
 * rubble**, and a panel that sorts by assembly order shows a wall of two-token
 * rows with the answer somewhere in the middle of it.
 *
 * Hence a default order by size, and hence the share of the total being computed
 * for every row rather than left to the eye.
 *
 * @module iris-web/app/itemization
 */

import type { PromptItemEntry, PromptItemization } from '@iris/protocol'

/** How the rows are ordered. */
export type ItemOrder = 'size' | 'assembly'

/** One row, with what the panel needs that the contract does not carry. */
export interface ItemRow {
  entry: PromptItemEntry
  /** Fraction of the total, 0–1. */
  share: number
}

/**
 * Order the entries for display.
 *
 * `size` answers "what is eating my context", which is the question the panel
 * exists for. `assembly` answers "is my preset ordered the way I think", which is
 * a different and rarer question — kept because the contract's order *is* the
 * assembly order and discarding it would throw away information the host went to
 * the trouble of preserving.
 *
 * Ties keep assembly order, so a re-render cannot reshuffle equal rows.
 * @param entries - the entries as the host sent them.
 * @param order - the chosen order.
 * @param total - the reported total, used for each row's share.
 * @returns rows ready to render.
 */
export function rowsFor(
  entries: readonly PromptItemEntry[],
  order: ItemOrder,
  total: number,
): ItemRow[] {
  const rows = entries.map((entry, at) => ({
    entry,
    at,
    // Guarded rather than assumed: a zero total is a real answer for an empty
    // chat, and dividing by it would put NaN into every bar width.
    share: total > 0 ? entry.tokens / total : 0,
  }))

  if (order === 'size') {
    rows.sort((left, right) => right.entry.tokens - left.entry.tokens || left.at - right.at)
  }

  return rows.map(({ entry, share }) => ({ entry, share }))
}

/**
 * Check the breakdown against its own total.
 *
 * The contract says the entries sum to `tokens` and the host has a test to that
 * effect. This checks anyway, and not from distrust: a breakdown that does not
 * add up is worse than no breakdown, because every number in it still looks
 * authoritative. If the two ever disagree the panel says so instead of drawing
 * bars against a total that is not the sum of them.
 * @param itemization - the host's answer.
 * @returns the discrepancy, or undefined when it adds up.
 */
export function discrepancy(itemization: PromptItemization): number | undefined {
  const summed = itemization.entries.reduce((sum, entry) => sum + entry.tokens, 0)
  return summed === itemization.tokens ? undefined : summed - itemization.tokens
}

/**
 * How much of the context window this prompt is using.
 *
 * Against `context - reserve` rather than `context`: the reserve is set aside for
 * the reply, so it was never available to the prompt and counting it would make
 * a request that is about to be truncated look comfortable.
 * @param itemization - the host's answer.
 * @returns the available budget and the fraction used, 0–1 and possibly above 1.
 */
export function budgetUse(itemization: PromptItemization): { available: number, used: number } {
  const available = Math.max(0, itemization.budget.context - itemization.budget.reserve)
  return { available, used: available > 0 ? itemization.tokens / available : 0 }
}

/**
 * What to tell the reader about which mode they are looking at.
 *
 * Three states, not two. A preview that was *asked for* is normal; a preview that
 * arrived because a record had expired is a different fact, and the contract
 * makes it visible precisely so the panel can say "the record is gone" rather
 * than showing a blank or an error. The host cannot distinguish these — only the
 * caller knows what it asked for.
 * @param itemization - the host's answer.
 * @param requestedTurn - the turn the caller asked about, or undefined for a preview.
 * @returns a state the panel can switch on.
 */
export function itemizationMode(
  itemization: PromptItemization,
  requestedTurn: number | undefined,
): 'record' | 'preview' | 'expired' {
  if (!itemization.preview) return 'record'
  return requestedTurn === undefined ? 'preview' : 'expired'
}
