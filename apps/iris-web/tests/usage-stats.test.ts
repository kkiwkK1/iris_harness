/**
 * The usage page's arithmetic, its colour scheme, and its geometry.
 *
 * Every number on that page is a sum or a scale, and a chart is the surface
 * where a wrong number is least visible — a line drawn from a bad total still
 * looks like a line. So the properties pinned here are the ones a reader would
 * quote and could not check:
 *
 * - **the hit rate's population**, which is the one place the page could lie
 *   without looking wrong: diluting `cacheRead` with prompt tokens from routes
 *   that never mentioned caching produces a plausible smaller percentage;
 * - **absent is not zero**, restated at this layer;
 * - **a model keeps its colour** when the metric or the range changes, and two
 *   models never share one within a chart;
 * - **the scale is honest**: a value never plots above its own maximum, and
 *   hiding a series rescales the rest.
 *
 * The cases are chosen so the nearest wrong implementation disagrees, rather
 * than for coverage: `hitRate` is tested on a set where the diluted denominator
 * and the honest one give *different* percentages, and `assignSeriesStyles` on
 * a permutation, which is the only thing that separates "stable by name" from
 * "assigned by index".
 *
 * @module iris-web/tests/usage-stats
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import type { UsageBucket, UsageTotals } from '@iris/protocol'

import {
  assignSeriesStyles,
  axisMax,
  axisTicks,
  billedPrompt,
  bucketLabel,
  chartData,
  chartHasSpend,
  chartLayout,
  DASH_PATTERNS,
  hitRate,
  linePath,
  metricValue,
  monthLabel,
  rangeParams,
  seriesKey,
  SERIES_TOKENS,
  styleFor,
  styleForSlot,
  totalTokens,
  UNATTRIBUTED_STYLE,
  USAGE_RANGES,
  xFor,
  yFor,
  yTicks,
} from '../src/app/usage-stats.ts'

/** A totals row, with the required fields defaulted so a case states only what it is about. */
function totals(patch: Partial<UsageTotals> = {}): UsageTotals {
  return {
    cacheMiss: 0,
    output: 0,
    turns: 0,
    cacheTurns: 0,
    cachePrompt: 0,
    undatedTurns: 0,
    ...patch,
  }
}

test('billed prompt is the three disjoint buckets, and the total adds output to it', () => {
  const row = totals({ cacheMiss: 700, cacheRead: 2_300, cacheWrite: 100, output: 400 })
  assert.equal(billedPrompt(row), 3_100)
  assert.equal(totalTokens(row), 3_500)
  // Reasoning is inside the output it is reported in, so it is never added:
  // the nearest wrong implementation adds it and reads 3_500 + 250.
  assert.equal(totalTokens({ ...row, reasoning: 250 }), 3_500)
})

test('an absent optional bucket contributes nothing rather than breaking the sum', () => {
  const row = totals({ cacheMiss: 1_000, output: 200 })
  assert.equal(billedPrompt(row), 1_000)
  assert.equal(totalTokens(row), 1_200)
})

test('the hit rate is over the cache-reporting population, not over every prompt token', () => {
  /*
   * The case the field exists for. Two generations: one on a caching route that
   * served 750 of 1000 prompt tokens, one on a silent route that billed 3000
   * prompt tokens and said nothing about caching.
   *
   * Honest: 750 / 1000 = 75%.
   * Diluted (the nearest wrong implementation, dividing by `billedPrompt`):
   * 750 / (250 + 3000 + 750) = 18.75% → 19%.
   *
   * Both are plausible percentages and only one is a fact about the cache. The
   * two figures are deliberately far apart so a change from one to the other
   * cannot be read as rounding.
   */
  const mixed = totals({
    cacheMiss: 250 + 3_000,
    cacheRead: 750,
    output: 500,
    turns: 2,
    cacheTurns: 1,
    cachePrompt: 1_000,
  })
  assert.equal(hitRate(mixed), '75')
  assert.notEqual(hitRate(mixed), '19')
  // The denominator this must not have used, asserted as a premise of the case
  // above: if `billedPrompt` ever equalled `cachePrompt` here, the test would
  // pass under both implementations and prove nothing.
  assert.notEqual(billedPrompt(mixed), mixed.cachePrompt)
})

