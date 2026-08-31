/**
 * Reading a prompt breakdown.
 *
 * Measured across six real presets against one real card, the largest single part
 * held between **23% and 92%** of the prompt. So there is no one shape to design
 * for: sometimes it is one column and a pile of rubble, sometimes fifty
 * comparable parts. (An earlier version of this comment said 66% as though it
 * were the rule; that came from a single sample.)
 *
 * What holds across both extremes is what this module does. Ordering by size
 * matters *more* in the flat case, not less — a 23% maximum spread over fifty
 * rows is exactly the distribution the eye cannot rank. And computing every
 * row's share is what lets a reader tell the two situations apart at all.
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
 * The parts that actually divide the prompt.
 *
 * A zero-token entry is real — 14 of one preset's 53 were zero, from markers with
 * nothing to fill them and enabled prompts with empty content — but it occupies
 * none of the prompt, so it has no place in a picture of how the prompt is
 * divided. Drawing it anyway, at the one-pixel minimum that protects genuinely
 * small parts, would claim it takes up space.
 *
 * It stays in the table, where its presence is the answer to "why is my X not
 * getting through".
 * @param entries - every entry.
 * @returns those with a nonzero cost.
 */
export function contributing(entries: readonly PromptItemEntry[]): PromptItemEntry[] {
  return entries.filter(entry => entry.tokens > 0)
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
