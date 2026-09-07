/**
 * Everything the usage page computes before it draws anything.
 *
 * The page shows one line per model over time, and every number on it is
 * arithmetic over `UsageTotals` — the host's aggregate, whose buckets are the
 * protocol's disjoint ones. So the arithmetic lives here, in one module with no
 * React and no DOM, and the page is left with markup. That split is not tidiness:
 * a chart is the surface where a wrong number is least visible, because a line
 * drawn from a bad sum still looks like a line.
 *
 * **The definitions, once, because the words are slippery.** The three
 * prompt-side buckets are disjoint (`@iris/protocol` `TurnUsage` says so and
 * `token-format.ts` restates it):
 *
 * - **uncached / cache miss** is `UsageTotals.cacheMiss`, the host's sum of
 *   `TurnUsage.inputTokens`. The adapter derives it as `prompt_tokens -
 *   cached_tokens` (`@iris/llm-openai-compat`'s `mapUsage`), and DeepSeek
 *   documents `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`
 *   — so on a DeepSeek route this figure *is* `prompt_cache_miss_tokens`. This
 *   is the number the user's request calls 「未缓存命中消耗」.
 * - **cache hit** is `cacheRead`, what the cache served: 「缓存命中消耗」.
 * - **billed prompt** is the three of them added ({@link billedPrompt}); it is
 *   what the composer line already calls "input".
 * - **total** is billed prompt plus `output` ({@link totalTokens}). Reasoning is
 *   NOT added: the provider reports it as the reasoning share of the completion
 *   it is already inside, so adding it bills the same tokens twice.
 *
 * **The hit rate is over `cachePrompt`, never over `billedPrompt`.** Those are
 * different denominators and the difference is the whole reason the host sends
 * both: `cachePrompt` covers only the generations that reported a cache bucket,
 * so a route that says nothing about caching cannot dilute one that does. A
 * summary whose `cacheTurns` is `0` has no hit rate at all rather than a hit
 * rate of zero.
 *
 * The formatters are `./token-format.ts`'s, which are the deepseek harness's
 * (MIT); nothing here re-implements one. The colour and geometry halves below
 * have no counterpart in the harness — it has no usage chart — and are Iris's
 * own.
 *
 * @module iris-web/app/usage-stats
 */

import type { UsageBucket, UsageGranularity, UsageTotals } from '@iris/protocol'

import { formatCacheHitPercent } from './token-format.ts'

/** Which figure the chart's lines draw. */
export type UsageMetric = 'total' | 'cacheRead' | 'cacheMiss' | 'output'

/** Every metric, in the order the switch offers them. */
export const USAGE_METRICS: readonly UsageMetric[] = ['total', 'cacheRead', 'cacheMiss', 'output']

/**
 * Billed prompt tokens: the three disjoint prompt-side buckets.
 *
 * An absent optional bucket contributes nothing, which is the only reading
 * available — the provider did not report it. The same sum
 * `token-format.ts`'s `billedInputTokens` takes over one generation, one
 * aggregation layer out.
 * @param totals - a bucket, a conversation subtotal, or the whole range.
 * @returns the billed prompt tokens.
 */
export function billedPrompt(totals: UsageTotals): number {
  return totals.cacheMiss + (totals.cacheRead ?? 0) + (totals.cacheWrite ?? 0)
}

/**
 * Everything these generations cost.
 *
 * Deliberately added from the buckets rather than read from any stored total:
 * `TurnUsage.totalTokens` is summed only over the generations that carried an
 * exact one, so on a range that mixed providers it comes out *smaller* than the
 * buckets beside it — which is why the protocol drops it from every aggregate
 * and why `UsageTotals` has no `total` field to be tempted by.
 * @param totals - a bucket, a conversation subtotal, or the whole range.
 * @returns billed prompt plus output.
 */
export function totalTokens(totals: UsageTotals): number {
  return billedPrompt(totals) + totals.output
}

