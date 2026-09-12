/**
 * Which world book keys are regexes, decided once for both trust domains.
 *
 * This lives here rather than in `@iris/lorebook` because two very different
 * places need the *same* answer:
 *
 * - the **host's** activation engine, deciding whether a key matches the scan
 *   buffer as a pattern or as plain text;
 * - the **frame**, reviving `strategy.keys` into real `RegExp` objects before a
 *   card script sees them, because a `RegExp` cannot cross a JSON boundary and
 *   arrives as `{}`.
 *
 * A hand-copied second implementation is the failure worth designing against:
 * it drifts, and then a card holds a `RegExp` for a key the engine is matching
 * literally. Both halves are internally consistent, the pair is wrong, and
 * nothing raises anything. Sharing the function is what makes that impossible.
 *
 * It is in `@iris/text` because that package is on the browser's import
 * allowlist and is admitted on the strength of having no dependencies at all —
 * so this file imports nothing, and must keep importing nothing. It lived in
 * `@iris/compat-tavernhelper-core` until 2026-09-12 for the same reason (root
 * `notes/DEVIATIONS.md`, stage 0); what moved it is that `@iris/lorebook`, a generic
 * engine, had to declare a dependency on the Tavern Helper compat package to
 * read one pattern.
 *
 * @module @iris/text/regex
 */

/**
 * Read a `/pattern/flags` key as a real `RegExp`.
 *
 * The unescaped-delimiter rejection is deliberate and stricter than JavaScript
 * needs: `new RegExp` does not care about delimiters, but a key written with a
 * bare `/` inside would be a different regex in every other engine that reads
 * the same book. Refusing it here keeps the key portable — and, because callers
 * fall back to plaintext matching on `null`, the key still does something
 * rather than silently matching nothing.
 * @param input - a key as the author typed it.
 * @returns the compiled pattern, or `null` if this key is plain text.
 */
export function parseRegexFromString(input: string): RegExp | null {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(input)
  if (!match) return null

  const [, rawPattern, flags] = match
  if (rawPattern === undefined || flags === undefined) return null
  if (/(^|[^\\])\//.test(rawPattern)) return null

  // Upstream's `replace` with a string needle only unescapes the first slash.
  // Reproduced rather than fixed: a key with two escaped slashes compiles to
  // the same thing here as it does in ST, and "correct" would mean a different
  // set of activations.
  const pattern = rawPattern.replace('\\/', '/')

  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}
