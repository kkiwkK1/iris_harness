/**
 * Token counts as a reader sees them, and the usage readings built out of them.
 *
 * Two audiences, two precisions. A glance wants `12.2K`; a reader who stopped
 * to hover wants every digit, because the number is a bill. So `formatTokens`
 * and `formatExactTokens` are both here and neither is the other's rounding.
 *
 * **The property this module exists to keep** is in `formatCacheHitPercent`: a
 * partial cache hit never displays as `100%`. `999/1000` rounds to 100 in one
 * step of ordinary arithmetic, and a reader shown `100%` will believe the whole
 * prompt was free — so a share that would round up to a full hit is re-rendered
 * at whatever precision keeps it honest (`99.9`), and only a genuinely complete
 * hit reads `100`. Everything else here is arithmetic in service of that.
 *
 * All of it is integer arithmetic on the provider's own counts. That is not
 * caution about doubles being wrong at these magnitudes — they are not — it is
 * so that the boundary cases (an exact half, a share one token short of full)
 * are decided by a rule written down here rather than by a float's last bit.
 *
 * The three formatters are transcribed from the deepseek harness's
 * `packages/client/ui-chat/src/client/chat/token-format.ts` (MIT; see
 * `THIRD-PARTY-NOTICES.md`). What is Iris's own: the locale seat is
 * `i18n/strings.ts` rather than a slot-passed `t`, and the `TurnUsage` readers
 * below, which have to cope with buckets the protocol leaves **absent** where
 * the harness's projection always had a number.
 *
 * @module iris-web/app/token-format
 */

import type { TurnUsage } from '@iris/protocol'

import type { Language } from './i18n/strings.ts'
import { translate } from './i18n/strings.ts'

/**
 * A token count fit to be printed.
 *
 * The counts come from a provider over the wire, so this module cannot assume
 * they are non-negative integers the way the harness's projection could: the
 * grouping walk below reads digits, and a fractional or infinite value would
 * make it print nonsense rather than fail. Clamped to a whole count instead,
 * and an unusable value reads as `0` — every caller already gates on a count
 * being above zero, so a broken figure drops the row rather than drawing a
 * wrong one.
 * @param value - the reported count.
 * @returns a non-negative safe integer.
 */
function countable(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M.
 *
 * One decimal below 100 of a unit and none above it, so the string stays about
 * as wide whatever the magnitude — this sits in a line that must not wrap.
 * @param value - a token count.
 * @param lang - the language the unit suffix is read in.
 * @returns the compact display string.
 */
export function formatTokens(value: number, lang: Language = 'en'): string {
  const count = countable(value)
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return translate(lang, 'tokensThousand', { value: scaled(count / 1_000) })
  return translate(lang, 'tokensMillion', { value: scaled(count / 1_000_000) })
}

/**
 * Exact integer token count, digits grouped in threes.
 *
 * Not `toLocaleString`: the separator is a copy decision that belongs in the
 * dictionary beside the words it sits among, and `Intl`'s answer for a language
 * is not the same question as what this interface prints.
 * @param value - a token count.
 * @param lang - the language the group separator is read from.
 * @returns the unrounded display string.
 */
export function formatExactTokens(value: number, lang: Language = 'en'): string {
  const digits = String(countable(value))
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  }
  return groups.join(translate(lang, 'thousandsSeparator'))
}

/**
 * Round a share to exact percentage units, ties away from zero.
 *
 * A binary search over the answer rather than a division: the threshold a
 * candidate has to clear is `(2c-1)·denominator / 2·scale`, and comparing
 * against it in integers — quotient plus a rounded-up remainder — decides an
 * exact half the same way every time, at any magnitude.
 * @param cacheReadTokens - the numerator.
 * @param denominator - the total the numerator is a share of; must be positive.
 * @param decimalPlaces - 0 for whole percent, 1 for tenths.
 * @returns the share in percentage units (percent, or tenths of a percent).
 */
