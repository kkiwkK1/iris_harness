/**
 * Reading a `PromptDivergence`.
 *
 * The protocol carries byte counts and no percentages, deliberately: a share of
 * two requests has two defensible denominators — the newer body or the older one
 * — and baking one into the wire would settle that where nobody can see it. So
 * the ratio is chosen here, once, with the reason written down, and both the
 * capacity card and the prompt panel read it from this module rather than each
 * dividing for itself.
 *
 * **The denominator is the newer body.** A provider's cache serves a prefix of
 * *this* request, so "what fraction of this request could have been served" is
 * `divergedAt / bytes`. `CACHE-PREFIX.md` §1.2 computes its 上界命中率 column the
 * same way — 28 209 shared of 34 563 sent reads 81.6%, not the 83.2% the older
 * body would give — so the number this shows is comparable with the numbers
 * already written down.
 *
 * @module iris-web/app/divergence
 */

import {
  HISTORY_ITEM_PREFIX,
  providerExcuse,
  type PromptDivergence,
  type PromptDivergenceItem,
} from '@iris/protocol'

// Re-exported so this module is the one import a presenter needs, while the rule
// itself lives in the shared vocabulary — the offline report draws the same line
// and must not draw its own.
export { providerExcuse } from '@iris/protocol'

/**
 * The share of the newer request a perfect cache could have served.
 * @param divergence - the comparison.
 * @returns 0–1.
 */
export function cacheCeiling(divergence: PromptDivergence): number {
  if (divergence.bytes === 0) return 0
  return divergence.divergedAt / divergence.bytes
}

/**
 * The share the provider actually served, when it said anything.
 *
 * Tokens over billed tokens — `inputTokens` excludes what the cache served, so
 * the billed total is the sum, which is the same arithmetic `token-format.ts`'s
 * `billedInputTokens` does for the usage line. `null` when the provider reported
 * nothing: "nothing was cached" and "this provider does not report caching" are
 * different facts and a zero would merge them.
 * @param divergence - the comparison.
 * @returns 0–1, or null when there is nothing to report.
 */
export function providerShare(divergence: PromptDivergence): number | null {
  const served = divergence.cacheReadTokens
  if (served === undefined) return null
  const billed = served + (divergence.inputTokens ?? 0)
  if (billed === 0) return 0
  return served / billed
}

/**
 * Whether the provider served materially less than the bytes allowed, with no
 * ordinary reason for it.
 *
 * The judgement the whole record exists to support. Three turns of the user's
 * own corpus reported `cacheReadTokens: 0` with no way to tell "we changed the
 * prompt" from "the provider did not serve it"; this is that test, and one pair
 * in the corpus — `OVERLORD-沙盒` line 3 → line 5, measured 2026-09-08 — has a
 * byte-identical prefix and reports zero.
 *
 * **{@link providerExcuse} is checked first**, and that ordering is the point: a
 * cold start, an expired entry and a model switch all produce a shortfall that
 * is nobody's defect, and reporting those as findings would spend the reader's
 * attention on three false alarms before the real one.
 *
 * **The threshold is coarse on purpose.** The ceiling is a share of bytes and
 * the provider's figure is a share of tokens; the bytes-per-token ratio of CJK
 * prose is not that of the JSON framing around it, so the two agree in magnitude
 * and not in the last digit. A gap of a fifth of the request is far outside that
 * slack; anything tighter would be reporting the unit mismatch as a finding.
 * @param divergence - the comparison.
 * @returns true when the gap is too large to be the unit difference and nothing
 *   ordinary explains it.
 */
export function providerFellShort(divergence: PromptDivergence): boolean {
  if (providerExcuse(divergence) !== null) return false
  const actual = providerShare(divergence)
  if (actual === null) return false
  return cacheCeiling(divergence) - actual > 0.2
}

/**
 * What to call one part on screen.
 *
 * A floor's id is `history.6`, which is machine-facing; every other part carries
 * a label its author wrote. So this is a translation of the one generated shape
 * and a pass-through for everything else — and the caller supplies the wording,
 * because the words belong in the dictionary.
 * @param item - the part.
 * @param floorLabel - renders a floor's number into words.
 * @returns the display name.
 */
export function itemName(
  item: Pick<PromptDivergenceItem, 'id' | 'label' | 'kind'>,
  floorLabel: (floor: string) => string,
): string {
  if (!item.id.startsWith(HISTORY_ITEM_PREFIX)) return item.label
  return floorLabel(item.id.slice(HISTORY_ITEM_PREFIX.length))
}

/**
 * The parts of the newer request that could not be served, worst first.
 *
 * Ordered by unserved bytes rather than by size, because that is the order the
 * question is asked in: the reader wants to know what this turn paid for, and
 * the largest part of the request is routinely the one that was fully cached.
 * Parts that cost nothing this turn — fully cached, or gone — are dropped: a
 * list of everything buries the answer under the sections that behaved.
 * @param divergence - the comparison.
 * @returns the parts with unserved bytes, descending.
 */
export function unservedItems(divergence: PromptDivergence): PromptDivergenceItem[] {
  return divergence.items
    .filter(item => item.uncachedBytes > 0)
    .sort((left, right) => right.uncachedBytes - left.uncachedBytes)
}

/**
 * Index the comparison by part id, for annotating another list.
 * @param divergence - the comparison, or absent.
 * @returns a lookup, empty when there is no comparison.
 */
export function itemsById(divergence: PromptDivergence | undefined): Map<string, PromptDivergenceItem> {
  return new Map((divergence?.items ?? []).map(item => [item.id, item]))
}
