import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  evaluateSelectiveLogic,
  matchKey,
  parseRegexFromString,
  worldInfoLogic,
} from '../src/index.ts'

test('matching is case-insensitive by default and exact when asked', () => {
  const cases: Array<[string, string, boolean | undefined, boolean]> = [
    ['a Cat sat', 'cat', undefined, true],
    ['a Cat sat', 'cat', true, false],
    ['a Cat sat', 'Cat', true, true],
  ]

  for (const [haystack, needle, caseSensitive, expected] of cases) {
    const options = caseSensitive === undefined ? {} : { caseSensitive }
    assert.equal(matchKey(haystack, needle, options), expected, `${needle} in "${haystack}"`)
  }
})

test('matching defaults to substring; a whole-word boundary is the opt-in', () => {
  // ST ships `world_info_match_whole_words: false`, and the community's books
  // are tuned against substring keys — so the plain call here is the behaviour
  // those books were written against.
  assert.equal(matchKey('concatenate', 'cat'), true)
  assert.equal(matchKey('concatenate', 'cat', { matchWholeWords: false }), true)
  assert.equal(matchKey('concatenate', 'cat', { matchWholeWords: true }), false)
})

test('punctuation counts as a word boundary', () => {
  // The boundary is `\W`, not `\b`, so a key hugging a comma or a quote still
  // fires — which is what makes the option usable on real prose.
  assert.equal(matchKey('the dragon, asleep', 'dragon'), true)
  assert.equal(matchKey('"dragon"', 'dragon'), true)
  assert.equal(matchKey('dragon', 'dragon'), true)
})

test('whole-word matching is a no-op for CJK keys', () => {
  // `\w` is ASCII-only, so every neighbouring Han character reads as a
  // boundary. Chinese books were written against this and would break under a
  // "fixed" Unicode-aware boundary.
  assert.equal(matchKey('我喜欢络络的笑', '络络'), true)
  assert.equal(matchKey('魔法学院的图书馆', '图书馆'), true)
})

test('a multi-word key falls back to a plain substring test', () => {
  assert.equal(matchKey('the red dragon flies', 'red dragon'), true)
  assert.equal(matchKey('unred dragonfly', 'red dragon'), true)
})

test('a /pattern/flags key is a regex and overrides the other options', () => {
  assert.equal(matchKey('A Dragon appears', '/dragon/i'), true)
  assert.equal(matchKey('A Dragon appears', '/dragon/i', { caseSensitive: true }), true)
  assert.equal(matchKey('A Dragon appears', '/dragon/'), false)
  // Whole-word matching would reject this; the pattern gets the final say.
  assert.equal(matchKey('concatenate', '/cat/'), true)
})

test('a global regex key does not carry lastIndex between buffers', () => {
  const key = '/dragon/g'
  assert.equal(matchKey('a dragon', key), true)
  assert.equal(matchKey('a dragon', key), true)
})

test('parseRegexFromString rejects what is not portable', () => {
  assert.equal(parseRegexFromString('dragon'), null, 'plain text is not a regex')
  assert.equal(parseRegexFromString('/a/b/'), null, 'an unescaped delimiter is not portable')
  assert.equal(parseRegexFromString('/[/'), null, 'invalid syntax')
  assert.equal(parseRegexFromString('/dragon/i')?.source, 'dragon')
  assert.equal(parseRegexFromString('/dragon/i')?.flags, 'i')
})

test('selectiveLogic over primary plus secondary keys', () => {
  const cases: Array<{ logic: number; matches: boolean[]; expected: boolean; why: string }> = [
    { logic: worldInfoLogic.AND_ANY, matches: [false, true], expected: true, why: 'one secondary is enough' },
    { logic: worldInfoLogic.AND_ANY, matches: [false, false], expected: false, why: 'none matched' },
    { logic: worldInfoLogic.NOT_ALL, matches: [true, false], expected: true, why: 'one is missing' },
    { logic: worldInfoLogic.NOT_ALL, matches: [true, true], expected: false, why: 'all present' },
    { logic: worldInfoLogic.NOT_ANY, matches: [false, false], expected: true, why: 'none present' },
    { logic: worldInfoLogic.NOT_ANY, matches: [false, true], expected: false, why: 'one present' },
    { logic: worldInfoLogic.AND_ALL, matches: [true, true], expected: true, why: 'all present' },
    { logic: worldInfoLogic.AND_ALL, matches: [true, false], expected: false, why: 'one is missing' },
  ]

  for (const { logic, matches, expected, why } of cases) {
    assert.equal(evaluateSelectiveLogic(logic, matches), expected, why)
  }
})

test('an unknown selectiveLogic value activates nothing', () => {
  // Upstream's loop falls out to `false`. Pinned so a book from a fork with an
  // extra logic mode fails closed rather than firing on everything.
  assert.equal(evaluateSelectiveLogic(99, [true, true]), false)
})

test('the regex decision has exactly one implementation', async () => {
  // `parseRegexFromString` lives in `@iris/text` so the frame can revive
  // `strategy.keys` using the same judgement this engine matches with — it was
  // in `@iris/compat-tavernhelper-core` until 2026-09-12, which made this engine
  // depend on the Tavern Helper compat layer (root `notes/DEVIATIONS.md`, stage 0).
  // Asserted by **identity**, not behaviour: two functions that agree today are
  // two functions that can stop agreeing, and the whole point of the move was to
  // remove that possibility. If this package ever grows its own copy again, the
  // copy will pass every behavioural test in this file on the day it is written.
  //
  // The check lives here rather than beside the function because `@iris/text` is
  // dependency-free by contract — a test there importing `@iris/lorebook` would
  // be the reverse edge that contract forbids.
  const shared = await import('@iris/text') as { parseRegexFromString: unknown }
  assert.equal(parseRegexFromString, shared.parseRegexFromString)
})