test('no cache-reporting generation means no hit rate at all, never zero', () => {
  assert.equal(hitRate(totals({ cacheMiss: 5_000, output: 100, turns: 3 })), null)
  // Reported and genuinely cold is a different fact, and it is `0`.
  assert.equal(
    hitRate(totals({ cacheMiss: 1_000, cacheRead: 0, output: 100, turns: 1, cacheTurns: 1, cachePrompt: 1_000 })),
    '0',
  )
})

test('a partial hit does not round to 100 at this layer either', () => {
  const near = totals({
    cacheMiss: 1, cacheRead: 999, output: 10, turns: 1, cacheTurns: 1, cachePrompt: 1_000,
  })
  assert.equal(hitRate(near), '99.9')
})

test('each metric reads its own bucket, and an absent cache bucket plots as a floor', () => {
  const row = totals({ cacheMiss: 700, cacheRead: 300, output: 400 })
  assert.equal(metricValue(row, 'total'), 1_400)
  assert.equal(metricValue(row, 'cacheMiss'), 700)
  assert.equal(metricValue(row, 'cacheRead'), 300)
  assert.equal(metricValue(row, 'output'), 400)
  // A point on a line has to be a number; the honest half of the same fact is
  // `hitRate` refusing to state a share, asserted above.
  assert.equal(metricValue(totals({ cacheMiss: 700, output: 1 }), 'cacheRead'), 0)
})

/* -------------------------------------------------------------- series */

/** A bucket cell, defaulted like `totals` above. */
function cell(bucket: number, model: string | undefined, patch: Partial<UsageTotals>): UsageBucket {
  return { bucket, ...model === undefined ? {} : { model }, ...totals(patch) }
}

test('cells become one line per model over a shared axis of the buckets present', () => {
  const data = chartData([
    cell(2_000, 'a', { cacheMiss: 10, output: 1 }),
    cell(1_000, 'a', { cacheMiss: 20, output: 2 }),
    cell(2_000, 'b', { cacheMiss: 5, output: 5 }),
  ], 'total')

  assert.deepEqual(data.axis, [1_000, 2_000], 'the axis is ascending and deduplicated')
  assert.equal(data.series.length, 2)
  // Largest total first, so the legend reads as a ranking.
  assert.equal(data.series[0]?.model, 'a')
  // `b` spent nothing in the first bucket: that is a counted zero, not a hole.
  assert.deepEqual(data.series[1]?.values, [0, 10])
  assert.deepEqual(data.series[0]?.values, [22, 11])
})

test('records naming no model are their own line, keyed apart from every real name', () => {
  const data = chartData([
    cell(1_000, undefined, { cacheMiss: 40, output: 0 }),
    cell(1_000, '', { cacheMiss: 7, output: 0 }),
  ], 'total')
  assert.equal(data.series.length, 2, 'an empty model name must not merge with no model at all')
  const unknown = data.series.find(one => one.model === undefined)
  assert.ok(unknown !== undefined, 'the unattributed line is missing')
  assert.equal(unknown.total, 40)
  assert.equal(seriesKey(unknown), '')
})

test('a bucket with no cells at all leaves an empty chart rather than a NaN one', () => {
  const data = chartData([], 'total')
  assert.deepEqual(data.axis, [])
  assert.deepEqual(data.series, [])
  assert.equal(axisMax([]), 0)
  assert.deepEqual(yTicks(0), [0])
})

/* -------------------------------------------------------------- colour */

test('a model keeps its style whatever order the models arrive in', () => {
  const names = ['deepseek-chat', 'deepseek-reasoner', 'local/qwen3-8b', 'gpt-4o-mini']
  const forward = assignSeriesStyles(names)
  const backward = assignSeriesStyles([...names].reverse())
  for (const name of names) {
    assert.deepEqual(forward.get(name), backward.get(name), `${name} moved when the order changed`)
  }
})

