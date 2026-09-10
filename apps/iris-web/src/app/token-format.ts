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

import type { TurnGeneration, TurnUsage } from '@iris/protocol'

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
 * A duration fit to be divided by: finite, and strictly positive.
 *
 * Strict where {@link countable} is forgiving, because the two are used
 * differently. A mangled *count* is clamped to zero and its row is dropped; a
 * mangled or zero *duration* is a denominator, and letting one through
 * produces `Infinity` — a rate rendered as `∞ tok/s`, or worse, a large finite
 * number a reader would believe.
 * @param ms - a span in milliseconds.
 * @returns the span, or `undefined` when nothing may be divided by it.
 */
function divisible(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined
  return ms
}

/**
 * Seconds, to one decimal — the precision upstream's own timer prints
 * (`${seconds.toFixed(1)}s`, `public/script.js:2689`).
 *
 * A negative or unusable span reads as `0.0s` rather than being dropped here:
 * the callers below decide whether a row exists at all, and a formatter that
 * returned `null` would put that decision in two places.
 *
 * Rounded in **integer tenths of a second**, not by `(ms / 1000).toFixed(1)`,
 * and this is the module's own house rule rather than fussiness: `4050ms` is
 * `4.05` seconds, `4.05` is not representable, and `toFixed` therefore prints
 * `4.0` — a reader who checks the arithmetic finds it wrong by a tenth in the
 * one place they would think to look. Tenths are computed with a `+50`
 * half-up, so the boundary is decided by a rule written here instead of by a
 * float's last bit.
 * @param ms - a span in milliseconds.
 * @param lang - the language the unit is read from.
 * @returns the display string, unit included.
 */
export function formatSeconds(ms: number, lang: Language = 'en'): string {
  const safe = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
  const tenths = Math.floor((safe + 50) / 100)
  const value = `${String(Math.floor(tenths / 10))}.${String(tenths % 10)}`
  return translate(lang, 'usageSeconds', { value })
}

/**
 * A token rate, to one decimal at ten and above and two below.
 *
 * The band matters more than the digits: a local 7B streams at three figures
 * and a hosted reasoning model at single ones, and the same number of decimals
 * across that range either prints noise (`312.47 tok/s`) or loses the whole
 * distinction between `4.2` and `4.8`. Upstream prints three decimals at every
 * magnitude (`toFixed(3)`, `public/script.js:2697`); that is a tooltip nobody
 * reads at a glance, and this one sits in a line beside the reply.
 *
 * Fixed decimals rather than a trimmed `.0`, unlike the cache share above:
 * this string is in a row that must not wrap and beside a token total, so a
 * stable width is worth a redundant zero on the rare round rate.
 * @param tokensPerSecond - the rate.
 * @param lang - the language the unit is read from.
 * @returns the display string, unit included.
 */
export function formatRate(tokensPerSecond: number, lang: Language = 'en'): string {
  const safe = Number.isFinite(tokensPerSecond) ? Math.max(0, tokensPerSecond) : 0
  return translate(lang, 'usageRate', { value: safe.toFixed(safe >= 10 ? 1 : 2) })
}

/**
 * **Upstream's token rate**: the output the provider counted over the whole
 * generation window.
 *
 * `outputTokens / (durationMs / 1000)`, which is `formatGenerationTimer`'s
 * `tokenCount / seconds` where `seconds` is `gen_finished - gen_started`
 * (`public/script.js:2688`-`:2697`) — the queue, the first connection and the
 * decode all inside it. Iris divides a different numerator into the same
 * denominator: the provider's reported `outputTokens` instead of upstream's own
 * tokenizer estimate of the reply text (`DEVIATIONS.md` §47 for the general
 * departure, §92 for this row). Same definition, better numerator; the two
 * hosts' numbers are comparable.
 *
 * `undefined` rather than `0` when there is nothing to divide: a generation
 * with no reported output, or one the host clocked at under a millisecond, has
 * no rate — and `0 tok/s` beside a reply full of text is a claim about the
 * provider that nothing measured.
 * @param usage - the generation's cost, for its output count.
 * @param generation - the generation's timing.
 * @returns tokens per second, or `undefined`.
 */
