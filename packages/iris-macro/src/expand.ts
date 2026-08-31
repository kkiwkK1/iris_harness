/**
 * `{{macro}}` expansion.
 *
 * ## How many passes, and is the result rescanned
 *
 * SillyTavern has two answers, because it has two engines.
 *
 * The shipping one (`evaluateMacros` in `public/scripts/macros.js`) is a fixed
 * ordered list of regexes, each applied once over the whole string:
 *
 * ```js
 * const macros = [...preEnvMacros, ...envMacros, ...postEnvMacros];
 * for (const macro of macros) {
 *     if (!content) break;
 *     if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;
 *     content = content.replace(macro.regex, (...args) => postProcessFn(macro.replace(...args)));
 * }
 * ```
 *
 * So it is one pass in aggregate, and a macro's output *is* rescanned — but
 * only by the macros further down the list. That ordering is load-bearing and
 * `script.js` says so at the point where it matters:
 *
 * ```js
 * // Must be substituted last so that they're replaced inside {{description}}
 * environment.user = _name1 ?? name1;
 * environment.char = _name2 ?? name2;
 * ```
 *
 * The experimental engine (`scripts/macros/engine/MacroEngine.js`) parses
 * instead, and resolves strictly inner-to-outer with no rescanning at all:
 * arguments are evaluated before the handler runs, the handler's return value
 * is spliced in verbatim, and a handler that wants more calls `resolve()`
 * itself. Its unknown-macro path is the shape this module copies:
 *
 * ```js
 * if (!defOverride && !MacroRegistry.hasMacro(name)) {
 *     return raw; // Unknown macro: keep macro syntax, but nested macros inside rawInner are already resolved.
 * }
 * ```
 *
 * ## What Iris does
 *
 * Iris follows the parsing engine: **one left-to-right pass, inner-to-outer,
 * results never rescanned**, plus an explicit opt-in (`invocation.expand`) for
 * the handful of macros that genuinely need it. A blanket rescan is not merely
 * slower — it makes stored text executable. `{{getvar::bio}}` whose value a
 * card wrote as `{{setvar::jailbroken::1}}` would take effect, and two
 * variables referring to each other would spin forever.
 *
 * The opt-in restores the one legacy behaviour cards actually depend on: the
 * card-field macros in `builtins.ts` re-expand their own output, which is what
 * the `substituted last` comment above buys upstream, so a description written
 * as "{{char}} met {{user}} in Vienna" still resolves. It is depth-capped, so a
 * description containing `{{description}}` terminates instead of recursing.
 *
 * Unknown macros come back as `{{...}}`, never as `''`. An unrecognised macro
 * is nearly always some other extension's — Tavern Helper's regex macros run
 * *after* this pass precisely because SillyTavern leaves their syntax alone —
 * and blanking it silently corrupts the prompt in a way nothing downstream can
 * detect.
 *
 * @module @iris/macro/expand
 */

import { defaultRegistry } from './builtins.ts'
import type {
  MacroContext,
  MacroInvocation,
  MacroLikeContext,
  MacroRegistry,
} from './registry.ts'

/** Knobs for one expansion. */
export interface ExpandOptions {
  /** Where macros are looked up. Defaults to the builtins-only registry. */
  readonly registry?: MacroRegistry
  /**
   * How deeply `invocation.expand` may nest before it gives up and returns its
   * input unchanged. Guards mutually-referential card fields.
   */
  readonly maxDepth?: number
  /**
   * Transform each resolved macro value before it is written into the result.
   *
   * Applies to what a macro EXPANDED TO, never to the literal text around it —
   * which is the distinction the caller needs. A regex script built from
   * `{{char}}` has to escape the name so a character called `A.B` does not also
   * match `AxB`, while the pattern's own regex syntax must survive untouched.
   *
   * Applied only at the outermost level. A handler that composes its value from
   * `invocation.expand` would otherwise see its inner values transformed once on
   * the way in and again on the way out — escaping twice, yielding `\.` where
   * `\.` was meant.
   */
  readonly postProcess?: (value: string) => string
}

/**
 * Cheap test for "could this text possibly contain anything to expand".
 *
 * Not `/g` on purpose: a global regex carries `lastIndex` between `test` calls
 * and would start skipping matches.
 */