test('a style follows the name, and different names really do land differently', () => {
  /*
   * **This is the assertion that separates "by name" from "by index", and the
   * permutation test above is not.** A teeth check proved that: replacing the
   * hash with `names.indexOf(name)` left the permutation test green, because
   * the names are sorted before assignment and a sorted index is
   * permutation-stable too.
   *
   * What an index cannot reproduce is the spread. Index assignment hands slot 0
   * to every name that is alone on its chart, so every singleton would draw the
   * same colour — and a colour that does not depend on the model is not worth
   * remembering between one range and the next.
   *
   * The floor is a measurement, not a wish: 24 generated names over 24 slots
   * gave 14 distinct styles (2026-09-08), which is the collision rate a hash
   * into that many buckets is expected to have. Eight is well below it and well
   * above the 1 a constant scheme produces, so the check discriminates without
   * pinning a number that a hash change would break for no reason.
   */
  const names = Array.from({ length: 24 }, (_unused, at) => `model-${String(at)}`)
  const alone = names.map(name => JSON.stringify(assignSeriesStyles([name]).get(name)))
  // Asked twice, so the assignment is not carrying hidden state between calls.
  for (const [at, name] of names.entries()) {
    assert.equal(JSON.stringify(assignSeriesStyles([name]).get(name)), alone[at], `${name} is not deterministic`)
  }
  assert.ok(
    new Set(alone).size >= 8,
    `${String(new Set(alone).size)} distinct styles over ${String(names.length)} names; an index scheme gives 1`,
  )
})

test('collision-freedom is bought with churn, and the churn is one line at most', () => {
  /*
   * The scheme's stated cost, asserted rather than left in prose — a reader who
   * found their line had changed colour would otherwise have no way to tell a
   * tradeoff from a bug.
   *
   * Two names can prefer one slot and only one of them can have it, so the
   * other probes. Adding a model to a chart can therefore move an existing
   * line, and no scheme with a fixed palette can avoid that while also keeping
   * two models from drawing identically. What must not happen is the whole
   * assignment reshuffling.
   *
   * A first draft of this test asserted that a line which did not move sits in
   * its own singleton slot. That is false and the failure was the useful kind:
   * a name displaced by a *collision* sits in a probed slot in both sets — it
   * is stable, which is the property that matters, without being preferred.
   */
  const names = ['deepseek-chat', 'local/qwen3-8b', 'gpt-4o-mini']
  const before = assignSeriesStyles(names)
  const after = assignSeriesStyles([...names, 'aaa-new-model'])
  const moved = names.filter(name =>
    JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)))
  assert.ok(
    moved.length <= 1,
    `${String(moved.length)} lines moved when one model joined: ${moved.join(', ')}`,
  )
  // And the chart is still collision-free after the join, which is what the
  // churn was spent on.
  const styles = [...after.values()].map(one => `${one.color}|${one.dash ?? '-'}`)
  assert.equal(new Set(styles).size, styles.length)
})

test('two models never share a style within one chart', () => {
  // Every slot, filled: at `SERIES_TOKENS.length * DASH_PATTERNS.length` names
  // the scheme is exactly saturated, which is the last size at which
  // collision-freedom is still promised.
  const slots = SERIES_TOKENS.length * DASH_PATTERNS.length
  const names = Array.from({ length: slots }, (_unused, at) => `model-${String(at)}`)
  const styles = assignSeriesStyles(names)
  assert.equal(styles.size, names.length, 'a name was dropped')
  const seen = new Set<string>()
  for (const style of styles.values()) seen.add(`${style.color}|${style.dash ?? '-'}`)
  assert.equal(seen.size, names.length, 'two models drew the same line')
})

test('the first six models are six colours, all solid', () => {
  // The scheme's shape rather than its assignment: colour cycles fastest, so a
  // chart small enough not to need dashes never shows one.
  for (const [index, token] of SERIES_TOKENS.entries()) {
    assert.deepEqual(styleForSlot(index), { color: token })
  }
  assert.equal(styleForSlot(SERIES_TOKENS.length).dash, DASH_PATTERNS[1])
})

test('every series colour is a theme token, never a literal', () => {
  /*
   * `tests/contrast.test.ts` computes each of these against the card the chart
   * is drawn on, in all three themes — which it can only do because they are
   * token names. A hex here would silently opt out of that check.
   */
  for (const token of SERIES_TOKENS) {
    assert.match(token, /^var\(--iris-[a-z-]+\)$/u, `${token} is not a token reference`)
  }
})

