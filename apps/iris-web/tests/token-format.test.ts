/**
 * Token and usage formatting.
 *
 * The assertions that matter are about a *property*, not about strings: a
 * partial cache hit must never be displayed as a full one, and an absent
 * bucket must never be read as a zero. Both are ways for the interface to
 * assert something the provider never said.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TurnUsage } from '@iris/protocol'

import {
  billedInputTokens,
  cacheHitPercent,
  formatCacheHitPercent,
  formatExactTokens,
  formatTokens,
  totalTokens,
  usageDetailText,
  usageLineGroups,
  usageLineTitle,
} from '../src/app/token-format.ts'
import { DICTIONARIES } from '../src/app/i18n/strings.ts'

/**
 * The share, rounded half-up at `places` decimals, in exact arithmetic.
 *
 * An independent reference: `BigInt` division cannot round differently for a
 * large numerator than for a small one, so a disagreement with it is the
 * formatter's bug and not the reference's. This is the oracle the property
 * tests below are checked against — the point of the module is that its own
 * integer binary search is doing what a rational number would.
 * @param served - the numerator.
 * @param billed - the denominator; must be positive.
 * @param places - decimals to round to.
 * @returns the percentage as a number.
 */
function exactPercent(served: number, billed: number, places: number): number {
  const scale = 10n ** BigInt(places) * 100n
  const numerator = BigInt(served) * scale * 2n + BigInt(billed)
  const units = numerator / (2n * BigInt(billed))
  return Number(units) / 10 ** places
}

test('a partial cache hit is never displayed as 100%', () => {
  // The case the whole module exists for: 99.9% rounds to 100 in one step of
  // ordinary arithmetic, and a reader shown 100% believes the prompt was free.
  assert.notEqual(formatCacheHitPercent(999, 1000), '100')
  assert.equal(formatCacheHitPercent(999, 1000), '99.9')
  // Deeper misses gain exactly the places they need, and no more.
  assert.equal(formatCacheHitPercent(9_999, 10_000), '99.99')
  assert.equal(formatCacheHitPercent(9_998, 10_000), '99.98')
  assert.equal(formatCacheHitPercent(99_999, 100_000), '99.999')
})

test('a full hit is the one thing that reads 100', () => {
  assert.equal(formatCacheHitPercent(1_000, 1_000), '100')
  assert.equal(formatCacheHitPercent(1, 1), '100')
})

test('no cache reads at all is 0%, and nothing billed is no share', () => {
  // 0% and "there is no share" are different facts. A prompt that was billed
  // and served nothing from cache genuinely is a 0% hit; a turn that billed no
  // prompt tokens has no denominator, and `null` is the only honest answer.
  assert.equal(formatCacheHitPercent(0, 1_000), '0')
  assert.equal(formatCacheHitPercent(0, 1), '0')
  assert.equal(formatCacheHitPercent(0, 0), null)
  assert.equal(formatCacheHitPercent(500, 0), null)
})

test('ordinary shares round half-up, and agree with exact arithmetic', () => {
  assert.equal(formatCacheHitPercent(1, 2), '50')
  // A tie goes up: 125/1000 is 12.5%.
  assert.equal(formatCacheHitPercent(125, 1_000), '13')
  assert.equal(formatCacheHitPercent(124, 1_000), '12')
  assert.equal(formatCacheHitPercent(1, 3, 1), '33.3')
  assert.equal(formatCacheHitPercent(2, 3, 1), '66.7')

  // The property, over a spread of magnitudes rather than one hand-picked pair:
  // wherever the exact rounding stays below a full hit, the formatter must
  // print exactly it; wherever it reaches 100 without being a full hit, the
  // formatter must refuse 100 and print the exact value at the precision it
  // chose. Both directions are checked, because printing 99.9 for a real 100%
  // would be the mirror-image lie.
  let checked = 0
  for (const billed of [7, 97, 1_000, 12_345, 999_983, 3_000_000]) {
    for (const numerator of [0, 1, 2, 3, billed - 3, billed - 2, billed - 1, billed]) {
      if (numerator < 0) continue
      for (const places of [0, 1] as const) {
        const shown = formatCacheHitPercent(numerator, billed, places)
        assert.ok(shown !== null, 'a positive denominator always has a share')
        checked += 1
        if (numerator === billed) {
          assert.equal(shown, '100')
          continue
        }
        assert.ok(Number(shown) < 100, `${shown} is a partial hit shown as full`)
        const decimals = shown.includes('.') ? shown.split('.')[1]!.length : 0
        assert.equal(
          Number(shown),
          exactPercent(numerator, billed, decimals),
          `${String(numerator)}/${String(billed)} at ${String(places)}dp printed ${shown}`,
        )
      }
    }
  }
  // The loop's own sample size, asserted as a floor: a `continue` that skipped
  // everything would leave every assertion above unexecuted and still green.
  assert.ok(checked >= 90, `only ${String(checked)} shares were compared`)
})

