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
  billedPrompt,
  bucketLabel,
  chartData,
  chartLayout,
  DASH_PATTERNS,
  hitRate,
  linePath,
  metricValue,
  rangeParams,
  seriesKey,
  SERIES_TOKENS,
  styleForSlot,
  totalTokens,
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