/* ------------------------------------------------------------ geometry */

test('a value never plots above its own axis maximum, and zero sits on the baseline', () => {
  const layout = chartLayout(5)
  const max = axisMax([100, 4_000, 250])
  assert.equal(max, 5_000, '1/2/5 scaling gives a round maximum at or above the peak')
  assert.equal(yFor(0, max, layout), layout.plot.bottom)
  assert.equal(yFor(max, max, layout), layout.plot.top)
  // Clamped rather than drawn outside the plot: a stale `max` from a previous
  // render must not put a line through the axis labels.
  assert.equal(yFor(max * 2, max, layout), layout.plot.top)
  assert.ok(yFor(2_500, max, layout) > layout.plot.top)
  assert.ok(yFor(2_500, max, layout) < layout.plot.bottom)
})

test('an empty range is a flat line at the bottom rather than a division by zero', () => {
  const layout = chartLayout(3)
  assert.equal(yFor(0, 0, layout), layout.plot.bottom)
  assert.ok(Number.isFinite(yFor(10, 0, layout)))
})

test('every gridline is a whole number of tokens, distinct and ascending', () => {
  /*
   * This is the assertion that found the bug: quarters of a 1/2/5-scaled
   * maximum are not always whole (`50` gives `12.5`, `1` gives `0.25`), and the
   * function's own comment claimed they were. `1` and `50` are in the list
   * because they are the two shapes that disagree; the large peaks are the real
   * corpus's figures, where the naive version happens to be right.
   */
  for (const peak of [1, 2, 7, 50, 99, 100, 101, 2_400, 39_936, 137_518]) {
    const max = axisMax([peak])
    assert.ok(max >= peak, `${String(max)} is below the peak ${String(peak)}`)
    const ticks = yTicks(max)
    for (const tick of ticks) {
      assert.ok(Number.isInteger(tick), `tick ${String(tick)} is not a whole number of tokens`)
    }
    assert.equal(new Set(ticks).size, ticks.length, `duplicate gridline labels at max ${String(max)}`)
    assert.deepEqual([...ticks].sort((a, b) => a - b), ticks, 'ticks are not ascending')
    assert.equal(ticks[0], 0, 'the baseline is missing')
    assert.equal(ticks[ticks.length - 1], max, 'the top gridline is not the maximum')
  }
})

test('one bucket is centred, and many span the plot exactly', () => {
  const single = chartLayout(1)
  assert.equal(xFor(0, 1, single), (single.plot.left + single.plot.right) / 2)
  const many = chartLayout(4)
  assert.equal(xFor(0, 4, many), many.plot.left)
  assert.equal(xFor(3, 4, many), many.plot.right)
})

test('the chart grows with its buckets and never below a legible floor', () => {
  // The premise of the page's one layout rule: the SVG can be wider than the
  // dialog, and `.iris-usage__plot` is what scrolls.
  assert.ok(chartLayout(30).width > chartLayout(3).width)
  assert.ok(chartLayout(1).width >= 460)
  assert.ok(chartLayout(30).width > 880, 'a 30-bucket chart should need its scroller')
})

test('the chart fills the room it is given, and the data still wins', () => {
  /*
   * The defect this argument exists for was visible only in a picture: three
   * buckets is the floor width, and a 460px chart in the left half of a 950px
   * card reads as a thumbnail nobody finished. Stretching cannot be a CSS rule
   * (the SVG has a `viewBox`, so `width: 100%` scales the axis type with the
   * drawing), so the room is measured and passed in.
   */
  // Unmeasured — a server render, the first paint — is the old behaviour exactly.
  assert.equal(chartLayout(3, 0).width, chartLayout(3).width)
  // Room to spare: the plot takes all of it, edge to edge.
  assert.equal(chartLayout(3, 830).width, 830)
  assert.equal(chartLayout(3, 830).plot.right, 830 - 12)
  // Less room than the columns need: the data wins, and the wrapper scrolls.
  // This is the page's one layout rule, and a container width must not bend it.
  assert.ok(chartLayout(30, 400).width > 400, 'a 30-bucket chart was squeezed into its container')
  assert.equal(chartLayout(30, 400).width, chartLayout(30).width)
  // And never below the floor, however little room there is.
  assert.ok(chartLayout(2, 120).width >= 460)
})

