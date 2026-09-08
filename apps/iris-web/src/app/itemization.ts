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

import type { PromptItemEntry, PromptItemization, PromptItemMember } from '@iris/protocol'

/** How the rows are ordered. */
export type ItemOrder = 'size' | 'assembly'

/** One row, with what the panel needs that the contract does not carry. */
export interface ItemRow {
  entry: PromptItemEntry
  /** Fraction of the total, 0–1. */
  share: number
  /**
   * One-based position in the host's own list, and its length.
   *
   * The host sends entries in **contribution** order — the order the preset and
   * the card asked for. Both display orders reshuffle that, so a row moved by
   * the cache-friendly reorder has to be able to say where it came from, and
   * "row 8 of 41" is the only form of that a reader can use: the ids are UUIDs
   * and the orders are internal numbers.
   */
  origin: { at: number, total: number }
}

/**
 * Where in the request a row is actually sent, as a sort rank.
 *
 * Coarse on purpose — three phases, not a message index. The host's breakdown
 * has one aggregate row for the whole conversation, so there is no finer
 * position to be had, and a rank that pretended otherwise would be a number the
 * contract cannot support.
 * @param entry - the row.
 * @returns 0 for promoted, 1 for in place, 2 for deferred.
 */
function phaseOf(entry: PromptItemEntry): number {
  if (entry.promoted === true) return 0
  if (entry.deferred === true) return 2
  return 1
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
 * Ties keep the host's order, so a re-render cannot reshuffle equal rows.
 *
 * **`assembly` is no longer the host's order verbatim.** With
 * `GenerationSettings.cacheFriendly` on, a `deferred` row is sent after the
 * whole conversation and a `promoted` one before it, neither from where it sits
 * in the list — so this order groups the rows into those three phases. The
 * host's list stays contribution order (that is the reading the *other* button
 * wants, and `origin` preserves it either way); making the assembly view agree
 * with the request is the whole point of its name.
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
    origin: { at: at + 1, total: entries.length },
  }))

  if (order === 'size') {
    rows.sort((left, right) => right.entry.tokens - left.entry.tokens || left.at - right.at)
  } else {
    // Three phases, in the order the request carries them: promoted rows first
    // (they are sent ahead of the conversation), then everything in its own
    // place, then deferred rows (sent after it). Within a phase the host's
    // order stands, so a re-render cannot reshuffle anything.
    rows.sort((left, right) => phaseOf(left.entry) - phaseOf(right.entry) || left.at - right.at)
  }

  return rows.map(({ entry, share, origin }) => ({ entry, share, origin }))
}

/**
 * The entries of a split row worth showing under it, or none.
 *
 * A world-info depth bucket is **one** row here and several entries in the
 * request. When the host classified those entries separately and they went
 * different ways, the row above carries no badge at all — no single mark is
 * true of it — so the answer has to appear per entry, or the panel goes silent
 * about the largest row it has.
 *
 * **Empty unless at least one entry actually moved**, and that is the decision
 * this function exists to hold. A bucket that was split and stayed put is the
 * ordinary case, and five unmarked sub-rows under it would bury the rows that
 * did move. Once one entry has moved the *whole* list is shown, the unmoved
 * ones included: "these two went forward and this one stayed" is the reading,
 * and a list of only the movers cannot express its second half.
 *
 * A pure function rather than a condition inside the JSX so that it can be
 * asserted directly. A source-text check ("the panel mentions `members`")
 * cannot tell reading the field from naming it — measured: one stayed green
 * with the whole sub-list disabled.
 * @param entry - one itemization row.
 * @returns the entries to render beneath it, in the host's order; empty when
 *   there is nothing to say.
 */
export function splitMembers(entry: PromptItemEntry): PromptItemMember[] {
  const members = entry.members ?? []
  const moved = members.some(member => member.deferred === true || member.promoted === true)
  return moved ? [...members] : []
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
