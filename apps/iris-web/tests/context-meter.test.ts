/**
 * The context-capacity reading: its classification, its arithmetic, which
 * account of the prompt the capsule draws, where its window came from, and the
 * one property both sets of colours have to have — the card's six category
 * tints and the capsule gauge's three bands.
 *
 * @module iris-web/tests/context-meter
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  CACHE_STALE_MS,
  providerExcuse,
  type PromptDivergence,
  type PromptDivergenceItem,
  type PromptItemEntry,
  type PromptItemization,
} from '@iris/protocol'

import {
  averageCacheHit,
  capsuleReading,
  categoryOf,
  categoryShares,
  contextOccupancy,
  CONTEXT_CATEGORIES,
  meterSegments,
  PRESSURE_FULL,
  PRESSURE_NEAR,
  pressureLevel,
  windowSourceKey,
} from '../src/app/context-occupancy.ts'
import {
  cacheCeiling,
  itemName,
  providerFellShort,
  providerShare,
  unservedItems,
} from '../src/app/divergence.ts'
import { en, zh } from '../src/app/i18n/strings.ts'

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

/**
 * Two adjacent requests, byte-for-byte, as the divergence line reads them.
 *
 * Every number here disagrees with the plausible wrong denominator: 28 209
 * shared of 34 563 sent is 81.6% against the newer body and 83.2% against the
 * older, and the newer is the one a prefix cache serves — `CACHE-PREFIX.md`
 * §1.2 computes its ceiling column the same way, so the two are comparable.
 * @param over - fields to replace.
 * @returns the comparison.
 */
function divergence(over: Partial<PromptDivergence> = {}): PromptDivergence {
  return {
    chatId: 'aiyi',
    seq: 7,
    previousSeq: 6,
    at: Date.UTC(2026, 8, 7, 4, 12, 30),
    previousAt: Date.UTC(2026, 8, 7, 4, 9, 12),
    kind: 'send',
    previousKind: 'send',
    model: 'deepseek-reasoner',
    previousModel: 'deepseek-reasoner',
    provider: 'deepseek',
    previousProvider: 'deepseek',
    bytes: 34_563,
    previousBytes: 33_905,
    divergedAt: 28_209,
    uncacheableBytes: 6_354,
    addedBytes: 1_350,
    changedBytes: 3_157,
    repeatedBytes: 1_647,
    structureBytes: 200,
    items: [],
    attributed: true,
    ...over,
  }
}

test('the ceiling divides by the request being sent, not the one before it', () => {
  // 28 209 / 34 563 = 81.6%. Against the previous body it would be 83.2%, and
  // those two are what this assertion chooses between: a prefix cache serves a
  // prefix of the *new* request, so the new body is the denominator.
  assert.equal(Math.round(cacheCeiling(divergence()) * 1000) / 10, 81.6)
  assert.notEqual(Math.round(cacheCeiling(divergence()) * 1000) / 10, 83.2)
})

test('the provider share is over billed tokens, cache included', () => {
  // `inputTokens` excludes what the cache served, so the billed total is the
  // sum — the same arithmetic `billedInputTokens` does for the usage line. A
  // reader who divided by `inputTokens` alone would get 46%, not 31.4%, and the
  // fixture is chosen so the two disagree.
  const row = divergence({ cacheReadTokens: 3_456, inputTokens: 7_563 })
  assert.equal(Math.round((providerShare(row) ?? 0) * 1000) / 10, 31.4)
})

test('a provider that reports no caching gets no share, not a zero', () => {
  assert.equal(providerShare(divergence()), null)
  assert.equal(providerShare(divergence({ cacheReadTokens: 0, inputTokens: 8_612 })), 0)
})