test('a line is a polyline through its own points, and an empty one draws nothing', () => {
  const layout = chartLayout(3)
  const path = linePath([0, 100, 50], 100, layout)
  assert.equal(path.startsWith('M'), true)
  assert.equal((path.match(/L/gu) ?? []).length, 2, 'straight segments, one per gap')
  assert.doesNotMatch(path, /[CSQ]/u, 'a spline would invent values between the days')
  assert.equal(linePath([], 100, layout), '')
})

test('bucket labels are digits, identical in both dictionaries', () => {
  // A local moment, built locally, so this does not depend on the runner's zone.
  const noon = new Date(2026, 8, 8, 14, 0, 0, 0).getTime()
  assert.equal(bucketLabel(noon, 'hour'), '14:00')
  assert.equal(bucketLabel(noon, 'day'), '9-08')
})

test('a month label carries its year, because the range that reaches it can span one', () => {
  // `2026-09`, not `9`: "all" is the only range labelled by month and the only
  // one that can cross a year, so a bare month number would put two Septembers
  // a year apart under the same label with nothing to say so.
  assert.equal(monthLabel(new Date(2026, 8, 8, 14, 0, 0, 0).getTime()), '2026-09')
  assert.equal(monthLabel(new Date(2025, 11, 31, 23, 30, 0, 0).getTime()), '2025-12')
})

/** A day axis of local midnights, `count` consecutive days from 2026-01-01. */
function dayAxis(count: number): number[] {
  return [...Array(count).keys()].map(index => new Date(2026, 0, 1 + index).getTime())
}

/** An hour axis of `count` consecutive local hours from midnight on 2026-09-08. */
function hourAxis(count: number): number[] {
  return [...Array(count).keys()].map(index => new Date(2026, 8, 8, index).getTime())
}

test('every bucket is labelled while the labels fit, and every k-th once they do not', () => {
  /*
   * The rule this replaced was inline in the panel — `axis.length > 16 ? 2 : 1`
   * — and the two cases that discriminate are the ones either side of that
   * edge, so they are both here: 16 buckets keep every label, 17 drop to every
   * other. The 30-day range is checked exactly rather than by property, because
   * it is the longest the range switch offers and its indices are the ones a
   * reader can count against the chart.
   */
  assert.equal(axisTicks(dayAxis(16), 'day').length, 16, 'sixteen columns hold sixteen labels')
  assert.deepEqual(
    axisTicks(dayAxis(30), 'day').map(one => one.index),
    [...Array(15).keys()].map(index => index * 2),
  )
  const seventeen = axisTicks(dayAxis(17), 'day').map(one => one.index)
  assert.deepEqual(seventeen, [0, 2, 4, 6, 8, 10, 12, 14, 16])

  // The property behind the numbers: no two labels ever land on adjacent
  // columns, which is the collision the stride exists to prevent. 54px holds one
  // `12-08` and not two.
  for (const count of [17, 30, 45]) {
    const indices = axisTicks(dayAxis(count), 'day').map(one => one.index)
    assert.ok(indices.length <= 16, `${String(count)} buckets produced ${String(indices.length)} labels`)
    for (const [at, index] of indices.entries()) {
      if (at === 0) continue
      assert.ok(index - (indices[at - 1] ?? 0) >= 2, `two labels are adjacent on a ${String(count)}-bucket axis`)
    }
  }
})