/**
 * One metric's value.
 *
 * `cacheRead` reads `0` where the bucket is absent, and that is a display
 * choice with a limit: a *point on a line* has to be a number, and a line that
 * skipped the buckets where no provider mentioned caching would imply the
 * spend was zero there rather than unstated. The honest half of the same fact
 * is {@link hitRate}, which refuses to state a share at all — so the chart can
 * draw a floor while the figure beside it says nothing, which is the accurate
 * pair.
 * @param totals - the cell.
 * @param metric - which figure.
 * @returns the value, in tokens.
 */
export function metricValue(totals: UsageTotals, metric: UsageMetric): number {
  switch (metric) {
    case 'total': return totalTokens(totals)
    case 'cacheRead': return totals.cacheRead ?? 0
    case 'cacheMiss': return totals.cacheMiss
    case 'output': return totals.output
  }
}

/**
 * The cache-hit share, or `null` when there is none to state.
 *
 * **Absent is not zero, and the population matters.** The share is `cacheRead`
 * over `cachePrompt` — both restricted to the generations that reported a cache
 * bucket — so it answers "of the prompt tokens on routes that report caching,
 * what share was served" and not "what share of everything". Where no
 * generation reported one, there is no share: `null`, and the surface prints a
 * dash rather than `0%`.
 *
 * The formatter is `token-format.ts`'s, which is the one that never rounds a
 * partial hit up to `100`.
 * @param totals - a bucket, a conversation subtotal, or the whole range.
 * @returns the percentage without its sign, or `null`.
 */
export function hitRate(totals: UsageTotals): string | null {
  if (totals.cacheRead === undefined || totals.cacheTurns === 0) return null
  return formatCacheHitPercent(totals.cacheRead, totals.cachePrompt)
}

/*
 * ---------------------------------------------------------------- colour
 */

/**
 * The series palette, as theme tokens rather than colours.
 *
 * **Tokens, so the three themes each answer for their own screen.** A hex
 * chosen for 雪 is a different mark on 墨, and this project has already been
 * caught shipping a 1.34:1 tick by judging a colour in a stylesheet — see
 * `tests/contrast.test.ts`, which exists because that judgment failed twice.
 * So the palette is drawn only from tokens already defined in all three
 * palettes, and `tests/contrast.test.ts` now computes each one's ratio against
 * the card the chart is drawn on rather than trusting this comment.
 *
 * **Why these six.** They are the tokens that clear the 3:1 WCAG 1.4.11 floor
 * for a meaning-carrying non-text mark against `--iris-bg-raised` in *every*
 * theme, measured 2026-09-08: the worst of the six is `--iris-ink-tertiary` at
 * 3.96:1 in 宣. Two obvious candidates are deliberately **not** here because
 * they fail in 墨 — `--iris-accent-quiet` at 2.93:1 and `--iris-tick` at
 * 2.79:1 — and a series a reader cannot see is a model whose cost is invisible,
 * which is the opposite of this page's purpose.
 *
 * Ordered to keep adjacent slots as far apart in hue as this palette allows
 * (plum, gold, grey, orange, ink, deep plum). Beyond six the colours run out
 * and {@link DASH_PATTERNS} takes over, because the honest alternative — a
 * seventh colour a reader cannot tell from the first — is worse than a dashed
 * repeat.
 */
export const SERIES_TOKENS: readonly string[] = [
  'var(--iris-accent)',
  'var(--iris-warn)',
  'var(--iris-ink-tertiary)',
  'var(--iris-danger)',
  'var(--iris-ink-secondary)',
  'var(--iris-accent-strong)',
]

/**
 * Stroke dashes, cycled once the colours are used up.
 *
 * `undefined` first, so a chart with six or fewer models draws every line
 * solid and no reader is asked to decode a pattern that carries nothing. A
 * pattern is also the one distinction that survives a monochrome print and a
 * colour-blind reader, which is why it is the second axis rather than a
 * seventh hue.
 */
export const DASH_PATTERNS: readonly (string | undefined)[] = [
  undefined,
  '6 4',
  '2 3',
  '9 3 2 3',
]

/** How a series is drawn. */
export interface SeriesStyle {
  /** A `var(--iris-*)` reference, never a literal colour. */
  color: string
  /** `stroke-dasharray`, absent for a solid line. */
  dash?: string
}

/** Every distinct way a line can be drawn before the scheme has to repeat. */
const STYLE_SLOTS = SERIES_TOKENS.length * DASH_PATTERNS.length