test('a shortfall is only reported when nothing ordinary explains it', () => {
  /*
   * The measured case first: `OVERLORD-沙盒` line 3 → line 5 in the user's own
   * corpus has a byte-identical prefix and reports `prompt_cache_hit_tokens: 0`.
   * That is the finding, and it must survive.
   */
  const bare = divergence({ cacheReadTokens: 0, inputTokens: 8_612 })
  assert.equal(providerExcuse(bare), null)
  assert.equal(providerFellShort(bare), true)

  /*
   * And the conditions under which the same numbers mean nothing. Each is a
   * documented property of DeepSeek's cache, or of a reply that never finished,
   * and each on its own explains a miss on an identical prompt — so each must
   * suppress the finding, or the report opens with false alarms.
   */
  assert.equal(providerExcuse(divergence({ ...bare, seq: 1, previousSeq: 0 })), 'cold-start')
  assert.equal(providerFellShort(divergence({ ...bare, seq: 1, previousSeq: 0 })), false)

  const gap = divergence({ ...bare, previousAt: bare.at - (CACHE_STALE_MS + 1) })
  assert.equal(providerExcuse(gap), 'stale')
  assert.equal(providerFellShort(gap), false)

  const switched = divergence({ ...bare, previousModel: 'deepseek-chat' })
  assert.equal(providerExcuse(switched), 'route')
  assert.equal(providerFellShort(switched), false)

  /*
   * The interrupted case is a *stronger* suppressor than the other three: the
   * request was never served, so `0` is not a provider refusing the cache but
   * the absence of any bill — and it is exactly the shape measured on 爱衣's own
   * turns (2026-09-09), where a saved profile's cut-short replies reported the
   * bare word `terminated` and nothing in the record said the turn had failed.
   */
  const interrupted = divergence({ ...bare, error: 'connection to the provider was closed by the peer while the reply was streaming; no usage was reported for this turn' })
  assert.equal(providerExcuse(interrupted), 'interrupted')
  assert.equal(providerFellShort(interrupted), false)
  // A long gap and an interrupted reply both apply; the interruption must win,
  // because it is checked first and because its reading of the absent usage is
  // the only one that is not a guess.
  const interruptedAndStale = divergence({ ...interrupted, previousAt: interrupted.at - (CACHE_STALE_MS + 1) })
  assert.equal(providerExcuse(interruptedAndStale), 'interrupted')

  // Just inside the window is not stale: a threshold that fired at exactly the
  // boundary would suppress the finding on an ordinary two-minute exchange.
  const near = divergence({ ...bare, previousAt: bare.at - (CACHE_STALE_MS - 1) })
  assert.equal(providerExcuse(near), null)
  assert.equal(providerFellShort(near), true)
})

test('a floor is named by its number, and every other part by its own label', () => {
  const floor = (n: string): string => `floor ${n}`
  assert.equal(itemName({ id: 'history.6', label: 'history.6', kind: 'history' }, floor), 'floor 6')
  // A part whose author gave it a name keeps it, generated ids being the only
  // ones this translates — a blanket rewrite would replace 「状态栏格式」 with
  // something a user has never seen in SillyTavern either.
  assert.equal(itemName({ id: 'worldInfoAfter', label: 'World Info (after)', kind: 'system' }, floor), 'World Info (after)')
})

test('the parts worth showing are the ones that cost something, worst first', () => {
  const item = (id: string, uncachedBytes: number, state: PromptDivergenceItem['state']): PromptDivergenceItem => (
    { id, label: id, kind: 'system', state, bytes: uncachedBytes, previousBytes: 0, uncachedBytes }
  )
  const rows = unservedItems(divergence({
    items: [
      item('cached', 0, 'same'),
      item('small', 100, 'changed'),
      // The measured shape: unchanged to the byte and re-billed in full. It must
      // outrank a part that actually changed, because it is the larger cost and
      // the recoverable one.
      item('stranded', 5_367, 'same'),
      item('vanished', 0, 'gone'),
    ],
  }))
  assert.deepEqual(rows.map(row => row.id), ['stranded', 'small'])
})