test('a day axis longer than a month and a half is labelled by month instead', () => {
  /*
   * The regime change, and the case that separates it from "thin the labels
   * out": on 120 days a stride would print `3-11` in a column 44 days wide,
   * which reads as a measurement of that column. A month label reads as a
   * heading, which is what it is.
   *
   * 45 stays on day labels and 60 moves — the two sides of `MONTH_LABEL_FROM`,
   * checked because a 30-day range must never reach the month regime (it would
   * be one or two labels under thirty columns).
   */
  assert.match(axisTicks(dayAxis(45), 'day').at(0)?.label ?? '', /^\d{1,2}-\d{2}$/)
  // 2026-01-01 plus 119 days is 2026-04-30: 31 + 28 + 31 + 30, four whole
  // months, so four labels and no fifth from a stray tail.
  const long = axisTicks(dayAxis(120), 'day')
  assert.equal(long.length, 4, `120 consecutive days from January span four months, not ${String(long.length)}`)
  for (const tick of long) assert.match(tick.label, /^\d{4}-\d{2}$/)
  assert.equal(new Set(long.map(one => one.label)).size, long.length, 'a month is labelled twice')

  // Every label sits on the first bucket *present* in its month, which is the
  // axis's own concession said once more: there is no column for a day that
  // billed nothing, so the label marks where the month starts on this chart and
  // not the first of the month.
  const axis = dayAxis(120)
  for (const tick of long) {
    const month = monthLabel(axis[tick.index] ?? 0)
    assert.equal(tick.label, month)
    const earlier = axis.slice(0, tick.index).filter(bucket => monthLabel(bucket) === month)
    assert.deepEqual(earlier, [], `${month} is labelled at ${String(tick.index)}, past its first bucket`)
  }
})

test('an hour axis keeps the clock format, however many hours it holds', () => {
  const day = axisTicks(hourAxis(24), 'hour')
  assert.equal(day.length, 12, 'a full day of hours should thin to every other hour')
  for (const tick of day) assert.match(tick.label, /^\d{2}:00$/)
  // One bucket is labelled, not skipped: `index % stride` is zero there, and a
  // single column with no label under it reads as a chart of nothing.
  assert.deepEqual(axisTicks(hourAxis(1), 'hour').map(one => one.label), ['00:00'])
  assert.deepEqual(axisTicks([], 'day'), [])
})

test('a metric nothing was billed to has no chart, and hiding every line still does', () => {
  /*
   * The two states that look identical to `axisMax` and are not the same fact.
   * A range that billed on a route which never mentioned caching has **no**
   * cache-read line to draw — that is the page's own emptiness and it says so
   * in words. A reader who switched every series off through the legend has
   * done that themselves, and the grid has to stay standing.
   */
  const buckets = [cell(1_000, 'm', { cacheMiss: 400, output: 100, turns: 1 })]
  assert.equal(chartHasSpend(chartData(buckets, 'total')), true)
  assert.equal(chartHasSpend(chartData(buckets, 'cacheRead')), false, 'an unreported bucket drew a chart of zeros')
  assert.equal(chartHasSpend(chartData([], 'total')), false)
  // Read off the totals rather than off the showing lines: `chartHasSpend` is
  // not given the hidden set, and that is deliberate — it answers "is there
  // anything here", not "is anything on screen".
  assert.equal(chartHasSpend(chartData(buckets, 'output')), true)
})

test('the unattributed line is dashed, tokenised, and never handed to a named model', () => {
  /*
   * One style, read from one place. The panel used to spell this three times —
   * the stroke, the dot and the legend swatch — and two of the three said
   * `--iris-tick`, the token `SERIES_TOKENS` excludes for measuring 2.79:1 in
   * 墨. On every history that exists today every record is unattributed, so that
   * was the only line most readers would ever see.
   */
  assert.match(UNATTRIBUTED_STYLE.color, /^var\(--iris-[a-z-]+\)$/, 'the unattributed line is not a token')
  assert.notEqual(UNATTRIBUTED_STYLE.color, 'var(--iris-tick)', 'the line is back on the token that fails in 墨')
  assert.ok(UNATTRIBUTED_STYLE.dash !== undefined, 'without a dash it is a model wearing a model colour')

  const styles = assignSeriesStyles(['deepseek-reasoner', 'local/qwen3-8b'])
  assert.equal(styleFor({ values: [], total: 0 }, styles), UNATTRIBUTED_STYLE)
  for (const model of ['deepseek-reasoner', 'local/qwen3-8b']) {
    const style = styleFor({ model, values: [], total: 0 }, styles)
    assert.deepEqual(style, styles.get(model), `${model} did not get its assigned style`)
    // Identity, not the values: a named model *may* be assigned this colour and
    // this dash by the hash — the palette is 6 × 4 and both are in it — and the
    // legend is then what tells the two apart, which is the documented
    // degradation. What must never happen is a named model being handed the
    // constant that *means* "no model".
    assert.notEqual(style, UNATTRIBUTED_STYLE, `${model} was handed the unattributed style itself`)
  }
  // A name the assignment does not carry is still not the unattributed style.
  const stray = styleFor({ model: 'gpt-nowhere', values: [], total: 0 }, styles)
  assert.notEqual(stray, UNATTRIBUTED_STYLE, 'a model missing from the assignment was drawn as "no model"')
  assert.match(stray.color, /^var\(--iris-[a-z-]+\)$/)
})

