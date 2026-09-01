import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseRegexFromString } from '../src/regex.ts'

/**
 * Which world book keys are regexes.
 *
 * This function moved here from `@iris/lorebook` so that the host's activation
 * engine and the frame's `strategy.keys` revival share one answer. A second
 * hand-copied implementation drifts, and the drift is silent: a card holds a
 * `RegExp` for a key the engine matches literally, both halves are internally
 * consistent, the pair is wrong, and nothing raises anything.
 *
 * The escaped-delimiter cases exist because moving this function through a shell
 * heredoc collapsed the source. Two backslashes were lost, and they behaved
 * completely differently:
 *
 * - `[^\\]` became `[^\]`, an unterminated character class. It failed to
 *   compile, and the compiler said so.
 * - `'\\/'` became `'\/'`, which JavaScript reads as plain `'/'` — turning the
 *   unescape below into a no-op that compiles and type-checks cleanly.
 *
 * Measured afterwards, that second collapse is **behaviourally inert**: `\/`
 * inside a pattern is already an escaped slash, so the intact and the collapsed
 * version match the same strings. So the lesson is not the tempting "a surviving
 * backslash matches something else" — it is the harder one: **a surviving
 * backslash still parses, and whether it still means the same thing has to be
 * measured rather than assumed.** Both are reasons to move code like this by
 * copying the file rather than retyping it.
 */

test('a plain key is not a regex', () => {
  assert.equal(parseRegexFromString('tower'), null)
  assert.equal(parseRegexFromString(''), null)
  // A lone delimiter pair with nothing inside is not a pattern either — the
  // body is required to be non-empty.
  assert.equal(parseRegexFromString('//'), null)
})

test('a delimited key compiles, with its flags', () => {
  const pattern = parseRegexFromString('/tow(er|el)/i')
  assert.ok(pattern instanceof RegExp)
  assert.equal(pattern.source, 'tow(er|el)')
  assert.equal(pattern.flags, 'i')
  assert.equal(pattern.test('THE TOWER'), true)
})

test('an escaped delimiter compiles and matches the literal slash', () => {
  // Asserted on behaviour rather than on `.source`, because `source` re-escapes
  // forward slashes: a correct unescape and a broken one both render as `a\/b`
  // there, so a string assertion would pass either way — the same shape as the
  // tautological assertions this project has caught before.
  const one = parseRegexFromString('/a\\/b/i')
  assert.ok(one instanceof RegExp)
  assert.equal(one.test('a/b'), true)

  // Two escaped delimiters. Upstream's `replace` with a string needle unescapes
  // only the first; reproduced rather than corrected, because a key already in
  // the wild has to activate here exactly as it does in SillyTavern.
  const two = parseRegexFromString('/a\\/b\\/c/')
  assert.ok(two instanceof RegExp)
  assert.equal(two.test('a/b/c'), true)
  assert.equal(two.test('a/b'), false)
})

test('an unescaped delimiter inside the body is refused', () => {
  // Stricter than `new RegExp` needs, deliberately: such a key would be a
  // different regex in every other engine reading the same book. Refusing it
  // makes the key fall back to plaintext matching, so it still does something.
  assert.equal(parseRegexFromString('/a/b/'), null)
})

test('a body that will not compile falls back to plaintext', () => {
  // A card author's typo should cost them one key's pattern matching, not the
  // whole scan.
  assert.equal(parseRegexFromString('/(unclosed/'), null)
  assert.equal(parseRegexFromString('/a/qq'), null)
})