test('the card carries the divergence line, its handle, and no seventh swatch', () => {
  /*
   * Read off the source, because the card only renders once the capsule is
   * pressed and neither the server render nor this file can press it. Three
   * properties, and each has a way of going wrong that nothing else here
   * notices:
   *
   * 1. **The handle.** `data-control` is how the QA locators address a control,
   *    and a line with no handle cannot be driven or screenshotted.
   * 2. **The line goes somewhere.** One sentence cannot name eleven sections, so
   *    it opens the prompt panel; a `<p>` that only printed the percentage would
   *    look finished and be a dead end.
   * 3. **No swatch.** The test below asserts that every
   *    `iris-context-card__swatch--*` rule names a context category and only a
   *    category, so a new card row that introduced one would fail there with a
   *    message about colours rather than about this line.
   */
  const source = readFileSync(join(HERE, '..', 'src', 'app', 'ContextMeter.tsx'), 'utf8')
  assert.match(source, /data-control="context-divergence"/, 'the divergence line has no locator handle')
  assert.match(source, /onClick=\{onOpenPanel\}/, 'the divergence line does not open the prompt panel')
  assert.match(source, /t\('divergenceLine'/, 'the divergence line is not built from the dictionary')
  assert.match(source, /t\('divergenceIdentical'/, 'two identical requests get no sentence of their own')
  assert.equal(
    /iris-context-card__swatch--diverge/.test(source),
    false,
    'the divergence line must not mint a swatch class, which the tint census would then refuse',
  )
})

// ------------------------------------------------- the capsule's own gauge

test('the three bands break at 60 and 85, and the middle one owns both ends', () => {
  /*
   * The boundaries as boundaries, not as midpoints — a test at 30/70/95 passes
   * for a rule shifted by five points in either direction, which is the only
   * way this can be wrong.
   */
  assert.equal(pressureLevel(0), 'quiet')
  assert.equal(pressureLevel(PRESSURE_NEAR - 1), 'quiet')
  assert.equal(pressureLevel(PRESSURE_NEAR), 'near')
  assert.equal(pressureLevel(PRESSURE_FULL), 'near')
  assert.equal(pressureLevel(PRESSURE_FULL + 1), 'full')
  assert.equal(pressureLevel(100), 'full')
})

test('the capsule reads a recorded measurement with no itemization at all', () => {
  // The whole point of `ChatView.measured`: a bar before anything is pressed,
  // paid for by an assembly that already happened.
  const reading = capsuleReading({ context: 8192, reserve: 1024 }, undefined, { turn: 7, tokens: 3584 })
  assert.ok(reading !== null)
  assert.equal(reading.percent, 50, '3584 / (8192 - 1024) is 50%')
  assert.equal(reading.available, 7168, 'the reserve was not held back')
  assert.equal(reading.basis, 'record')
  assert.equal(reading.turn, 7)
  assert.equal(reading.level, 'quiet')
})

test('a fetched preview outranks the recorded measurement', () => {
  /*
   * The correction. A record is the cheaper fact, but once the card is open the
   * card is showing the *preview* — and a capsule printing a different number
   * one line under the card that explains it is two surfaces disagreeing about
   * one conversation. So the preview wins while there is one, and `basis` says
   * which is on screen.
   */
  const preview: PromptItemization = {
    ...itemization([item('main', 'system', 6000)]),
    preview: true,
    turn: 9,
  }
  const reading = capsuleReading({ context: 8192, reserve: 1024 }, preview, { turn: 7, tokens: 100 })
  assert.ok(reading !== null)
  assert.equal(reading.usedTokens, 6000, 'the recorded number won over the fetched one')
  assert.equal(reading.basis, 'preview')
  assert.equal(reading.turn, undefined, 'a preview was dated to a turn it is not about')
  assert.equal(reading.level, 'near', '6000 / 7168 is 84%')
})

test('a fetched record keeps its own turn rather than the projected one', () => {
  // `prompt.itemize` with a turn can answer with a record. When it does, the
  // reading on screen is that turn's, not whatever the view last projected.
  const record = { ...itemization([item('main', 'system', 700)]), preview: false, turn: 4 }
  const reading = capsuleReading({ context: 8192, reserve: 1024 }, record, { turn: 7, tokens: 3584 })
  assert.equal(reading?.basis, 'record')
  assert.equal(reading?.turn, 4)
})

test('nothing measured and nothing fetched is no reading, not a zero', () => {
  // What every conversation looks like right after the host restarts: those
  // records live in memory. The capsule states its capacity alone there, which
  // it can only do if this says `null` rather than 0%.
  assert.equal(capsuleReading({ context: 8192, reserve: 1024 }, undefined, undefined), null)
  // And a window entirely spoken for by the reserve divides by nothing.
  assert.equal(capsuleReading({ context: 1024, reserve: 1024 }, undefined, { turn: 1, tokens: 10 }), null)
})

test('an over-budget measurement clamps its bar and still says it is over', () => {
  const reading = capsuleReading({ context: 8192, reserve: 1024 }, undefined, { turn: 2, tokens: 9000 })
  assert.equal(reading?.percent, 100, 'the bar would have drawn past the capsule')
  assert.equal(reading?.over, true)
  assert.equal(reading?.level, 'full')
})

test('each window provenance names a sentence, and both locales carry it', () => {
  /*
   * Four cases, four different next steps for the reader — and `'model'`, the
   * clamped one, is the case that did not exist at all before this task: a
   * 2 000 000-token window sat under a 1M model with nothing on any surface
   * saying who had asked for it.
   */
  const keys = {
    model: 'contextWindowFromModel',
    settings: 'contextWindowFromSettings',
    unlocked: 'contextWindowUnlocked',
    host: 'contextWindowFromHost',
  } as const
  for (const [source, key] of Object.entries(keys)) {
    assert.equal(windowSourceKey(source as keyof typeof keys), key, `${source} names the wrong sentence`)
    assert.ok(en[key].includes('{tokens}'), `${key} does not print the window it is about`)
    assert.ok(zh[key].includes('{tokens}'), `zh ${key} does not print the window it is about`)
  }
  /*
   * The two that name a model must; the two that do not must not.
   * `windowSourceText` passes every slot for every case — one call site is what
   * keeps four sentences from drifting into four vocabularies — so a stray
   * `{model}` in the host-default sentence would render a real model name in a
   * sentence that was never judged against one.
   */
  assert.ok(en[keys.model].includes('{model}'))
  assert.ok(en[keys.unlocked].includes('{modelTokens}'), 'the unlocked sentence hides the limit being exceeded')
  assert.ok(!en[keys.host].includes('{model}'), 'the host default names a model it was not judged against')
  assert.ok(!en[keys.settings].includes('{model}'), 'the settings sentence names a model that decided nothing')
})

test('no two gauge bands draw the same colour, in any of the three themes', () => {
  /*
   * The property the six category tints are held to above, for the same reason:
   * a band drawing its neighbour's colour is a gauge with two levels in that
   * theme and three everywhere else, and 「it has gone plum」 stops being a fact
   * a reader can carry away.
   *
   * Read out of the stylesheet, so a tint changed in `panels.css` is the thing
   * being checked.
   */
  const panels = readFileSync(join(HERE, '..', 'src', 'app', 'panels.css'), 'utf8')
  const tokens = readFileSync(join(HERE, '..', 'src', 'theme', 'tokens.css'), 'utf8')

  const tintOf = new Map<string, string>()
  for (const match of panels.matchAll(
    /\.iris-composer__pill-fill--([a-z]+)\s*\{\s*--iris-gauge-tint:\s*var\((--[a-z-]+)\)/g,
  )) {
    tintOf.set(match[1] as string, match[2] as string)
  }
  assert.deepEqual(
    [...tintOf.keys()].sort(),
    ['full', 'near', 'quiet'],
    'every band needs a tint rule, and only the bands may have one',
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
    for (const [band, token] of tintOf) {
      const value = values.get(token)
      assert.ok(value !== undefined, `${theme} does not define ${token}, which ${band} draws`)
      drawn.set(value, [...(drawn.get(value) ?? []), band])
    }
    for (const [value, bands] of drawn) {
      assert.equal(bands.length, 1, `in ${theme}, ${bands.join(' and ')} both draw ${value}`)
    }
  }
})