/* --------------------------------------------------------------- range */

test('"today" is the reader\'s own midnight, cut by the hour', () => {
  /*
   * Not a rolling 24 hours, and the difference is not cosmetic: the host cuts
   * its buckets on local boundaries, so a rolling window drawn in calendar
   * buckets puts part of yesterday in yesterday's column and labels the whole
   * reading "today".
   */
  const now = new Date(2026, 8, 8, 14, 30, 0, 0).getTime()
  const params = rangeParams('today', now)
  assert.equal(params.granularity, 'hour', 'one day cut into days is a single column')
  const midnight = new Date(params.since ?? 0)
  assert.equal(midnight.getHours(), 0)
  assert.equal(midnight.getDate(), 8)
  assert.notEqual(params.since, now - 24 * 60 * 60 * 1_000)
})

test('the week and month ranges are rolling windows cut by the day', () => {
  const now = new Date(2026, 8, 8, 14, 30, 0, 0).getTime()
  const day = 24 * 60 * 60 * 1_000
  assert.deepEqual(rangeParams('week', now), { since: now - 7 * day, granularity: 'day' })
  assert.deepEqual(rangeParams('month', now), { since: now - 30 * day, granularity: 'day' })
})

test('"all" sends no lower bound at all, rather than a zero', () => {
  // The host reads an absent `since` as "from the first record there is", which
  // is what keeps a record placed at the epoch — a chat whose header carries
  // neither an Iris block nor a readable date — inside the total it belongs to.
  const params = rangeParams('all', Date.now())
  assert.equal('since' in params, false)
  assert.equal(params.granularity, 'day')
})

test('every range is offered and each one asks for something different', () => {
  const now = new Date(2026, 8, 8, 14, 30, 0, 0).getTime()
  assert.deepEqual(USAGE_RANGES, ['today', 'week', 'month', 'all'])
  const asked = USAGE_RANGES.map(one => JSON.stringify(rangeParams(one, now)))
  assert.equal(new Set(asked).size, USAGE_RANGES.length, 'two ranges send the same request')
})

test('an inconsistent row still yields no hit rate rather than a made-up one', () => {
  /*
   * `hitRate`'s own guard, which nothing else here could exercise. A teeth
   * check removed it and every test stayed green: on a *consistent* row
   * `cachePrompt` is zero whenever `cacheRead` is absent, and
   * `formatCacheHitPercent` refuses a zero denominator on its own, so the guard
   * was doing no work in any case anyone had written down.
   *
   * It does work on a row where the two disagree — `cachePrompt` above zero
   * with no `cacheRead`, or a `cacheTurns` of zero beside a non-zero prompt.
   * The host cannot currently produce either (`addUsage` increments them
   * together), and that is the point: this comes off a wire, and a future host
   * that incremented one and not the other would otherwise make this page print
   * `0%` — "the cache never helped" — about generations no provider ever
   * discussed. A share of an unknown numerator is not zero.
   */
  assert.equal(
    hitRate(totals({ cacheMiss: 1_000, cachePrompt: 4_000, turns: 4, cacheTurns: 2 })),
    null,
    'a prompt total with no cache reading produced a percentage',
  )
  assert.equal(
    hitRate(totals({ cacheMiss: 1_000, cacheRead: 500, cachePrompt: 4_000, turns: 4, cacheTurns: 0 })),
    null,
    'a cache reading with an empty population produced a percentage',
  )
})
