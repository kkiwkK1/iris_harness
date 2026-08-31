/**
 * Turning a stored pattern string into a `RegExp`.
 *
 * Cards store the pattern as text, sometimes bare (`<StatusPlaceHolderImpl/>`)
 * and sometimes delimited (`/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gm`).
 * Both forms are in the wild, so both have to parse, and a pattern that cannot
 * compile has to fail quietly — a card with one broken script must still work.
 *
 * @module @iris/regex/parse
 */

/**
 * Flag letters upstream accepts.
 *
 * Wider than JavaScript's own set: `x`, `X`, `A`, `J` and `U` are PCRE flags
 * that reached these files through cards written for other tools. They pass
 * validation here and then fail at `new RegExp`, which lands in the same
 * quiet-failure path as any other bad pattern. Narrowing the set would reject
 * such a script one step earlier for no practical gain and would diverge from
 * upstream for no reason.
 */
const VALID_FLAGS = /^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/

/** Splits an optional `/…/flags` wrapper from the pattern it delimits. */
const DELIMITED = /(\/?)(.+)\1([a-z]*)/i

/**
 * Compile a stored pattern.
 * @param input - the pattern, bare or in `/pattern/flags` form.
 * @returns the compiled expression, or `undefined` when it cannot compile.
 */
export function regexFromString(input: string): RegExp | undefined {
  try {
    const parts = DELIMITED.exec(input)
    if (parts === null) return new RegExp(input)

    const flags = parts[3] ?? ''
    // Duplicate or unknown flags mean the slashes were probably part of the
    // pattern rather than delimiters, so the whole string is the pattern.
    if (flags.length > 0 && !VALID_FLAGS.test(flags)) return new RegExp(input)

    return new RegExp(parts[2] as string, flags)
  } catch {
    return undefined
  }
}

/** Regex metacharacters that must be neutralised inside a substituted value. */
const METACHARACTERS = /[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs

/**
 * Escape a macro's expansion so it matches literally.
 *
 * Without this, a character named `A.B` in a pattern built from `{{char}}`
 * would match `AxB` as well — the `ESCAPED` substitution mode exists precisely
 * to stop a name from being read as syntax.
 * @param value - the expanded macro value.
 * @returns the value, safe to embed in a pattern.
 */
export function escapeForPattern(value: string): string {
  return value.replace(METACHARACTERS, (character) => {
    switch (character) {
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      case '\v': return '\\v'
      case '\f': return '\\f'
      case '\0': return '\\0'
      default: return `\\${character}`
    }
  })
}