function roundedPercentUnits(
  cacheReadTokens: number,
  denominator: number,
  decimalPlaces: 0 | 1,
): number {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

/**
 * Percentage units as text, dropping a trailing `.0`.
 * @param units - the value from `roundedPercentUnits`.
 * @param decimalPlaces - the precision those units are in.
 * @returns the number without its unit sign.
 */
function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${String(whole)}.${String(tenths)}`
}

/**
 * The cache-hit share, which never rounds a partial hit up to 100%.
 *
 * A full hit is the only thing that reads `100`. Anything short of it that
 * *would* round there gains decimals until it does not — `99.9`, `99.99`, and
 * so on — so the reader can tell "free" from "nearly free", which is the
 * difference the number is being consulted about.
 * @param cacheReadTokens - prompt tokens the cache served.
 * @param promptTokens - all billed prompt tokens, the cache's share included.
 * @param decimalPlaces - precision for an ordinary share; a near-full one
 * takes as many places as honesty needs regardless.
 * @returns the percentage without its sign, or `null` when nothing was billed
 * on the prompt side — a share of nothing is not `0%`, it is no share.
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  const served = countable(cacheReadTokens)
  const billed = countable(promptTokens)
  if (billed === 0) return null
  const missedInputTokens = billed - served
  if (missedInputTokens <= 0) return '100'

  const roundedUnits = roundedPercentUnits(served, billed, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)

  /*
   * The honest branch. The share rounds to a full hit at the asked-for
   * precision but is not one, so print the shortest `99.9…` that is still
   * above the real value: find how many places it takes for twice the missed
   * fraction to exceed one unit of the last place, then round the loss into
   * that last digit.
   */
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(billed / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = billed % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${String(10 - roundedLoss)}`
}

/**
 * Billed prompt tokens: the three prompt-side buckets, which are disjoint.
 *
 * `inputTokens` excludes what the cache served (`TurnUsage`'s own contract), so
 * the sum is the whole prompt side and not a double count. An absent bucket
 * contributes nothing, which is the only reading available: the provider did
 * not report it.
 * @param usage - one generation's usage, or a conversation's sum.
 * @returns the billed prompt tokens.
 */
export function billedInputTokens(usage: TurnUsage): number {
  return countable(usage.inputTokens)
    + countable(usage.cacheReadTokens ?? 0)
    + countable(usage.cacheWriteTokens ?? 0)
}

/**
 * Everything one generation cost.
 *
 * The provider's own total when it sent one — the protocol only carries
 * `totalTokens` where the provider's aggregate counters were exact and agreed —
 * and otherwise the sum of the buckets, which is what the buckets mean.
 * Reasoning is not added: it is part of the output it is reported inside.
 *
 * **One generation only**, which is why the parameter is not documented like
 * the others here. On `ChatView.usage` the host sums `totalTokens` over the
 * generations that *reported* one, so on a conversation whose providers were
 * mixed it is smaller than the buckets beside it and means "the totals we were
 * given, added up" (`@iris/protocol` `ChatView.usage` says so at length). A
 * conversation-level figure has to be added up from the buckets instead —
 * which is what `usageLineGroups` does, and the reason it does not call this.
 * @param usage - one generation's usage.
 * @returns the total tokens.
 */
export function totalTokens(usage: TurnUsage): number {
  return usage.totalTokens === undefined
    ? billedInputTokens(usage) + countable(usage.outputTokens)
    : countable(usage.totalTokens)
}

/**
 * The cache-hit share of a usage record, or `null` when there is none to state.
 *
 * **Absent is not zero.** A provider that says nothing about caching gets no
 * hit rate at all, rather than `0%` — the protocol keeps the bucket absent for
 * exactly this reason, and a `0%` would be Iris asserting something the
 * provider never reported.
 * @param usage - one generation's usage, or a conversation's sum.
 * @returns the percentage text, or `null`.
 */
export function cacheHitPercent(usage: TurnUsage): string | null {
  if (usage.cacheReadTokens === undefined) return null
  return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage))
}

