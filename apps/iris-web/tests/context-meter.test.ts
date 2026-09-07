/**
 * The context-capacity reading: its classification, its arithmetic, and the
 * one property its six colours have to have.
 *
 * @module iris-web/tests/context-meter
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { PromptItemEntry, PromptItemization } from '@iris/protocol'

import {
  averageCacheHit,
  categoryOf,
  categoryShares,
  contextOccupancy,
  CONTEXT_CATEGORIES,
  meterSegments,
} from '../src/app/context-occupancy.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Ids the host actually mints, one per branch of the classifier.
 *
 * Every id here was read out of the host rather than invented:
 * `chatHistory` from `@iris/pipeline`'s `itemize`; `worldInfoBefore` /
 * `worldInfoAfter` / `charDescription` / `charPersonality` / `scenario` /
 * `dialogueExamples` / `personaDescription` / `main` / `nsfw` / `jailbreak` /
 * `enhanceDefinitions` from `@iris/app-service/prompt.ts`'s marker table;
 * `worldInfo.authorNote`, `worldInfo.depth.<n>.<role>`, `persona.depthPrompt`
 * and `card.depthPrompt` from the contributions the same module pushes; and
 * `script.<key>` from `injectedContributions`. A UUID stands for the 29 of 41
 * prompts in a real preset that identify themselves that way.
 */
const CASES: readonly { entry: PromptItemEntry, expect: string }[] = [
  { entry: item('chatHistory', 'history'), expect: 'messages' },
  { entry: item('worldInfoBefore', 'system'), expect: 'worldbook' },
  { entry: item('worldInfoAfter', 'system'), expect: 'worldbook' },
  { entry: item('worldInfo.authorNote', 'system'), expect: 'worldbook' },
  { entry: item('worldInfo.depth.4.0', 'depth'), expect: 'worldbook' },
  { entry: item('charDescription', 'system'), expect: 'character' },
  { entry: item('charPersonality', 'system'), expect: 'character' },
  { entry: item('scenario', 'system'), expect: 'character' },
  { entry: item('dialogueExamples', 'system'), expect: 'character' },
  { entry: item('personaDescription', 'system'), expect: 'character' },
  { entry: item('persona.depthPrompt', 'depth'), expect: 'character' },
  { entry: item('card.depthPrompt', 'depth'), expect: 'character' },
  { entry: item('main', 'system'), expect: 'preset' },
  { entry: item('nsfw', 'system'), expect: 'preset' },
  { entry: item('jailbreak', 'system'), expect: 'preset' },
  { entry: item('enhanceDefinitions', 'system'), expect: 'preset' },
  { entry: item('881044e5-cbef-4a1c-9b3d-2f0e6a7c5d31', 'system'), expect: 'preset' },
  { entry: item('script.5_era_core', 'depth'), expect: 'script' },
  // The reachable `other`: a dotted namespace this table has never met. Not a
  // hypothetical — it is what a host-side contribution added after this file
  // was written looks like, and the bucket exists so it shows up as an
  // unexplained slice instead of being filed under the preset.
  { entry: item('summariser.checkpoint', 'system'), expect: 'other' },
]

/**
 * One itemization entry.
 * @param id - the host-minted id.
 * @param kind - the placement kind.
 * @param tokens - what it cost.
 * @returns the entry.
 */
function item(id: string, kind: PromptItemEntry['kind'], tokens = 10): PromptItemEntry {
  return { id, label: `label of ${id}`, kind, tokens }
}

/**
 * One itemization.
 * @param entries - its parts.
 * @param budget - the window and the reserve.
 * @returns the itemization.
 */
function itemization(
  entries: readonly PromptItemEntry[],
  budget = { context: 8192, reserve: 1024 },
): PromptItemization {
  return {
    turn: 3,
    entries: entries.map(entry => ({ ...entry })),
    tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
    budget,
    droppedHistory: 0,
    overBudget: false,
    preview: false,
  }
}

test('every id the host mints lands in the category it belongs to', () => {
  for (const { entry, expect } of CASES) {
    assert.equal(categoryOf(entry), expect, `${entry.id} was classified wrong`)
  }
  // The premise this table rests on: it is not asserting one branch twenty
  // times. Every category has at least one case, `other` included, so a
  // classifier that collapsed two of them would not stay green.
  const covered = new Set(CASES.map(one => categoryOf(one.entry)))
  assert.deepEqual([...covered].sort(), [...CONTEXT_CATEGORIES].sort())
})