/**
 * A stable, collision-free style for each model name.
 *
 * **Stable by name, not by position.** The chart is redrawn every time the
 * range or the granularity changes, and a model whose line was gold in "7 days"
 * and grey in "30 days" would make the two readings uncomparable — so the slot
 * comes from a hash of the name and not from its index in the list.
 *
 * The hash is load-bearing and a sorted index is **not** an equivalent
 * simplification, though it passes the obvious test: sorting before assignment
 * makes an index permutation-stable too, so what rules it out is the spread —
 * an index gives slot 0 to every name that is alone on its chart, and a colour
 * that does not depend on the model is not worth remembering. Both properties
 * are pinned in `tests/usage-stats.test.ts`, the second because a teeth check
 * found the first one alone could not tell the two schemes apart.
 *
 * **Collision-free within one chart**, which is the property that costs
 * something. Two names hashing to one slot would draw two models identically,
 * so the later one probes forward. Probing is done in sorted-name order, which
 * makes the outcome depend only on the *set* of names and not on the order they
 * arrived in — a permutation of the same models produces the identical
 * assignment. The price, stated because it is real: adding a model to the set
 * can move a *colliding* model's line to a different slot. It cannot move a
 * non-colliding one, and it never moves the first name of a colliding pair.
 * @param models - the model names on the chart; duplicates are ignored.
 * @returns a style per name.
 */
export function assignSeriesStyles(models: readonly string[]): Map<string, SeriesStyle> {
  const names = [...new Set(models)].sort((left, right) => left.localeCompare(right))
  const taken = new Map<number, string>()
  const styles = new Map<string, SeriesStyle>()
  for (const name of names) {
    let slot = hashSlot(name)
    // Bounded by construction: at most `STYLE_SLOTS` probes, and a set larger
    // than that wraps onto a slot already in use — at which point two models
    // genuinely do share a line and the legend is the only thing telling them
    // apart. That is the failure this scheme degrades to, rather than looping.
    for (let probe = 0; probe < STYLE_SLOTS && taken.has(slot); probe += 1) {
      slot = (slot + 1) % STYLE_SLOTS
    }
    taken.set(slot, name)
    styles.set(name, styleForSlot(slot))
  }
  return styles
}

/**
 * A name's preferred slot.
 *
 * FNV-1a over the UTF-16 code units, which is enough of a hash for a set whose
 * size is measured in single digits and is spelled out here so the assignment
 * is reproducible by hand — a colour scheme nobody can predict is a colour
 * scheme nobody can test.
 * @param name - the model name.
 * @returns a slot index.
 */
