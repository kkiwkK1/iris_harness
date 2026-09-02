/**
 * Extract MVU variable-update commands from a model reply.
 *
 * The dialect looks like JavaScript but is not parsed as JavaScript — it is
 * scanned out of arbitrary prose, because models emit it inline and the
 * `<UpdateVariable>` wrapper the prompts ask for is advisory. Upstream scans
 * the WHOLE message, and three rules keep prose from being mistaken for a
 * command:
 *
 *  1. the verb must be spelled `_.<verb>(`;
 *  2. parenthesis matching is quote-aware, so `_.set('path', ['a);b'])` closes
 *     in the right place;
 *  3. a `;` must follow the closing parenthesis **immediately** — no space.
 *
 * Rule 3 is the load-bearing one. Without it, a narrator writing "she used
 * _.set(...) on the console" would rewrite the character's variables.
 *
 * @module @iris/mvu/commands
 */

/** The canonical verbs, after alias folding. */
export type CommandType = 'set' | 'insert' | 'delete' | 'add' | 'move'

/** One extracted command. */
export interface CommandInfo {
  type: CommandType
  /** The source text, from `_.` through the trailing `;` and any `//` comment. */
  full_match: string
  /**
   * Positional arguments, each still in its literal source form — `args[0]` is
   * the path *with its quotes*.
   *
   * Leaving them raw is deliberate: upstream fires its `COMMAND_PARSED` hook
   * before normalizing paths, and the community fix-up listeners that hook it
   * (repairing the `-` Gemini inserts between CJK characters, mapping
   * traditional forms back to simplified) rewrite this text directly. Call
   * {@link normalizeCommandPaths} after that hook, not before.
   */
  args: string[]
  /** Text of the trailing `// …` comment, or `''`. */
  reason: string
  /**
   * Already-parsed arguments, positionally aligned with {@link args}.
   *
   * Present only for the JSON Patch dialect, where the value arrived as real
   * JSON and re-reading it out of `args` would lose information:
   * `evaluateLiteral` turns object literals into JSON by swapping `'` for `"`,
   * so a value containing an apostrophe stops parsing and comes back as the
   * literal text instead of an object. Measured, not feared — `{"note":"don't"}`
   * round-trips to a string.
   *
   * A slot holding `undefined` means "no parsed form, read `args`", which is
   * what the path slot always is.
   */
  values?: unknown[]
}

/** Aliases the model may use, folded onto the canonical verb. */
const VERB_ALIASES: Readonly<Record<string, CommandType>> = {
  set: 'set',
  insert: 'insert',
  assign: 'insert',
  delete: 'delete',
  remove: 'delete',
  unset: 'delete',
  add: 'add',
}

/**
 * How many arguments each canonical verb needs.
 *
 * `add` is the one exact arity: it is always `(path, delta)`, so a third
 * argument means the model produced something else and the command is dropped
 * rather than guessed at.
 */
const ARITY: Readonly<Record<CommandType, { min: number, max?: number }>> = {
  set: { min: 2 },
  insert: { min: 2 },
  delete: { min: 1 },
  add: { min: 2, max: 2 },
  // Reachable only through the JSON Patch dialect, never through this scanner.
  move: { min: 2, max: 2 },
}