const EXPANDABLE = /\{\{|\\[{}]|<(?:USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/i

/** Legacy angle-bracket markers, rewritten to their macro spellings. */
const LEGACY_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<USER>/gi, '{{user}}'],
  [/<BOT>/gi, '{{char}}'],
  [/<CHAR>/gi, '{{char}}'],
  [/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}'],
  [/<GROUP>/gi, '{{group}}'],
]

/**
 * `{{trim}}` eats the newlines around itself, which no single macro can express
 * — its effect reaches outside its own braces. SillyTavern solves it the same
 * way, with a post-pass over the finished text.
 */
const TRIM_PATTERN = /(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi

/** `\{` and `\}` are literal braces; the backslashes come off at the very end. */
const ESCAPED_BRACE = /\\([{}])/g

/** Mutable state threaded through one expansion. */
interface ExpandState {
  readonly registry: MacroRegistry
  readonly context: MacroContext
  readonly source: string
  readonly scratch: Map<string, unknown>
  readonly maxDepth: number
  readonly postProcess?: (value: string) => string
  depth: number
}

/** A parsed macro call: a name plus its `::`-separated arguments. */
interface MacroCall {
  readonly name: string
  readonly args: string[]
}

/**
 * Find the `}}` closing the `{{` at `start`.
 *
 * Brace-counting rather than a regex, because arguments may hold whole macros
 * (`{{getvar::{{char}}_hp}}`) and `[^}]+` cannot see that.
 * @param text - the text being scanned.
 * @param start - index of the opening `{`.
 * @returns the index just past the closing `}}`, or `-1` when unterminated.
 */
function findClose(text: string, start: number): number {
  let depth = 0
  let index = start
  while (index < text.length) {
    const ch = text[index]
    if (ch === '\\' && (text[index + 1] === '{' || text[index + 1] === '}')) {
      index += 2
      continue
    }
    if (ch === '{' && text[index + 1] === '{') {
      depth += 1
      index += 2
      continue
    }
    if (ch === '}' && text[index + 1] === '}') {
      depth -= 1
      index += 2
      if (depth === 0) return index
      continue
    }
    index += 1
  }
  return -1
}

/**
 * Split on a separator, ignoring anything inside a nested `{{...}}`.
 *
 * Needed because an unresolved inner macro can survive into the argument text —
 * `{{myext::{{alsoUnknown::a::b}}}}` has one argument, not three.
 * @param text - the argument string.
 * @returns the pieces, separators removed.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let index = 0
  while (index < text.length) {
    if (text.startsWith('{{', index)) {
      depth += 1
      index += 2
      continue
    }
    if (text.startsWith('}}', index)) {
      depth = Math.max(0, depth - 1)
      index += 2
      continue
    }
    if (depth === 0 && text.startsWith('::', index)) {
      parts.push(text.slice(start, index))
      index += 2
      start = index
      continue
    }
    index += 1
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * Where the macro name ends.
 *
 * Three separators are accepted because SillyTavern accepts three:
 * `{{roll::1d20}}` (current), `{{random:a,b}}` (single colon), and
 * `{{datetimeformat YYYY-MM-DD}}` (whitespace, the legacy regex's spelling).
 * @param body - the text between the braces, trimmed.
 * @returns the index and length of the separator, or `undefined` when the macro
 *   takes no arguments.
 */
function findSeparator(body: string): { at: number; length: number } | undefined {
  let depth = 0
  let index = 0
  while (index < body.length) {
    if (body.startsWith('{{', index)) {
      depth += 1
      index += 2
      continue
    }
    if (body.startsWith('}}', index)) {
      depth = Math.max(0, depth - 1)
      index += 2
      continue
    }
    if (depth === 0) {
      if (body.startsWith('::', index)) return { at: index, length: 2 }
      const ch = body[index]
      if (ch === ':') return { at: index, length: 1 }
      if (ch !== undefined && /\s/.test(ch)) return { at: index, length: 1 }
    }
    index += 1
  }
  return undefined
}

/** `{{time_UTC-10}}` is the one legacy spelling that hides its argument in the name. */
const LEGACY_TIME_UTC = /^time_(UTC[+-]\d+)$/i

/**
 * Parse the text between braces into a name and arguments.
 *
 * Arguments are trimmed. Upstream's older regexes did not trim, but the parsing
 * engine does and its own examples rely on it (`{{ timeDiff :: a :: b }}`);
 * whitespace hugging a `::` is never intentional.
 * @param body - the text between `{{` and `}}`, with nested macros already expanded.
 * @returns the call, or `undefined` when there is no name to look up.
 */
function parseCall(body: string): MacroCall | undefined {
  const trimmed = body.trim()
  if (trimmed === '') return undefined

  // `{{// anything at all}}` is a comment; its "arguments" are prose and must
  // not be parsed as such.
  if (trimmed.startsWith('//')) return { name: '//', args: [trimmed.slice(2).trim()] }

  const separator = findSeparator(trimmed)
  if (separator === undefined) {
    const utc = LEGACY_TIME_UTC.exec(trimmed)
    if (utc?.[1] !== undefined) return { name: 'time', args: [utc[1]] }
    return { name: trimmed, args: [] }
  }

  const name = trimmed.slice(0, separator.at).trim()
  const rest = trimmed.slice(separator.at + separator.length)
  const parts = splitTopLevel(rest)
  // A single-colon or whitespace introducer still yields a `::` list when the
  // remainder holds one — `{{random:a::b::c}}`. Otherwise the remainder is one
  // argument, and comma-splitting (if any) is the macro's own business.
  const args = parts.length > 1 ? parts : [rest]
  return { name, args: args.map(argument => argument.trim()) }
}

/**
 * Expand every macro in `text`.
 * @param text - the text to walk.
 * @param base - offset of `text` within the text being expanded, so `{{pick}}`
 *   sees a position that is stable across nesting.
 * @param state - the shared expansion state.
 * @returns the expanded text.
 */
function expandText(text: string, base: number, state: ExpandState): string {
  let out = ''
  let index = 0

  while (index < text.length) {
    const ch = text[index]

    if (ch === '\\' && (text[index + 1] === '{' || text[index + 1] === '}')) {
      // Carried through as-is; the backslash comes off in the final pass, so a
      // macro that consumed this text still sees the escape.
      out += text.slice(index, index + 2)
      index += 2
      continue
    }

    if (ch !== '{' || text[index + 1] !== '{') {
      out += ch
      index += 1
      continue
    }

    const close = findClose(text, index)
    if (close === -1) {
      // Unterminated `{{` is ordinary text, not an error.
      out += '{{'
      index += 2
      continue
    }

    const inner = expandText(text.slice(index + 2, close - 2), base + index + 2, state)
    const raw = `{{${inner}}}`
    const call = parseCall(inner)
    const offset = base + index

    let value: string | undefined
    if (call !== undefined) {
      const invocation: MacroInvocation = {
        name: call.name,
        args: call.args,
        raw,
        offset,
        source: state.source,
        context: state.context,
        scratch: state.scratch,
        expand: nested => {
          if (state.depth >= state.maxDepth) return nested
          state.depth += 1
          try {
            return expandText(nested, offset, state)
          } finally {
            state.depth -= 1
          }
        },
      }
      value = state.registry.resolve(invocation)
    }

    // `raw` is an unresolved macro passing through verbatim, not a substituted
    // value, so it is never post-processed. Depth 0 only: see `postProcess`.
    out += value === undefined
      ? raw
      : (state.postProcess !== undefined && state.depth === 0 ? state.postProcess(value) : value)
    index = close
  }

  return out
}

/**
 * Expand `{{macros}}` in card text, lorebook content or a prompt.
 *
 * One inner-to-outer pass over named macros, then the regex macros, then the
 * two effects that reach outside a single macro's braces (`{{trim}}` eating its
 * surrounding newlines, and `\{` unescaping). See the module comment for why
 * results are not rescanned.
 * @param text - the text to expand.
 * @param context - what the macros may read; build it with `createMacroContext`.
 * @param options - registry and recursion limit.
 * @returns the expanded text. Text with nothing to expand is returned as the
 *   very same string, so a caller can use identity to detect a no-op.
 */
export function expandMacros(text: string, context: MacroContext, options: ExpandOptions = {}): string {
  if (text === '' || !EXPANDABLE.test(text)) return text

  const registry = options.registry ?? defaultRegistry()

  let prepared = text
  for (const [pattern, replacement] of LEGACY_MARKERS) {
    prepared = prepared.replace(pattern, replacement)
  }

  const state: ExpandState = {
    registry,
    ...options.postProcess === undefined ? {} : { postProcess: options.postProcess },
    context,
    // Hashed by `{{pick}}`: the text as the caller wrote it, so rewriting a
    // legacy marker does not silently reroll every pick in the document.
    source: text,
    scratch: new Map<string, unknown>(),
    maxDepth: options.maxDepth ?? 8,
    depth: 0,
  }

  const likeContext: MacroLikeContext = {
    ...(context.messageId !== undefined ? { messageId: context.messageId } : {}),
    ...(context.role !== undefined ? { role: context.role } : {}),
  }

  let result = expandText(prepared, 0, state)
  result = registry.applyMacroLikes(result, likeContext)
  result = result.replace(TRIM_PATTERN, '')
  result = result.replace(ESCAPED_BRACE, '$1')
  return result
}

/**
 * The macro expander a regex script wants.
 *
 * `@iris/regex` needs a `substitute` that can escape each expanded value
 * (its `SUBSTITUTE.ESCAPED` mode), and it stays dependency-free, so the two
 * meet by shape rather than by import: this returns exactly the function that
 * package's `MacroSubstitute` describes. Supplying it here rather than leaving
 * each caller to write it keeps one subtlety in one place — `postProcess`
 * applies to expanded values only, and only at the outermost level.
 * @param context - what the macros may read.
 * @param options - registry and recursion limit; any `postProcess` here is
 *   overridden per call by the regex engine's own.
 * @returns a substitute function the regex engine can take as-is.
 */
export function toRegexSubstitute(
  context: MacroContext,
  options: Omit<ExpandOptions, 'postProcess'> = {},
): (text: string, callOptions?: { postProcess?: (value: string) => string }) => string {
  return (text, callOptions) => expandMacros(text, context, {
    ...options,
    ...callOptions?.postProcess === undefined ? {} : { postProcess: callOptions.postProcess },
  })
}
