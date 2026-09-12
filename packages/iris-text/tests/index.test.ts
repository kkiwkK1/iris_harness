import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseRegexFromString, stringHash } from '../src/index.ts'

/**
 * The move is pinned by the numbers, not by the diff.
 *
 * `stringHash` and `parseRegexFromString` changed package on 2026-09-12 (root
 * `notes/DEVIATIONS.md`, stage 0). A move is exactly the edit that produces no
 * behavioural symptom while it is wrong: `git` reports a rename, every existing
 * assertion in `@iris/lorebook` and `@iris/macro` is written against whatever
 * the imported function does, and a hash that came out of the move one bit
 * different would leave both engines internally consistent and silently
 * incompatible with every chat SillyTavern ever wrote.
 *
 * So the expected values below were **taken by running the function on
 * `main`'s `@iris/compat-tavernhelper-core` before a single file was touched**,
 * and they are literals here rather than a comparison against the old module —
 * the old module is gone, and a test that imports the new one twice proves
 * nothing. This is the teeth of ruling 1: retyping the body instead of copying
 * the file, or "modernising" `Math.imul` into `*`, or walking code points with
 * `for…of` instead of UTF-16 code units with `charCodeAt`, each produces
 * working code and a different number, and each reddens a line here.
 *
 * The astral case is the one that discriminates `charCodeAt` from `for…of`:
 * ASCII and BMP Chinese hash identically under both, so a suite without an
 * emoji in it cannot see that rewrite at all.
 */

/** Read from `@iris/compat-tavernhelper-core` at b1bb139, before the move. */
const HASHES: ReadonlyArray<readonly [string, number, number]> = [
  // input, stringHash(input), stringHash(input, 7)
  ['', 3338908027751811, 3303188273399753],
  ['tower', 6129580172663358, 7228497417083455],
  ['iris', 3208409214457311, 2301482335191200],
  ['龙', 6283590729210438, 2818333413695905],
  ['🙂', 5813621503378343, 8252020573394710],
  ['The quick brown fox', 3334773827374378, 1231692936160314],
]

test('stringHash answers the numbers it answered before the move', () => {
  let compared = 0
  for (const [input, expected, seeded] of HASHES) {
    assert.equal(stringHash(input), expected, `stringHash(${JSON.stringify(input)}) changed`)
    assert.equal(stringHash(input, 7), seeded, `stringHash(${JSON.stringify(input)}, 7) changed`)
    compared += 1
  }
  // A loop that silently compared nothing is the way this test fails green.
  assert.equal(compared, 6, 'every fixture must be compared')
})

test('the seed reaches the number', () => {
  // `seed = 0` is the default every caller uses; a body that dropped the
  // parameter would pass every assertion above except this one.
  assert.notEqual(stringHash('tower'), stringHash('tower', 7))
})

test('parseRegexFromString round-trips a pattern with flags', () => {
  const pattern = parseRegexFromString('/a+/gi')

  assert.ok(pattern instanceof RegExp, 'a /pattern/flags key is a regex')
  assert.equal(pattern.source, 'a+')
  // Flags come back in the specification's canonical order, not as typed.
  assert.equal(pattern.flags, 'gi')
  assert.equal(String(pattern), '/a+/gi', 'the key survives a round trip through String()')
})

test('parseRegexFromString refuses what is not a pattern', () => {
  assert.equal(parseRegexFromString('tower'), null, 'plain text is a plaintext key')
  assert.equal(parseRegexFromString('/a/b/'), null, 'an unescaped delimiter is not portable')
  assert.equal(parseRegexFromString('/(unclosed/'), null, 'invalid syntax is not a regex')
})