const VERB_PATTERN = /_\.(set|insert|assign|remove|unset|delete|add)\(/

/** Quote characters that suspend structural scanning. */
const QUOTES = new Set(["'", '"', '`'])

/**
 * Index of the parenthesis closing the one at `open`, or `-1`.
 *
 * Quote-aware: a parenthesis inside a string literal does not count, which is
 * what lets a command carry text containing brackets or semicolons.
 * @param text - the full message.
 * @param open - index of the opening parenthesis.
 * @returns index of the matching close, or `-1` when the message ends first.
 */
export function findMatchingCloseParen(text: string, open: number): number {
  let depth = 0
  let quote: string | undefined

  for (let index = open; index < text.length; index += 1) {
    const char = text[index] as string

    if (quote !== undefined) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (QUOTES.has(char)) {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Split an argument list on its top-level commas.
 * @param text - everything between the parentheses.
 * @returns trimmed argument sources; an empty list for an empty argument list.
 */
export function splitArguments(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string

    if (quote !== undefined) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (QUOTES.has(char)) quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      args.push(text.slice(start, index).trim())
      start = index + 1
    }
  }

  // A trailing empty argument is dropped rather than counted, so `_.set('a',)`
  // reads as one argument and fails the arity check instead of looking valid.
  const tail = text.slice(start).trim()
  if (tail.length > 0) args.push(tail)
  return args
}

/**
 * Strip surrounding quotes and stray backslashes from a path.
 * @param literal - the raw path argument.
 * @returns the bare path.
 */
export function unquotePath(literal: string): string {
  let path = literal.trim()
  const first = path[0]
  if (first !== undefined && QUOTES.has(first) && path.endsWith(first) && path.length >= 2) {
    path = path.slice(1, -1)
  }
  return path.replace(/\\(.)/g, '$1')
}

/**
 * Normalize the path argument of every command, in place.
 *
 * Run this *after* any `COMMAND_PARSED`-style hook has had its chance to repair
 * model output, matching upstream's ordering — listeners expect the raw text.
 * @param commands - commands to normalize.
 * @returns the same array, for chaining.
 */
export function normalizeCommandPaths(commands: CommandInfo[]): CommandInfo[] {
  for (const command of commands) {
    // Whitespace inside a subscript is a common model artifact and lodash does
    // not forgive it: `队伍[ 0 ]` must become `队伍[0]`.
    command.args[0] = unquotePath(command.args[0] as string).replace(/\[\s*(.*?)\s*\]/g, '[$1]')
  }
  return commands
}

/**
 * How many verb calls the reply attempted, understood or not.
 *
 * The counterpart of {@link DialectScan.jsonPatchOperations}, and it exists for
 * the same reason: {@link extractCommands} drops a malformed call silently,
 * because upstream does. Silence is the correct *behaviour* and a terrible
 * *signal* — without this number, a reply whose commands were all dropped
 * reads exactly like a reply that never asked for anything.
 * @param text - the whole message.
 * @returns how many `_.verb(` calls were started.
 */
export function countVerbAttempts(text: string): number {
  // A fresh global copy, so a shared lastIndex cannot make this depend on who
  // scanned last.
  const scanner = new RegExp(VERB_PATTERN.source, 'g')
  let count = 0
  while (scanner.exec(text) !== null) count += 1
  return count
}

/**
 * Scan a model reply for variable-update commands.
 * @param text - the whole message; no wrapper tag is required or assumed.
 * @returns the commands in source order. Malformed or wrong-arity matches are
 *   dropped silently, which is the upstream behaviour — a model that writes
 *   half a command must not take the turn down with it.
 */
export function extractCommands(text: string): CommandInfo[] {
  const commands: CommandInfo[] = []
  let cursor = 0

  while (cursor < text.length) {
    const match = VERB_PATTERN.exec(text.slice(cursor))
    if (match === null) break

    const start = cursor + match.index
    const openParen = start + match[0].length - 1
    // Resume just past the verb so a rejected match cannot hide a later one.
    const resume = openParen + 1

    const closeParen = findMatchingCloseParen(text, openParen)
    if (closeParen === -1) {
      // An unbalanced parenthesis is not the end of the message: a later,
      // well-formed command must still be found.
      cursor = resume
      continue
    }

    if (text[closeParen + 1] !== ';') {
      // Resume past the whole call, never inside it — otherwise a command
      // quoted inside a rejected command's arguments would be extracted as if
      // the narrator had issued it.
      cursor = closeParen + 1
      continue
    }

    const alias = match[1] as string
    const type = VERB_ALIASES[alias] as CommandType
    const args = splitArguments(text.slice(openParen + 1, closeParen))
    const arity = ARITY[type]

    if (args.length < arity.min || (arity.max !== undefined && args.length > arity.max)) {
      cursor = closeParen + 1
      continue
    }

    let end = closeParen + 2
    const trailing = /^\s*\/\/(.*)/.exec(text.slice(end))
    if (trailing !== null) end += trailing[0].length

    commands.push({
      type,
      full_match: text.slice(start, end),
      args,
      reason: trailing?.[1]?.trim() ?? '',
    })

    cursor = end
  }

  return commands
}