export function tokenRate(usage: TurnUsage, generation: TurnGeneration): number | undefined {
  const output = countable(usage.outputTokens)
  const ms = divisible(generation.durationMs)
  if (output === 0 || ms === undefined) return undefined
  return output * 1_000 / ms
}

/**
 * **Iris's own addition**: the same tokens over the time after the first one
 * arrived.
 *
 * `outputTokens / ((durationMs - firstTokenMs) / 1000)`. Upstream has no such
 * figure, and it answers the question the whole-window rate cannot: whether a
 * slow reply was a slow *model* or a slow start. A minute of queueing in front
 * of a fast decode and a fast start in front of a slow one produce the same
 * `Token rate` and very different experiences of the same provider.
 *
 * Only where the first token's moment is known **and positive**, which is why
 * this is a separate function rather than a branch inside the one above: with
 * no time-to-first-token there is no decode window to speak of, and a
 * `firstTokenMs` of `0` would make this row a duplicate of the row above it
 * wearing a different name.
 * @param usage - the generation's cost, for its output count.
 * @param generation - the generation's timing.
 * @returns tokens per second after the first token, or `undefined`.
 */
export function decodeRate(usage: TurnUsage, generation: TurnGeneration): number | undefined {
  const output = countable(usage.outputTokens)
  const firstToken = divisible(generation.firstTokenMs)
  if (output === 0 || firstToken === undefined) return undefined
  const ms = divisible(generation.durationMs - firstToken)
  if (ms === undefined) return undefined
  return output * 1_000 / ms
}

/**
 * One label/value row of a usage reading.
 *
 * The usage hover cards render these as a two-column `<dl>`; the composer's
 * one-line strip renders the same rows flattened into text. One construction,
 * so a wording change cannot move one surface and leave the other behind —
 * the drift a plain-text copy beside a card once invited.
 */
export interface UsageDetailRow {
  label: string
  value: string
}

/**
 * The per-turn breakdown rows, in the anchored dialog's order.
 *
 * The order is the harness's (`packages/client/ui-chat`'s usage dialog, which
 * shows the same reading for the same kind of turn): cache share first, then
 * the prompt side in billing order, then output — with the reasoning note
 * riding the output row, because reasoning is part of the output it is
 * reported inside, not a fourth bucket beside it. An absent bucket has no row
 * — the same rule as the hit rate, one layer out.
 *
 * Exact digits, not the compact ones the chip prints: the chip is a glance and
 * the card is the bill, and a reader who stopped to hover is being charged.
 * @param usage - one generation's usage.
 * @param lang - the language the rows are read in.
 * @returns the rows, in reading order; the card's heading is the caller's.
 */
function turnDetailRows(usage: TurnUsage, lang: Language, generation?: TurnGeneration): UsageDetailRow[] {
  const count = (value: number): string =>
    translate(lang, 'usageCount', { count: formatExactTokens(value, lang) })
  const rows: UsageDetailRow[] = []
  const hit = cacheHitPercent(usage)
  if (hit !== null) rows.push({ label: translate(lang, 'usageDetailCacheHit'), value: `${hit}%` })
  rows.push({ label: translate(lang, 'usageDetailInput'), value: count(usage.inputTokens) })
  if (usage.cacheReadTokens !== undefined) {
    rows.push({ label: translate(lang, 'usageDetailCacheRead'), value: count(usage.cacheReadTokens) })
  }
  if (usage.cacheWriteTokens !== undefined) {
    rows.push({ label: translate(lang, 'usageDetailCacheWrite'), value: count(usage.cacheWriteTokens) })
  }
  const reasoning = usage.reasoningTokens === undefined
    ? ''
    : translate(lang, 'usageDetailReasoning', { tokens: count(usage.reasoningTokens) })
  rows.push({
    label: translate(lang, 'usageDetailOutput'),
    value: `${count(usage.outputTokens)}${reasoning}`,
  })
  if (generation === undefined) return rows

  /*
   * The timing rows, after the token rows and never mixed into them: these are
   * a *different measurement by a different measurer* — the host's own clock
   * against the provider's own counters — and a reader has to be able to see
   * which half of the table came from where. The order is upstream's tooltip
   * order (`formatGenerationTimer`, `public/script.js:2691`-`:2697`): how long,
   * how long to the first token, how long thinking, then the rate.
   */
  rows.push({
    label: translate(lang, 'usageDetailDuration'),
    value: formatSeconds(generation.durationMs, lang),
  })
  if (generation.firstTokenMs !== undefined) {
    rows.push({
      label: translate(lang, 'usageDetailFirstToken'),
      value: formatSeconds(generation.firstTokenMs, lang),
    })
  }
  // Upstream's own gate: `reasoningDuration > 0 ? … : ''`. A model that emitted
  // no reasoning has no `reasoningMs` at all, and one whose thinking landed
  // inside the same millisecond as the request has nothing to report either —
  // "thought for 0.0s" is a sentence about a measurement that did not resolve.
  if (generation.reasoningMs !== undefined && generation.reasoningMs > 0) {
    rows.push({
      label: translate(lang, 'usageDetailThinking'),
      value: formatSeconds(generation.reasoningMs, lang),
    })
  }
  const overall = tokenRate(usage, generation)
  if (overall !== undefined) {
    rows.push({ label: translate(lang, 'usageDetailRate'), value: formatRate(overall, lang) })
  }
  // Last, and only when there is a first-token moment to subtract: it is the
  // one row here upstream has no counterpart for, so it reads as an addition to
  // a familiar table rather than as a disagreement inside it.
  const decode = decodeRate(usage, generation)
  if (decode !== undefined) {
    rows.push({ label: translate(lang, 'usageDetailDecodeRate'), value: formatRate(decode, lang) })
  }
  return rows
}

