/**
 * How full the context window is, and what is filling it.
 *
 * Transcribed from deepseek-harness (MIT):
 * `packages/client/ui-conversation/src/client/context-occupancy.ts` gives
 * {@link contextOccupancy} its shape — one bounded reading, `null` until both
 * the numerator and the capacity are known — and
 * `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx` gives
 * {@link meterSegments} the rule its comment is about: the bar's **overall**
 * length is the exact occupancy, and the breakdown only proportions its
 * coloured parts, with a zero-width part dropped rather than drawn at the
 * hairline minimum. See `THIRD-PARTY-NOTICES.md`.
 *
 * What is Iris's own is the classification. The harness has three buckets
 * (system prompt, tools, conversation) because that is what its requests are
 * made of; a roleplay request is made of a preset, a card, world books, and
 * whatever the card's own scripts injected — so the categories here are the
 * assembly's own sources, read off the ids the host already mints.
 *
 * **The classification is a total function and it is deliberately not a
 * lookup table with a fallback.** `other` is reachable: an id in a dotted
 * namespace this table has never heard of lands there, which is what makes a
 * host-side addition show up as an unexplained slice instead of being filed
 * silently under the preset. An undotted id is a *preset identifier* — ST mints
 * UUIDs and the built-in marker names, neither of which carries a dot — so the
 * default for those is `preset`, and that is a reading of the vocabulary rather
 * than a shrug.
 *
 * @module iris-web/app/context-occupancy
 */

import type { PromptItemEntry, PromptItemization, TurnUsage } from '@iris/protocol'

import { billedInputTokens, formatCacheHitPercent } from './token-format.ts'

/**
 * Where one part of the prompt came from.
 *
 * Six, in bar order — largest-by-nature first, so the bar reads left to right
 * the way the numbers usually rank and a reader is not re-learning the order
 * on every conversation.
 */
export type ContextCategory
  = 'messages'
  | 'worldbook'
  | 'preset'
  | 'character'
  | 'script'
  | 'other'

/** The categories in bar and legend order. Both surfaces read this one array. */
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = [
  'messages',
  'worldbook',
  'preset',
  'character',
  'script',
  'other',
]

/**
 * The ids that are the card and the persona rather than the preset.
 *
 * Every one is a real id the host mints: the four marker slots
 * (`@iris/app-service/prompt.ts`'s marker table) and the three depth
 * contributions (`persona.depthPrompt`, `card.depthPrompt`, and
 * `personaDescription`'s in-prompt form). `dialogueExamples` counts as the card
 * because that is whose dialogue it is, even though the preset decides where
 * the slot sits.
 */
const CHARACTER_IDS: ReadonlySet<string> = new Set([
  'charDescription',
  'charPersonality',
  'scenario',
  'dialogueExamples',
  'personaDescription',
  'persona.depthPrompt',
  'card.depthPrompt',
])

/**
 * Which source one assembled part belongs to.
 *
 * Reads the **id**, not the label: the label is the preset's own `name` and a
 * user can type anything into it, while the id is minted by the host for every
 * contribution it makes itself and is the preset's `identifier` otherwise.
 * @param entry - one part of the itemization.
 * @returns its category; never undefined, and `other` is a real answer.
 */
export function categoryOf(entry: PromptItemEntry): ContextCategory {
  // The conversation is one aggregate row by contract (`AssembleResult.items`
  // says so and explains why), so the kind decides this one before any id does
  // — a future second history row must not be classified by name.
  if (entry.kind === 'history') return 'messages'
  const id = entry.id
  if (id.startsWith('script.')) return 'script'
  if (id === 'worldInfoBefore' || id === 'worldInfoAfter' || id.startsWith('worldInfo.')) {
    return 'worldbook'
  }
  if (CHARACTER_IDS.has(id)) return 'character'
  // No dot: a preset identifier. ST's own are the marker names (`main`, `nsfw`,
  // `jailbreak`, `enhanceDefinitions`) and UUIDs, and a UUID's separator is a
  // hyphen — so this covers the built-in sections and every custom prompt in
  // the list, which together are what "the preset" means to a reader.
  if (!id.includes('.')) return 'preset'
  return 'other'
}

/** One category's slice of an assembled prompt. */
export interface CategoryShare {
  category: ContextCategory
  tokens: number
  /** Fraction of the itemization's own total, 0–1. */
  share: number
}

/**
 * Fold the parts into the six categories.
 *
 * Every category is returned, including the empty ones, and in
 * {@link CONTEXT_CATEGORIES} order — a legend whose rows appear and disappear
 * with the conversation cannot be scanned, and 「0%」 against a named source is
 * itself an answer ("my world book is not reaching the prompt").
 * @param entries - the itemization's parts.
 * @param total - the itemization's reported total, used as the denominator.
 * @returns six rows, in bar order.
 */