/**
 * The composer line's groups: `Cache hit N%` and `Input X tok · Output Y tok`.
 *
 * Returned as a list rather than a string so the row can draw its own
 * separators, and empty rather than `['']` when there is nothing to say — the
 * caller renders no row at all in that case, which is what keeps the composer
 * from reserving a line of empty height before the first reply.
 *
 * Gated on real token activity, like the harness's line: a conversation whose
 * every request failed has a `usage` of zeros, and `Input 0 tok · Output 0 tok`
 * is noise dressed as information.
 * @param usage - the conversation's summed usage, absent until one generation
 * reported any.
 * @param lang - the language the groups are read in.
 * @returns the groups, in reading order.
 */
export function usageLineGroups(
  usage: TurnUsage | undefined,
  lang: Language = 'en',
): readonly string[] {
  if (usage === undefined) return []
  const input = billedInputTokens(usage)
  const output = countable(usage.outputTokens)
  if (input === 0 && output === 0) return []
  const groups: string[] = []
  const hit = cacheHitPercent(usage)
  if (hit !== null) groups.push(translate(lang, 'usageCacheHit', { percent: hit }))
  groups.push(translate(lang, 'usageTokens', {
    input: formatTokens(input, lang),
    output: formatTokens(output, lang),
  }))
  return groups
}

/**
 * The composer row's hover text: the visible line, plus the card share.
 *
 * The row's `title` used to be the visible line repeated, which costs a reader
 * nothing and tells them nothing either. It is now the one place the split by
 * source is stated, and the reason it is *only* here is the row's shape: it is
 * a single ellipsised line whose groups are already up to three, and a fourth
 * is the one that gets cut on a narrow composer.
 *
 * **The visible groups already include the card's requests** — they are summed
 * into `ChatView.usage` because they were billed to this conversation — so this
 * is a breakdown of the line above it and never an addition to it. A reader who
 * added the two would double-count, which is what the 「其中」 wording is for.
 * @param groups - the visible line's groups, from {@link usageLineGroups}.
 * @param script - the card share the host reported, absent when there is none.
 * @param lang - the language the text is read in.
 * @returns the hover text, or the empty string when the row is not drawn.
 */
export function usageLineTitle(
  groups: readonly string[],
  script: { turns: number, usage: TurnUsage } | undefined,
  lang: Language = 'en',
): string {
  if (groups.length === 0) return ''
  const line = groups.join(' | ')
  if (script === undefined) return line
  return `${line}\n${translate(lang, 'usageScriptShare', {
    n: script.turns,
    tokens: formatExactTokens(totalTokens(script.usage), lang),
  })}`
}

/**
 * The per-turn breakdown as plain text, one row per line.
 *
 * Plain text because this is a `title`: the harness shows the same rows in an
 * anchored dialog, and Iris does not have that dialog yet (`DEVIATIONS.md` 47).
 * The rows are the dialog's, in the dialog's order, so the day it arrives the
 * copy moves and nothing is rewritten. An absent bucket has no row — the same
 * rule as the hit rate, one layer out.
 * @param usage - one generation's usage.
 * @param lang - the language the rows are read in.
 * @returns the breakdown, newline-separated, heading first.
 */
export function usageDetailText(usage: TurnUsage, lang: Language = 'en'): string {
  const count = (value: number): string =>
    translate(lang, 'usageCount', { count: formatExactTokens(value, lang) })
  const rows: string[] = [translate(lang, 'usageTurnTitle')]
  const hit = cacheHitPercent(usage)
  if (hit !== null) rows.push(`${translate(lang, 'usageDetailCacheHit')} ${hit}%`)
  rows.push(`${translate(lang, 'usageDetailInput')} ${count(usage.inputTokens)}`)
  if (usage.cacheReadTokens !== undefined) {
    rows.push(`${translate(lang, 'usageDetailCacheRead')} ${count(usage.cacheReadTokens)}`)
  }
  if (usage.cacheWriteTokens !== undefined) {
    rows.push(`${translate(lang, 'usageDetailCacheWrite')} ${count(usage.cacheWriteTokens)}`)
  }
  const reasoning = usage.reasoningTokens === undefined
    ? ''
    : translate(lang, 'usageDetailReasoning', { tokens: count(usage.reasoningTokens) })
  rows.push(`${translate(lang, 'usageDetailOutput')} ${count(usage.outputTokens)}${reasoning}`)
  return rows.join('\n')
}