test('compact counts have three bands', () => {
  assert.equal(formatTokens(517), '517')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_000), '1K')
  assert.equal(formatTokens(12_200), '12.2K')
  // Past 100 of a unit the decimal is dropped, so the string stays as wide.
  assert.equal(formatTokens(517_000), '517K')
  assert.equal(formatTokens(999_999), '1000K')
  assert.equal(formatTokens(1_200_000), '1.2M')
  assert.equal(formatTokens(1_200_000, 'zh'), '1.2M')
})

test('a count the provider mangled reads as zero rather than as nonsense', () => {
  // These cannot be produced by a well-behaved provider; they can be produced
  // by a broken one, and the grouping walk reads digits.
  assert.equal(formatTokens(Number.NaN), '0')
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatExactTokens(Number.POSITIVE_INFINITY), '0')
  assert.equal(formatExactTokens(1_234.6), '1,235')
})

test('exact counts are grouped with the separator each language declares', () => {
  assert.equal(formatExactTokens(517), '517')
  assert.equal(formatExactTokens(1_000), '1,000')
  assert.equal(formatExactTokens(1_234_567), '1,234,567')
  // Pinned per column rather than as "the two agree": they agree today (a
  // grouped integer reads the same in both languages), and the test's job is
  // to go red if either column is edited, not to require that they differ.
  assert.equal(DICTIONARIES.en.thousandsSeparator, ',')
  assert.equal(DICTIONARIES.zh.thousandsSeparator, ',')
  assert.equal(formatExactTokens(1_234_567, 'en'), '1,234,567')
  assert.equal(formatExactTokens(1_234_567, 'zh'), '1,234,567')
})

/** A usage record with the buckets a test needs and nothing else. */
function usage(extra: Partial<TurnUsage> = {}): TurnUsage {
  return { inputTokens: 800, outputTokens: 300, ...extra }
}

test('the prompt side sums three disjoint buckets, absent ones contributing nothing', () => {
  assert.equal(billedInputTokens(usage()), 800)
  assert.equal(billedInputTokens(usage({ cacheReadTokens: 1_000 })), 1_800)
  assert.equal(billedInputTokens(usage({ cacheReadTokens: 1_000, cacheWriteTokens: 200 })), 2_000)
})

test('a provider that reports no cache gets no hit rate, not a zero one', () => {
  // The protocol keeps the bucket absent precisely so these two stay apart.
  assert.equal(cacheHitPercent(usage()), null)
  assert.equal(cacheHitPercent(usage({ cacheReadTokens: 0 })), '0')
  assert.equal(cacheHitPercent(usage({ inputTokens: 0, cacheReadTokens: 1_000 })), '100')
  assert.equal(cacheHitPercent(usage({ inputTokens: 1_000, cacheReadTokens: 1_000 })), '50')
})

test('the total prefers the provider’s own, and otherwise sums the buckets', () => {
  assert.equal(totalTokens(usage({ cacheReadTokens: 1_000 })), 2_100)
  assert.equal(totalTokens(usage({ cacheReadTokens: 1_000, totalTokens: 2_099 })), 2_099)
  // Reasoning is inside the output it is reported with, so it is not added.
  assert.equal(totalTokens(usage({ reasoningTokens: 250 })), 1_100)
})