test('the conversation is classified by its kind, whatever its id is called', () => {
  // The contract says history is one aggregate row; a second history-shaped row
  // under some other id must not be filed by name. This is the assertion that
  // separates "reads the kind first" from "happens to know `chatHistory`".
  assert.equal(categoryOf(item('someOtherHistoryRow', 'history')), 'messages')
  assert.equal(categoryOf(item('chatHistory', 'system')), 'preset')
})

test('a category with nothing in it still gets a row, at zero', () => {
  const rows = categoryShares([item('main', 'system', 100)], 100)
  assert.equal(rows.length, CONTEXT_CATEGORIES.length)
  assert.deepEqual(rows.map(row => row.category), [...CONTEXT_CATEGORIES])
  const worldbook = rows.find(row => row.category === 'worldbook')
  assert.deepEqual(
    { tokens: worldbook?.tokens, share: worldbook?.share },
    { tokens: 0, share: 0 },
    'an empty category must read 0%, because "my world book is not getting through" is the answer',
  )
})

test('shares are of the itemization total and add up to it', () => {
  const entries = [
    item('chatHistory', 'history', 600),
    item('worldInfoBefore', 'system', 300),
    item('main', 'system', 100),
  ]
  const rows = categoryShares(entries, 1000)
  assert.equal(rows.reduce((sum, row) => sum + row.tokens, 0), 1000)
  // Within float error, not exactly: 0.6 + 0.3 + 0.1 is 0.9999999999999999 in
  // binary, and pinning the exact double would be pinning an artefact of the
  // fixture's numbers rather than the property that the shares are a partition.
  const summed = rows.reduce((sum, row) => sum + row.share, 0)
  assert.ok(Math.abs(summed - 1) < 1e-9, `shares summed to ${String(summed)}`)
  assert.equal(rows.find(row => row.category === 'messages')?.share, 0.6)
})

test('a zero total divides into zeroes rather than NaN', () => {
  const rows = categoryShares([item('main', 'system', 0)], 0)
  for (const row of rows) assert.equal(row.share, 0, `${row.category} produced ${String(row.share)}`)
})

test('occupancy is against the window minus the reserve, not the window', () => {
  const reading = contextOccupancy(itemization(
    [item('chatHistory', 'history', 3584)],
    { context: 8192, reserve: 1024 },
  ))
  assert.ok(reading !== null)
  // 3584 / (8192 - 1024) = 50%. Against the whole window it would be 44%, and
  // the two denominators are what this assertion is choosing between — the
  // fixture is deliberately a case where they disagree.
  assert.equal(reading.percent, 50)
  assert.equal(reading.available, 7168)
  assert.equal(reading.over, false)
})

test('an over-budget prompt clamps its bar and says so separately', () => {
  const reading = contextOccupancy(itemization(
    [item('chatHistory', 'history', 9000)],
    { context: 8192, reserve: 1024 },
  ))
  assert.ok(reading !== null)
  assert.equal(reading.percent, 100, 'the bar must not be allowed to draw past its track')
  assert.equal(reading.over, true, 'and the clamp must not be the only record that it happened')
  assert.equal(reading.usedTokens, 9000, 'the reading itself is not clamped')
})

test('no budget to divide by is no reading at all', () => {
  assert.equal(contextOccupancy(undefined), null)
  assert.equal(
    contextOccupancy(itemization([item('main', 'system', 10)], { context: 1024, reserve: 1024 })),
    null,
    'a reserve that eats the whole window leaves nothing the prompt could have spent',
  )
})

test('the bar divides the exact occupancy and drops empty parts', () => {
  const reading = contextOccupancy(itemization(
    [item('chatHistory', 'history', 2688), item('worldInfoBefore', 'system', 896)],
    { context: 8192, reserve: 1024 },
  ))
  assert.ok(reading !== null)
  const segments = meterSegments(reading)
  // Four of the six categories are empty, so four parts are dropped rather
  // than drawn at the CSS minimum width.
  assert.deepEqual(segments.map(one => one.category), ['messages', 'worldbook'])
  // The bar's overall length is the percentage printed above it, to the digit.
  const total = segments.reduce((sum, one) => sum + one.width, 0)
  assert.equal(Math.round(total * 1e6) / 1e6, reading.percent)
  assert.equal(segments[0]?.width, reading.percent * 0.75)
})

