/**
 * Keyword matching, transcribed from SillyTavern's `WorldInfoBuffer.matchKeys`
 * and the secondary-key loop inside `checkWorldInfo`.
 *
 * Three behaviours here look like oversights and are not:
 *
 *  - **A regex key overrides everything.** `caseSensitive` and `matchWholeWords`
 *    are not applied on top of it; the pattern's own flags are the whole story.
 *    Card authors rely on this to opt out of the boundary rules entirely.
 *  - **A key containing whitespace skips the boundary check.** Upstream splits
 *    the key on `\s+` and falls back to a plain substring test when it yields
 *    more than one word, because a boundary regex around a phrase would still
 *    only guard the phrase's outer edges — the cheaper test is equivalent.
 *  - **The boundary is `\W`, not `\b`.** `\w` is ASCII-only, so every CJK
 *    character counts as a boundary. That makes whole-word matching a no-op for
 *    Chinese, Japanese and Korean keys: `络络` matches inside `我喜欢络络的笑`
 *    because both neighbours are non-word characters. This is not a workaround
 *    bolted on for CJK — it is what falls out of the ASCII definition, and
 *    happens to be the behaviour those books were written against.
 *
 * @module @iris/lorebook/matching
 */

import { parseRegexFromString } from '@iris/compat-tavernhelper-core'

/**
 * Re-exported so this package's public surface is unchanged by the move.
 *
 * The function now lives in `@iris/compat-tavernhelper-core` because the frame
 * needs the same answer this engine uses — see that module for why a second
 * copy is the failure worth designing against.
 */
export { parseRegexFromString }

import { worldInfoLogic } from './types.ts'

/**
 * Escape a string for literal use inside a regex.
 *
 * Character class copied from ST's `escapeRegex`, including the `/` — the keys
 * arriving here have already been through a `/pattern/flags` check, so a bare
 * slash must be inert rather than reopening the delimiter question.
 * @param text - the literal to escape.
 * @returns a pattern matching exactly `text`.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')
}

/** How a single key is tested against the scan buffer. */
export interface KeyMatchOptions {
  /** Compare without lowercasing. Defaults to `false`. */
  caseSensitive?: boolean
  /**
   * Require the key to sit on a non-word boundary. Defaults to `true`.
   *
   * Note that ST's own global default is `false`; Iris flips it because a
   * substring-matching key is the usual cause of a book firing on nothing at
   * all, and the per-entry `matchWholeWords` override still wins either way.
   */
  matchWholeWords?: boolean
}

/**
 * Test one key against one haystack.
 * @param haystack - the assembled scan buffer.
 * @param needle - the key, either plain text or `/pattern/flags`.
 * @param options - resolved per-entry settings.
 * @returns whether the key is present.
 */
export function matchKey(haystack: string, needle: string, options: KeyMatchOptions = {}): boolean {
  const keyRegex = parseRegexFromString(needle)
  if (keyRegex) {
    // A `g`/`y` pattern carries `lastIndex` between calls, and the same key is
    // tested against several buffers per scan. Reset so the second test is not
    // silently a continuation of the first.
    keyRegex.lastIndex = 0
    return keyRegex.test(haystack)
  }

  const caseSensitive = options.caseSensitive ?? false
  const matchWholeWords = options.matchWholeWords ?? true

  const text = caseSensitive ? haystack : haystack.toLowerCase()
  const key = caseSensitive ? needle : needle.toLowerCase()

  if (!matchWholeWords) return text.includes(key)

  if (key.split(/\s+/).length > 1) return text.includes(key)

  return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(text)
}

/**
 * Find the first key that matches.
 * @param haystack - the assembled scan buffer.
 * @param keys - keys in author order.
 * @param options - resolved per-entry settings.
 * @returns the matching key, or `undefined`.
 */
export function findMatchingKey(
  haystack: string,
  keys: readonly string[],
  options: KeyMatchOptions = {},
): string | undefined {
  return keys.find((key) => key !== '' && matchKey(haystack, key.trim(), options))
}

/**
 * Count how many of a key list match.
 * @param haystack - the assembled scan buffer.
 * @param keys - keys in author order.
 * @param options - resolved per-entry settings.
 * @returns the number of distinct keys found.
 */
export function countMatchingKeys(
  haystack: string,
  keys: readonly string[],
  options: KeyMatchOptions = {},
): number {
  return keys.reduce((total, key) => (matchKey(haystack, key, options) ? total + 1 : total), 0)
}

/**
 * Decide whether the secondary keys admit an entry whose primary key already hit.
 *
 * Upstream evaluates this inside a single loop with early returns, which makes
 * the four logics read as one algorithm; they are really two pairs. `AND_ANY`
 * and `NOT_ALL` are satisfied by the first key that does (or does not) match, so
 * they short-circuit. `NOT_ANY` and `AND_ALL` are quantifiers over the whole
 * list and can only be decided at the end. Splitting them out changes nothing
 * about the result and makes the asymmetry visible.
 *
 * An empty `matches` list reports `true` for `NOT_ANY` and `AND_ALL` — the
 * vacuous readings. Callers never reach that: an entry with no secondary keys
 * activates on the primary hit alone, before this is consulted.
 * @param logic - one of {@link worldInfoLogic}.
 * @param matches - per-secondary-key results, in author order.
 * @returns whether the entry activates.
 */
export function evaluateSelectiveLogic(logic: number, matches: readonly boolean[]): boolean {
  switch (logic) {
    case worldInfoLogic.AND_ANY:
      return matches.some((matched) => matched)
    case worldInfoLogic.NOT_ALL:
      return matches.some((matched) => !matched)
    case worldInfoLogic.NOT_ANY:
      return !matches.some((matched) => matched)
    case worldInfoLogic.AND_ALL:
      return matches.every((matched) => matched)
    default:
      // Upstream's loop falls through to `false` for an unknown logic value.
      return false
  }
}