test('the composer line drops a group with no data, and the row with no activity', () => {
  assert.deepEqual(usageLineGroups(undefined), [])
  // A conversation whose every request failed: zeros are not a reading.
  assert.deepEqual(usageLineGroups({ inputTokens: 0, outputTokens: 0 }), [])
  assert.deepEqual(usageLineGroups(usage()), ['Input 800 tok · Output 300 tok'])
  assert.deepEqual(
    usageLineGroups(usage({ cacheReadTokens: 1_200 })),
    ['Cache hit 60%', 'Input 2K tok · Output 300 tok'],
  )
  assert.deepEqual(
    usageLineGroups(usage({ cacheReadTokens: 1_200 }), 'zh'),
    ['缓存命中 60%', '输入 2K tok · 输出 300 tok'],
  )
})

test('the composer row’s hover separates the card’s share, and only there', () => {
  /*
   * Two claims, and the second is the one worth pinning. The *visible* groups
   * already count a card's requests — they are summed into `ChatView.usage`
   * because they were billed to this conversation, which is what makes the row
   * agree with the bill — so the hover is a breakdown of the line above it and
   * never an addition to it. A reader adding the two would double-count, which
   * is what the 「其中」 / "of which" wording is for.
   */
  const groups = usageLineGroups(usage({ cacheReadTokens: 1_200 }))
  const share = { turns: 2, usage: { inputTokens: 400, outputTokens: 60 } }

  // With no card share, the hover is the line and nothing else — the state
  // every conversation whose cards never generated is in.
  assert.equal(usageLineTitle(groups, undefined), 'Cache hit 60% | Input 2K tok · Output 300 tok')
  // With one, a second line carrying the count and the tokens. 460 and not
  // 2,300: the share's own buckets, not the row's.
  assert.equal(
    usageLineTitle(groups, share),
    'Cache hit 60% | Input 2K tok · Output 300 tok\nof which 2 card-script requests · 460 tok',
  )
  assert.equal(
    usageLineTitle(usageLineGroups(usage({ cacheReadTokens: 1_200 }), 'zh'), share, 'zh'),
    '缓存命中 60% | 输入 2K tok · 输出 300 tok\n其中卡脚本请求 2 次 · 460 tok',
  )
  // No row means no hover: the composer draws nothing there, so a `title` would
  // be attached to an element that does not exist.
  assert.equal(usageLineTitle([], share), '')
})

test('the composer line adds the buckets and never reads a summed total', () => {
  /*
   * `ChatView.usage.totalTokens` is a sum over only the generations that
   * reported one, so on a conversation with mixed providers it is *smaller*
   * than the buckets next to it — the protocol spells this out and tells a
   * surface that wants a grand figure to add the buckets instead. This fixture
   * is that trap: a total of 5 beside 2,000 of billed input. A line built on
   * `totalTokens` would report the 5.
   */
  assert.deepEqual(
    usageLineGroups({
      inputTokens: 800,
      outputTokens: 300,
      cacheReadTokens: 1_200,
      totalTokens: 5,
    }),
    ['Cache hit 60%', 'Input 2K tok · Output 300 tok'],
  )
})

test('the per-turn breakdown has a row only for a bucket the provider reported', () => {
  const bare = usageDetailText(usage())
  assert.equal(bare.split('\n')[0], 'Turn usage')
  assert.match(bare, /Uncached input 800 tok/)
  assert.match(bare, /Output 300 tok/)
  assert.doesNotMatch(bare, /Cache/, 'a provider silent about caching got cache rows anyway')
  assert.doesNotMatch(bare, /reasoning/, 'a turn with no reasoning got a reasoning note')

  const full = usageDetailText(usage({
    cacheReadTokens: 1_200,
    cacheWriteTokens: 4_000,
    reasoningTokens: 250,
  }))
  assert.deepEqual(full.split('\n'), [
    'Turn usage',
    'Cache hit 20%',
    'Uncached input 800 tok',
    'Cached input 1,200 tok',
    'Cache write 4,000 tok',
    // Reasoning rides the output row, because that is where it lives.
    'Output 300 tok (250 tok reasoning)',
  ])

  assert.deepEqual(usageDetailText(usage({ reasoningTokens: 250 }), 'zh').split('\n'), [
    '本轮用量',
    '未缓存输入 800 tok',
    '输出 300 tok（其中推理 250 tok）',
  ])
})
