/**
 * The slash commands card scripts actually reach for.
 *
 * Two of them. Measured over the local corpus — 47 card scripts and 18 world
 * books — there are **four `triggerSlash` call sites, all copies of one
 * snippet, none in a card script**:
 *
 * ```js
 * if (typeof triggerSlash === 'function') {
 *   triggerSlash(`/send ${text}|/trigger`)
 * }
 * ```
 *
 * So this implements `/send` and `/trigger` and refuses everything else by
 * name. That is not a stub standing in for a fuller version: upstream has
 * roughly 290 commands, the corpus calls two, and a compatibility layer built
 * to the documentation rather than to the ecosystem is mostly untested surface.
 * When a card does call something else, the refusal names it, and that name is
 * better evidence for adding it than any list written in advance.
 *
 * @module @iris/compat-tavernhelper/slash
 */

/** One parsed command from a pipeline. */
export type SlashCommand =
  /** Insert the text as a user message. */
  | { name: 'send', text: string }
  /** Generate a reply for whatever is on the log. */
  | { name: 'trigger' }

/**
 * Raised when a pipeline names a command Iris does not implement.
 *
 * Loud and by name, like every other refusal in the sandbox: a command that
 * silently did nothing would leave a card half-working with nothing to search
 * for.
 */
export class UnsupportedSlashCommandError extends Error {
  /** The command as written, without its slash. */
  readonly command: string

  /**
   * @param command - the unimplemented command's name.
   */
  constructor(command: string) {
    super(
      `the slash command "/${command}" is not implemented in Iris. `
      + 'Only /send and /trigger are — those are the two the local corpus calls, '
      + 'and nothing in it calls this one.',
    )
    this.name = 'UnsupportedSlashCommandError'
    this.command = command
  }
}

/**
 * Split a pipeline on its unescaped separators.
 *
 * Upstream's rule, transcribed from `SlashCommandParser`'s own escape counting:
 * a `|` preceded by an **odd** number of backslashes is escaped and literal;
 * an even number means the backslashes are literal pairs and the pipe separates.
 * Getting this wrong does not throw — it silently cuts a user's message in half
 * at the first pipe they type.
 * @param input - the whole command string.
 * @returns one segment per command, still escaped.
 */
export function splitPipeline(input: string): string[] {
  const segments: string[] = []
  let current = ''
  let backslashes = 0

  for (const character of input) {
    if (character === '|' && backslashes % 2 === 0) {
      segments.push(current)
      current = ''
      backslashes = 0
      continue
    }
    backslashes = character === '\\' ? backslashes + 1 : 0
    current += character
  }
  segments.push(current)
  return segments
}

/**
 * Resolve the escapes in one segment's argument.
 * @param text - the raw argument.
 * @returns the text as the card meant it.
 */
export function unescapeArgument(text: string): string {
  return text.replace(/\\(.)/gu, '$1')
}

/**
 * Parse a slash-command pipeline.
 * @param input - e.g. `/send hello|/trigger`.
 * @returns the commands, in the order they should run.
 * @throws {UnsupportedSlashCommandError} for any command that is not
 *   `/send` or `/trigger`.
 */
export function parseSlashCommands(input: string): SlashCommand[] {
  const commands: SlashCommand[] = []

  for (const segment of splitPipeline(input)) {
    const trimmed = segment.trim()
    // An empty segment is what a trailing or doubled pipe produces; upstream
    // treats `||` as a break rather than an error, so neither do we.
    if (trimmed.length === 0) continue
    if (!trimmed.startsWith('/')) {
      throw new UnsupportedSlashCommandError(trimmed.split(/\s/u)[0] ?? trimmed)
    }

    const space = trimmed.search(/\s/u)
    const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase()
    const argument = space === -1 ? '' : trimmed.slice(space + 1).trim()

    if (name === 'send') {
      commands.push({ name: 'send', text: unescapeArgument(argument) })
      continue
    }
    if (name === 'trigger') {
      commands.push({ name: 'trigger' })
      continue
    }
    throw new UnsupportedSlashCommandError(name)
  }

  return commands
}