/**
 * The per-turn breakdown as rows, for the hover card on a reply's usage chip.
 *
 * This is the only shape the breakdown takes: the plain-text assembly is gone,
 * because the card that replaces the native `title` reads these rows directly
 * (`UsagePopover`, `DEVIATIONS.md` 47), and there is no second rendering left
 * to keep in step.
 * The timing rows ride the same call, when the host measured any: they belong
 * to the same generation and the same hover card, and a second builder for them
 * would be a second place for the order and the wording to drift — the drift
 * this function's own history is a record of.
 * @param usage - one generation's usage.
 * @param lang - the language the rows are read in.
 * @param generation - how long it took, when the host measured it. Absent for
 * an imported floor, for a generation older than the measurement, and for every
 * reading but the one a reloaded chat file was showing.
 * @returns the rows, in reading order.
 */
export function usageDetailRows(
  usage: TurnUsage,
  lang: Language = 'en',
  generation?: TurnGeneration,
): readonly UsageDetailRow[] {
  return turnDetailRows(usage, lang, generation)
}

/**
 * The chip a reply's action row shows: what the turn cost, and how fast it
 * arrived when the host clocked it.
 *
 * Here rather than in `app/Message.tsx` because the choice between the two
 * wordings **is** a formatting decision — it turns on whether the rate resolves
 * to a number, which only this module knows how to ask — and because the
 * component would then be the second place that knows a rate needs a positive
 * duration under it.
 *
 * The rate is the whole-window one, upstream's definition, so the chip's figure
 * is the figure SillyTavern would print for the same reply; the decode rate
 * stays inside the hover card, where its label can say what it is.
 * @param usage - one generation's cost.
 * @param generation - how long it took, when the host measured it.
 * @param lang - the language the chip is read in.
 * @returns the chip's text.
 */
export function usageChipText(
  usage: TurnUsage,
  generation: TurnGeneration | undefined,
  lang: Language = 'en',
): string {
  const total = formatTokens(totalTokens(usage), lang)
  const rate = generation === undefined ? undefined : tokenRate(usage, generation)
  if (rate === undefined) return translate(lang, 'usageTurn', { total })
  return translate(lang, 'usageTurnRate', { total, rate: formatRate(rate, lang) })
}

/**
 * The conversation's total, as rows before they are shaped for a surface.
 *
 * The same figures the composer's strip prints — cache share, then the two
 * sides of the bill — built once here so the strip and the strip's hover card
 * cannot disagree about either number or word. The prompt side is
 * `billedInputTokens`, the three disjoint buckets added, and never
 * `totalTokens`: the protocol's summed total covers only the generations that
 * reported one, which on a mixed-provider conversation is smaller than the
 * buckets beside it.
 *
 * Gated on real token activity, like the harness's line: a conversation whose
 * every request failed has a `usage` of zeros, and `Input 0 tok · Output 0 tok`
 * is noise dressed as information.
 * @param usage - the conversation's summed usage, absent until one generation
 * reported any.
 * @param lang - the language the rows are read in.
 * @returns the three rows, the cache one omitted when the provider is silent;
 * `undefined` when there is nothing to say at all.
 */