test('an empty context draws no bar at all', () => {
  const reading = contextOccupancy(itemization([item('main', 'system', 0)]))
  assert.ok(reading !== null)
  assert.deepEqual(meterSegments(reading), [], 'a filled bar over an empty context is the failure here')
})

test('the average cache hit is one ratio over the conversation, not a mean of turns', () => {
  // Two generations: 100 read of 1000 billed, and 9900 read of 10000. The
  // ratio over the whole conversation is 10000/11000 = 90.9%; averaging the
  // two per-turn percentages would say 54.5%. `ChatView.usage` is already the
  // sum, so this asserts the formula reads it as a sum.
  assert.equal(
    averageCacheHit({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 10_000 }),
    '91',
  )
  assert.equal(
    averageCacheHit({ inputTokens: 0, outputTokens: 10, cacheReadTokens: 999, cacheWriteTokens: 1 }),
    '99.9',
    'a partial hit must not round up to 100',
  )
})

test('a provider that says nothing about caching gets no line, not zero', () => {
  assert.equal(averageCacheHit(undefined), null)
  assert.equal(
    averageCacheHit({ inputTokens: 500, outputTokens: 10 }),
    null,
    '"nothing was cached" and "the provider does not report caching" are different facts',
  )
  assert.equal(averageCacheHit({ inputTokens: 500, outputTokens: 10, cacheReadTokens: 0 }), '0')
})

test('no two categories share a tint, in any of the three themes', () => {
  /*
   * The property that actually matters about these colours.
   *
   * A legend swatch is not the information carrier — the row's label and its
   * token count are — so the six are deliberately **not** held to WCAG
   * 1.4.11's 3:1 contrast floor, and two of the four borrowed tokens would
   * fail it. What cannot be allowed is two categories drawing the same colour:
   * that makes the legend unreadable and the bar a lie, and it is exactly what
   * happens when a seventh category is added and given a token that is already
   * spoken for.
   *
   * Read out of the stylesheet rather than restated here, so a tint changed in
   * `panels.css` is the thing being checked.
   */
  const panels = readFileSync(join(HERE, '..', 'src', 'app', 'panels.css'), 'utf8')
  const tokens = readFileSync(join(HERE, '..', 'src', 'theme', 'tokens.css'), 'utf8')

  const tintOf = new Map<string, string>()
  for (const match of panels.matchAll(
    /\.iris-context-card__swatch--([a-z]+)\s*\{\s*--iris-meter-tint:\s*var\((--[a-z-]+)\)/g,
  )) {
    tintOf.set(match[1] as string, match[2] as string)
  }
  assert.deepEqual(
    [...tintOf.keys()].sort(),
    [...CONTEXT_CATEGORIES].sort(),
    'every category needs a tint rule, and only the categories may have one',
  )

  for (const theme of ['light', 'dark', 'parchment'] as const) {
    const block = theme === 'light'
      ? [...tokens.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1])[1]
      : new RegExp(`:root\\[data-iris-theme='${theme}'\\]\\s*\\{([^}]*)\\}`).exec(tokens)?.[1]
    assert.ok(block !== undefined, `no ${theme} palette block`)
    const values = new Map<string, string>()
    for (const match of block.matchAll(/(--iris-[a-z-]+):\s*([^;]+);/g)) {
      values.set(match[1] as string, (match[2] as string).trim())
    }
    const drawn = new Map<string, string[]>()
    for (const [category, token] of tintOf) {
      const value = values.get(token)
      assert.ok(value !== undefined, `${theme} does not define ${token}, which ${category} draws`)
      drawn.set(value, [...(drawn.get(value) ?? []), category])
    }
    for (const [value, categories] of drawn) {
      assert.equal(
        categories.length,
        1,
        `in ${theme}, ${categories.join(' and ')} both draw ${value}`,
      )
    }
  }
})