function hashSlot(name: string): number {
  let hash = 0x811c9dc5
  for (let at = 0; at < name.length; at += 1) {
    hash ^= name.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % STYLE_SLOTS
}

/**
 * The colour and dash one slot means.
 *
 * Colour cycles fastest, so the first six models are six colours and all solid.
 * @param slot - a slot index below {@link STYLE_SLOTS}.
 * @returns the style.
 */
export function styleForSlot(slot: number): SeriesStyle {
  const index = ((slot % STYLE_SLOTS) + STYLE_SLOTS) % STYLE_SLOTS
  const color = SERIES_TOKENS[index % SERIES_TOKENS.length] ?? SERIES_TOKENS[0] ?? 'currentColor'
  const dash = DASH_PATTERNS[Math.floor(index / SERIES_TOKENS.length) % DASH_PATTERNS.length]
  return dash === undefined ? { color } : { color, dash }
}

/*
 * ---------------------------------------------------------------- series
 */

/** One model's line: a value for every bucket on the chart, in bucket order. */
export interface UsageSeries {
  /** The model, or `undefined` for the records that name none. */
  model?: string
  /** One value per entry of the chart's bucket axis; `0` where this model spent nothing. */
  values: number[]
  /** This line's own total over the whole axis, for the legend and the ordering. */
  total: number
}

/** A chart's data: the shared time axis, and one line per model. */
export interface UsageChartData {
  /** Every bucket start present in the summary, ascending — the x axis. */
  axis: number[]
  /** One entry per model, largest total first, so the legend reads as a ranking. */
  series: UsageSeries[]
}

/**
 * Turn the host's cells into lines over a shared axis.
 *
 * **The axis is the buckets that exist, not every bucket in the range.** A gap
 * where nothing was generated is not drawn as a gap: the chart's x positions are
 * evenly spaced over the buckets present, and the labels say which days those
 * are. The alternative — a true time axis with empty days — was rejected because
 * on a 30-day range with three days of use it draws three points at the far
 * right of an empty field, which reads as a rendering failure rather than as
 * three days of use.
 *
 * **A model absent from a bucket contributes `0` there, not a hole.** These are
 * spend-over-time lines: a model that generated nothing on Tuesday spent nothing
 * on Tuesday, which is a fact and is `0`. That is the opposite of the rule for
 * an *unreported bucket*, where zero would be an invention — the difference is
 * that here the host counted and found nothing, and there nobody counted.
 * @param buckets - the summary's cells, in any order.
 * @param metric - which figure the lines draw.
 * @returns the axis and the lines.
 */
export function chartData(
  buckets: readonly UsageBucket[],
  metric: UsageMetric,
): UsageChartData {
  const axis = [...new Set(buckets.map(cell => cell.bucket))].sort((left, right) => left - right)
  const at = new Map(axis.map((bucket, index) => [bucket, index]))

  // Keyed the way the host keys its cells, and for the same reason: JSON, so a
  // model literally named after the empty string cannot merge with the records
  // that name no model at all, and no sentinel character is involved.
  const lines = new Map<string, UsageSeries>()
  for (const cell of buckets) {
    const key = JSON.stringify(cell.model ?? null)
    let line = lines.get(key)
    if (line === undefined) {
      line = {
        ...cell.model === undefined ? {} : { model: cell.model },
        values: axis.map(() => 0),
        total: 0,
      }
      lines.set(key, line)
    }
    const index = at.get(cell.bucket)
    if (index === undefined) continue
    const value = metricValue(cell, metric)
    // `+=` rather than `=`: the host emits one cell per (bucket, model), but a
    // caller that concatenated two summaries would otherwise silently keep only
    // the last, and a chart that drops half its data still draws.
    line.values[index] = (line.values[index] ?? 0) + value
    line.total += value
  }

  const series = [...lines.values()].sort((left, right) =>
    right.total - left.total
    // A stable tail for equal totals — two lines swapping places between
    // renders would make the legend flicker on a range change that changed
    // nothing. The unknown line sorts last among equals.
    || (left.model ?? '￿').localeCompare(right.model ?? '￿'))
  return { axis, series }
}

/**
 * A series' identity as a Map key and a React key.
 *
 * The empty string is the unknown line's key and cannot collide with a real
 * model: a blank model name is dropped at both recording sites (the host's
 * `noteRoute` and `parseUsage`), precisely so that "no model" has exactly one
 * spelling by the time anything reads it.
 * @param series - one line.
 * @returns the key.
 */
export function seriesKey(series: UsageSeries): string {
  return series.model ?? ''
}

/**
 * A series' key for a React list, where the sentinel has to be distinguishable.
 *
 * {@link seriesKey}'s empty string is the right key for the hidden-series set —
 * it is only ever compared against itself — but a poor React key, and prefixing
 * is what makes this one safe: under a bare sentinel a model *named* `unknown`
 * would collide with the unattributed line, on a page whose whole subject is
 * telling a named route from an unnamed one.
 *
 * A prefix rather than a reserved character, on purpose. The first version of
 * these keys used a leading-space sentinel and shipped as a raw NUL byte in
 * three files — invisible to `tsc` and to every test except
 * `packages/iris-app-service/tests/no-control-chars.test.ts`, which is the gate
 * that found it.
 * @param series - one line.
 * @returns a key no model name can collide with.
 */
export function seriesDomKey(series: UsageSeries): string {
  return series.model === undefined ? 'unattributed' : `model:${series.model}`
}

/**
 * A bucket's axis label.
 *
 * Digits only, in no language: `9-08` and `14:00` read the same for both
 * dictionaries, and a translated month name would not fit a 54px column
 * anyway. Local, because the buckets were cut on local boundaries — reading
 * them back in UTC would label a midnight bucket with the previous day.
 * @param bucket - the bucket's start.
 * @param granularity - which cut it came from.
 * @returns the label.
 */
export function bucketLabel(bucket: number, granularity: 'day' | 'hour'): string {
  const when = new Date(bucket)
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (granularity === 'hour') return `${pad(when.getHours())}:00`
  return `${String(when.getMonth() + 1)}-${pad(when.getDate())}`
}

/*
 * -------------------------------------------------------------- geometry
 */

/** The drawing box, in the SVG's own user units (which are CSS pixels here). */
export interface ChartLayout {
  width: number
  height: number
  /** The plot rectangle's edges, leaving room for the axis labels outside it. */
  plot: { left: number, top: number, right: number, bottom: number }
}

/** Room for the y labels on the left, the x labels below, and a top margin for the highest point's dot. */
const PAD = { left: 52, top: 12, right: 12, bottom: 26 } as const

/** How wide one bucket's column is. Below this two adjacent day labels collide. */
const BUCKET_WIDTH = 54

/** The chart never draws narrower than this, so two points do not become a 40px sketch. */
const MIN_WIDTH = 460

/** Fixed height: the chart's job is comparing lines, and a taller box does not compare them better. */
const HEIGHT = 220

/**
 * The box for a given number of buckets.
 *
 * **Width grows with the data and the container scrolls.** A 30-day chart
 * squeezed into a 400px phone would put its labels on top of each other, so the
 * SVG keeps a legible column per bucket and its wrapper takes `overflow-x:
 * auto`. That is the one layout rule the page has to honour: the SVG must never
 * be the thing that makes the page scroll sideways.
 * @param bucketCount - how many buckets are on the axis.
 * @returns the layout.
 */
export function chartLayout(bucketCount: number): ChartLayout {
  const width = Math.max(MIN_WIDTH, PAD.left + PAD.right + Math.max(1, bucketCount) * BUCKET_WIDTH)
  return {
    width,
    height: HEIGHT,
    plot: { left: PAD.left, top: PAD.top, right: width - PAD.right, bottom: HEIGHT - PAD.bottom },
  }
}

/**
 * Where one bucket sits horizontally.
 *
 * A single bucket is centred rather than pinned to the left edge: one point at
 * `x = left` reads as a line that has been cut off.
 * @param index - the bucket's position on the axis.
 * @param count - how many buckets there are.
 * @param layout - the box.
 * @returns the x coordinate in user units.
 */
export function xFor(index: number, count: number, layout: ChartLayout): number {
  const { left, right } = layout.plot
  if (count <= 1) return (left + right) / 2
  return left + (right - left) * (index / (count - 1))
}

/**
 * Where one value sits vertically.
 *
 * `max` of `0` puts every point on the baseline rather than dividing by zero —
 * a range in which nothing was spent is a flat line at the bottom, which is
 * what it should look like.
 * @param value - the value in tokens.
 * @param max - the axis maximum, from {@link axisMax}.
 * @param layout - the box.
 * @returns the y coordinate in user units.
 */
export function yFor(value: number, max: number, layout: ChartLayout): number {
  const { top, bottom } = layout.plot
  if (max <= 0) return bottom
  const clamped = Math.min(Math.max(value, 0), max)
  return bottom - (bottom - top) * (clamped / max)
}

/**
 * A round axis maximum at or above the largest value.
 *
 * 1, 2 or 5 times a power of ten, which is what makes the gridline labels
 * readable numbers rather than the data's own largest value with six digits.
 * Zero stays zero: an axis to `1` above an empty chart would draw four
 * gridlines labelled with a scale nothing is measured against.
 * @param values - every value the chart draws.
 * @returns the maximum for {@link yFor} and {@link yTicks}.
 */
export function axisMax(values: readonly number[]): number {
  let peak = 0
  for (const value of values) if (Number.isFinite(value) && value > peak) peak = value
  if (peak <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude
    if (candidate >= peak) return candidate
  }
  return 10 * magnitude
}

/**
 * The gridline values, baseline included.
 *
 * Four intervals over the {@link axisMax} scale, **rounded to whole tokens and
 * deduplicated** — and both of those are corrections a test made rather than
 * decisions taken up front. The comment that stood here claimed a 1/2/5-scaled
 * maximum "always divides evenly", and it does not: `50` gives `12.5` and `1`
 * gives `0.25`. So the first version of this function drew a gridline labelled
 * `0` a quarter of the way up a chart whose peak was one token, and said in
 * prose that it could not. A token is a countable thing; a quarter of one is
 * not a quantity any provider billed.
 *
 * Deduplicating is what keeps that honest at the small end rather than merely
 * tidy: a maximum of `1` gets two gridlines, not five with three of them
 * labelled the same. Each line is drawn at the value it is labelled with, so
 * the label and the position cannot disagree.
 * @param max - the axis maximum.
 * @returns the tick values, ascending and distinct, `[0]` for an empty chart.
 */
export function yTicks(max: number): number[] {
  if (max <= 0) return [0]
  const values = new Set<number>()
  for (const step of [0, 1, 2, 3, 4]) values.add(Math.round((max * step) / 4))
  return [...values].sort((left, right) => left - right)
}

/**
 * One line's `d`, as a polyline through its points.
 *
 * Straight segments, not a spline: a curve through spend-per-day invents values
 * between the days that were never spent, and on a chart whose whole purpose is
 * accounting an interpolated peak is a number the reader will quote.
 * @param values - one value per bucket, in axis order.
 * @param max - the axis maximum.
 * @param layout - the box.
 * @returns the path, or the empty string when there is nothing to draw.
 */
export function linePath(
  values: readonly number[],
  max: number,
  layout: ChartLayout,
): string {
  if (values.length === 0) return ''
  return values
    .map((value, index) => {
      const x = xFor(index, values.length, layout)
      const y = yFor(value, max, layout)
      return `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`
    })
    .join(' ')
}

/** Two decimals, so the path string is stable and short rather than 17 digits long. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/*
 * ----------------------------------------------------------------- range
 */

/** Which slice of time the page is reading. */
export type UsageRange = 'today' | 'week' | 'month' | 'all'

/** Every range, in the order the switch offers them. */
export const USAGE_RANGES: readonly UsageRange[] = ['today', 'week', 'month', 'all']

/** One day. */
const DAY_MS = 24 * 60 * 60 * 1_000

/**
 * A range as the wire method's parameters.
 *
 * **`today` starts at the reader's own midnight**, not 24 hours ago, because
 * "today" is a calendar day and the host's day and hour buckets are cut on the
 * same local boundaries — asking for a rolling window and drawing it in
 * calendar buckets would put part of yesterday in yesterday's column and label
 * the whole thing today.
 *
 * The other two are rolling windows and deliberately not calendar-aligned:
 * "7 days" is asked when someone wants the last week of spending, and a
 * calendar week that is one day old would answer with one day.
 *
 * **The granularity comes from the range rather than from a control of its
 * own.** A single day cut into days is one column, which is not a chart; a
 * month cut into hours is 720 of them. Deriving it removes a control whose only
 * correct setting was already implied by the one beside it.
 *
 * In this module rather than beside the panel that calls it because it is pure
 * and it is the page's one piece of date arithmetic — and because the panel is
 * a `.tsx`, which the `node --test` suites cannot import at all.
 * @param range - what the reader picked.
 * @param now - the moment the page is reading at.
 * @returns the request parameters; `since` absent means "every record there is".
 */
export function rangeParams(
  range: UsageRange,
  now: number,
): { since?: number, granularity: UsageGranularity } {
  if (range === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return { since: midnight.getTime(), granularity: 'hour' }
  }
  if (range === 'week') return { since: now - 7 * DAY_MS, granularity: 'day' }
  if (range === 'month') return { since: now - 30 * DAY_MS, granularity: 'day' }
  /*
   * No `since` at all for "all", which is a different instruction from
   * `since: 0` and not merely a tidier one: the host reads an absent `since` as
   * "from the first record there is", and that is what keeps a record whose
   * moment could not be reconstructed at all — the epoch fallback, for a chat
   * whose header carries neither an Iris block nor a readable date — inside the
   * total it belongs to.
   */
  return { granularity: 'day' }
}