export function categoryShares(
  entries: readonly PromptItemEntry[],
  total: number,
): CategoryShare[] {
  const sums = new Map<ContextCategory, number>(CONTEXT_CATEGORIES.map(name => [name, 0]))
  for (const entry of entries) {
    const category = categoryOf(entry)
    sums.set(category, (sums.get(category) ?? 0) + Math.max(0, entry.tokens))
  }
  return CONTEXT_CATEGORIES.map((category) => {
    const tokens = sums.get(category) ?? 0
    // Guarded rather than assumed, the same way `itemization.ts`'s `rowsFor`
    // guards: a zero total is a real answer for an empty chat, and dividing by
    // it would put NaN into every bar width.
    return { category, tokens, share: total > 0 ? tokens / total : 0 }
  })
}

/** A bounded reading of how full the window is. */
export interface ContextOccupancy {
  /** 0–100, rounded, and clamped at 100 so an over-budget prompt cannot draw past the track. */
  percent: number
  /** The estimate the host itemized. */
  usedTokens: number
  /** `context - reserve`: what the prompt was actually allowed to spend. */
  available: number
  /** True when the estimate exceeds the available budget — the clamp hid it. */
  over: boolean
  categories: CategoryShare[]
}

/**
 * Read one itemization as an occupancy.
 *
 * **Against `context - reserve`**, not against the window, because that is
 * what `itemization.ts`'s `budgetUse` already means by "available" and what
 * the prompt panel already prints — the reserve is held back for the reply, so
 * it was never the prompt's to spend, and two surfaces under the same composer
 * dividing by different denominators is the one thing this reading must not do.
 * @param itemization - the host's answer, record or preview.
 * @returns the reading, or `null` when there is no budget to divide by.
 */
export function contextOccupancy(
  itemization: PromptItemization | undefined,
): ContextOccupancy | null {
  if (itemization === undefined) return null
  const available = Math.max(0, itemization.budget.context - itemization.budget.reserve)
  if (available === 0) return null
  const usedTokens = Math.max(0, itemization.tokens)
  return {
    percent: Math.min(100, Math.round(usedTokens / available * 100)),
    usedTokens,
    available,
    over: usedTokens > available,
    categories: categoryShares(itemization.entries, itemization.tokens),
  }
}

/** One drawn part of the bar. */
export interface MeterSegment {
  category: ContextCategory
  /** Width as a percentage of the whole track. */
  width: number
}

/**
 * Proportion the bar's coloured parts inside the exact occupancy.
 *
 * Transcribed from the harness's `ContextMeter.tsx`, including the property its
 * comment is written for: the bar's overall length stays the **exact** percent
 * and the breakdown only divides that length, so a rounding difference between
 * the two cannot make the bar disagree with the number printed above it. A
 * zero-width part is dropped rather than drawn, because the `min-width` that
 * keeps a genuinely small part visible would otherwise paint a filled bar over
 * an empty context.
 * @param occupancy - the reading.
 * @returns the parts to draw, in bar order; empty when nothing is occupied.
 */
export function meterSegments(occupancy: ContextOccupancy): MeterSegment[] {
  const total = occupancy.categories.reduce((sum, row) => sum + row.tokens, 0)
  if (total === 0) return []
  return occupancy.categories
    .map(row => ({ category: row.category, width: occupancy.percent * row.tokens / total }))
    .filter(segment => segment.width > 0)
}

/**
 * The conversation's average cache-hit share.
 *
 * The harness's formula (`StatsLine.tsx`'s `cacheHitPercent`): cache reads over
 * the whole billed prompt side, summed across every generation the conversation
 * ever paid for — which is what `ChatView.usage` already is. Not an average of
 * per-turn percentages: those would weight a 200-token turn the same as a
 * 200 000-token one.
 *
 * `null` rather than `'0'` when the provider reported no cache bucket at all —
 * `token-format.ts` keeps "nothing was cached" and "the provider says nothing
 * about caching" apart, and so does this.
 * @param usage - the conversation's summed usage.
 * @returns the percentage text without a sign, or `null` when unknowable.
 */
export function averageCacheHit(usage: TurnUsage | undefined): string | null {
  if (usage === undefined || usage.cacheReadTokens === undefined) return null
  return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage))
}

/**
 * The share of this request a prefix cache could serve on the next turn.
 *
 * `PromptItemization.stablePrefixTokens` over the request's own total: the
 * *ceiling* this assembly leaves available. A different kind of number from
 * {@link averageCacheHit}, which is the provider's accounting of what actually
 * happened — the card shows both, they answer different questions ("is my
 * prompt shaped for the cache" against "did the cache serve me"), and neither
 * may be dressed as the other.
 *
 * `null` when the host sent no reading, which is **not** zero: "no reading" and
 * "nothing reusable" are different facts, and a `?? 0` here would print the
 * second whenever the first was true.
 * @param itemization - the host's answer, or absent.
 * @returns the tokens and the rounded share, or null.
 */
export function stablePrefix(
  itemization: PromptItemization | undefined,
): { tokens: number, percent: number } | null {
  if (itemization?.stablePrefixTokens === undefined) return null
  if (itemization.tokens <= 0) return null
  return {
    tokens: itemization.stablePrefixTokens,
    percent: Math.round(itemization.stablePrefixTokens / itemization.tokens * 100),
  }
}