function conversationRows(
  usage: TurnUsage | undefined,
  lang: Language,
): { hit: UsageDetailRow | undefined, input: UsageDetailRow, output: UsageDetailRow } | undefined {
  if (usage === undefined) return undefined
  const input = billedInputTokens(usage)
  const output = countable(usage.outputTokens)
  if (input === 0 && output === 0) return undefined
  const compact = (value: number): string =>
    translate(lang, 'usageCount', { count: formatTokens(value, lang) })
  const hit = cacheHitPercent(usage)
  return {
    hit: hit === null
      ? undefined
      : { label: translate(lang, 'usageDetailCacheHit'), value: `${hit}%` },
    input: { label: translate(lang, 'usageSummaryInput'), value: compact(input) },
    output: { label: translate(lang, 'usageDetailOutput'), value: compact(output) },
  }
}

/**
 * The conversation's total as rows, for the hover card on the composer's strip.
 * @param usage - the conversation's summed usage, absent until one generation
 * reported any.
 * @param lang - the language the rows are read in.
 * @returns the rows, in reading order.
 */
export function usageSummaryRows(
  usage: TurnUsage | undefined,
  lang: Language = 'en',
): readonly UsageDetailRow[] {
  const rows = conversationRows(usage, lang)
  if (rows === undefined) return []
  return [...(rows.hit === undefined ? [] : [rows.hit]), rows.input, rows.output]
}

/**
 * The composer line's groups: `Cache hit N%` and `Input X tok · Output Y tok`.
 *
 * The flattened shape of {@link usageSummaryRows} — the same rows, joined for
 * a line that must not wrap — and empty rather than `['']` when there is
 * nothing to say. The caller renders no row at all in that case, which is what
 * keeps the composer from reserving a line of empty height before the first
 * reply.
 * @param usage - the conversation's summed usage, absent until one generation
 * reported any.
 * @param lang - the language the groups are read in.
 * @returns the groups, in reading order.
 */
export function usageLineGroups(
  usage: TurnUsage | undefined,
  lang: Language = 'en',
): readonly string[] {
  const rows = conversationRows(usage, lang)
  if (rows === undefined) return []
  const groups: string[] = []
  if (rows.hit !== undefined) groups.push(`${rows.hit.label} ${rows.hit.value}`)
  groups.push(`${rows.input.label} ${rows.input.value} · ${rows.output.label} ${rows.output.value}`)
  return groups
}

/**
 * The summary card's notes: one sentence per share of this conversation's cost
 * that was **not a turn** — the card scripts' requests, and the host's own
 * compaction summaries.
 *
 * The composer's visible line already counts both — they are summed into
 * `ChatView.usage` because they were billed to this conversation — so these
 * notes are a breakdown of the figures above them, never an addition to them.
 *
 * **An array rather than one joined sentence.** The two shares are
 * independently absent, so a single string would need a separator whose
 * spelling differs per language and which would sit between two clauses that
 * already use `·` inside themselves. Separate sentences also let the card draw
 * each as its own paragraph, which is what it does.
 * @param script - the card share the host reported, absent when there is none.
 * @param compaction - the compaction share, same rule.
 * @param lang - the language the sentences are read in.
 * @returns the sentences present, in that order; empty when there are none.
 */
export function usageSideShareSentences(
  script: { turns: number, usage: TurnUsage } | undefined,
  compaction: { turns: number, usage: TurnUsage } | undefined,
  lang: Language = 'en',
): readonly string[] {
  return [
    ...script === undefined ? [] : [translate(lang, 'usageScriptShare', {
      n: script.turns,
      tokens: formatExactTokens(totalTokens(script.usage), lang),
    })],
    ...compaction === undefined ? [] : [translate(lang, 'usageCompactionShare', {
      n: compaction.turns,
      tokens: formatExactTokens(totalTokens(compaction.usage), lang),
    })],
  ]
}
