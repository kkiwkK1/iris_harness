/**
 * What the composer does with a line that starts with `/`.
 *
 * **Two command systems meet in this box and the rule between them is that
 * SillyTavern wins.** Cards in the wild call `/trigger`, `/send`, `/setvar`
 * and about 289 other names through `triggerSlash`, and a user who has typed
 * those in SillyTavern's own composer expects them to mean the same thing here
 * — compatibility is the floor. So the table below holds only names upstream
 * does **not** register, everything it does not match is forwarded verbatim to
 * the host's `script.slash` (the same parser a card's call goes through), and
 * an Iris command may never shadow an upstream one.
 *
 * Measured, not assumed: `SillyTavern 1.18.0` registers **289** command names
 * (every `SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name:
 * '…'` across the 34 files under `public/` that call it). Neither `compact` nor
 * `help` is among them — upstream's help is `/?` — which is why those two are
 * available to Iris. {@link ST_SLASH_NAMES} carries that list and
 * `tests/commands.test.ts` holds the disjointness, so a command added here
 * that upstream also has goes red instead of silently taking a name a card
 * might be calling.
 *
 * The registry is client-side because nothing on the wire enumerates commands:
 * `script.slash` executes a string and refuses an unknown name, but it cannot
 * be asked what it knows. Its shape follows `slots/message-actions.ts` — a
 * descriptor with a thunk label so a language switch re-words the menu without
 * anyone re-registering, and a `run` that gets a small context rather than the
 * store.
 *
 * @module iris-web/app/commands
 */

import { t } from './i18n/use-language.ts'

/** What a command's `run` is given. */
export interface CommandContext {
  /** Everything after the command name, trimmed; `''` when there was nothing. */
  args: string
  /** The open conversation. Commands that need one are refused before `run`. */
  chatId: string
  /** True while a reply is arriving. */
  generating: boolean
  /** Say something to the reader. Resolves when the command is done. */
  notify: (kind: 'info' | 'error', text: string) => void
}

/** One command the composer knows. */
export interface CommandDescriptor {
  /** The name without its slash, lower case. */
  name: string
  /** One line for the completion menu and for `/help`. */
  summary: () => string
  /** How to type it, when it takes anything. Absent means it takes nothing. */
  usage?: () => string
  /** Refuse rather than run while a reply is arriving. */
  idleOnly?: boolean
  run: (context: CommandContext) => void | Promise<void>
}

/**
 * Every command name SillyTavern 1.18.0 registers.
 *
 * A **measurement**, kept as data because the rule it enforces has no other
 * way to be checked offline: an Iris command must not shadow an upstream one,
 * and the only evidence for "upstream does not have this name" is upstream's
 * own list. Extracted from the checkout rather than typed by hand —
 * `notes/apps/iris-web/DEVIATIONS.md` §61 records the command that produced it.
 *
 * It is deliberately **not** gated on the corpus being present. A test that
 * parsed `E:/sillyTavern/SillyTavern` would run on a developer's machine and
 * skip on CI, which is the exact shape `scripts/check-corpus-skips.mjs` exists
 * to catch — and it would leave the one direction that matters (a *new* Iris
 * command colliding) unchecked precisely where new commands get merged.
 */
export const ST_SLASH_NAMES: ReadonlySet<string> = new Set([
  '?', 'abort', 'abs', 'add', 'addglobalvar', 'addswipe', 'addvar', 'api', 'api-url',
  'array-unwrap', 'array-wrap', 'ask', 'autobg', 'beep', 'bg', 'bgcol', 'branch-create',
  'bubble', 'buttons', 'caption', 'char-create', 'char-delete', 'char-duplicate', 'char-find',
  'char-get', 'char-update', 'chat-jump', 'chat-manager', 'chat-reload', 'chat-render',
  'checkpoint-create', 'checkpoint-exit', 'checkpoint-get', 'checkpoint-go', 'checkpoint-list',
  'checkpoint-parent', 'clipboard-get', 'clipboard-set', 'closechat', 'closure-deserialize',
  'closure-serialize', 'comment', 'context', 'continue', 'cos', 'count', 'createentry',
  'css-var', 'cut', 'db', 'db-add', 'db-delete', 'db-disable', 'db-enable', 'db-get',
  'db-ingest', 'db-list', 'db-purge', 'db-search', 'db-update', 'decglobalvar', 'decvar',
  'del', 'delay', 'delchat', 'delname', 'delswipe', 'div', 'echo', 'expression-classify',
  'expression-fallback', 'expression-folder-override', 'expression-last', 'expression-list',
  'expression-set', 'expression-upload', 'extension-disable', 'extension-enable',
  'extension-exists', 'extension-state', 'extension-toggle', 'findentry', 'flat',
  'flushglobalvar', 'flushinject', 'flushvar', 'forcesave', 'fuzzy', 'gen', 'genraw',
  'getcharbook', 'getchatbook', 'getchatname', 'getentryfield', 'getglobalbooks',
  'getglobalvar', 'getpersonabook', 'getpromptentry', 'getvar', 'go', 'hide', 'if',
  'imagine', 'imagine-comfy-workflow', 'imagine-source', 'imagine-style', 'impersonate',
  'import', 'incglobalvar', 'incvar', 'inject', 'input', 'instruct', 'instruct-off',
  'instruct-on', 'instruct-state', 'is-mobile', 'len', 'let', 'list-gallery', 'listinjects',
  'listvar', 'loader-hide', 'loader-show', 'loader-stop', 'loader-wrap', 'lockbg', 'log',
  'lower', 'match', 'max', 'member-add', 'member-count', 'member-disable', 'member-down',
  'member-enable', 'member-get', 'member-peek', 'member-remove', 'member-up', 'message-name',
  'message-role', 'messages', 'min', 'mod', 'model', 'movingui', 'mul', 'newchat', 'note',
  'note-depth', 'note-frequency', 'note-position', 'note-role', 'panels', 'pass',
  'persona-create', 'persona-delete', 'persona-duplicate', 'persona-get', 'persona-lock',
  'persona-set', 'persona-sync', 'persona-update', 'pick-icon', 'pm-render', 'popup', 'pow',
  'preset', 'profile', 'profile-create', 'profile-genstream', 'profile-get', 'profile-list',
  'profile-update', 'prompt-post-processing', 'proxy', 'qr', 'qr-arg', 'qr-chat-set',
  'qr-chat-set-off', 'qr-chat-set-on', 'qr-contextadd', 'qr-contextclear', 'qr-contextdel',
  'qr-create', 'qr-delete', 'qr-get', 'qr-list', 'qr-set', 'qr-set-create', 'qr-set-delete',
  'qr-set-list', 'qr-set-off', 'qr-set-on', 'qr-set-update', 'qr-update', 'qrset', 'rand',
  'random', 'reasoning-collapse', 'reasoning-expand', 'reasoning-format', 'reasoning-get',
  'reasoning-parse', 'reasoning-set', 'reasoning-template', 'reasoning-toggle', 'regenerate',
  'regex', 'regex-preset', 'regex-state', 'regex-toggle', 'reload-page', 'rename-char',
  'renamechat', 'replace', 'reroll-pick', 'resetpanels', 'round', 'run', 'secret-delete',
  'secret-id', 'secret-read', 'secret-rename', 'secret-write', 'send', 'sendas', 'setentryfield',
  'setglobalvar', 'setinput', 'setpromptentry', 'setvar', 'show-gallery', 'sin', 'single',
  'sort', 'speak', 'sqrt', 'start-reply-with', 'stop', 'stop-strings', 'sub', 'substr',
  'summarize', 'swipe', 'sys', 'sysgen', 'sysname', 'sysprompt', 'sysprompt-off',
  'sysprompt-on', 'sysprompt-state', 'tag-add', 'tag-exists', 'tag-import', 'tag-list',
  'tag-remove', 'tempchat', 'test', 'theme', 'times', 'tokenizer', 'tokens', 'tools-invoke',
  'tools-list', 'tools-register', 'tools-unregister', 'translate', 'trigger', 'trimend',
  'trimstart', 'trimtokens', 'unhide', 'unlockbg', 'upper', 'var', 'vector-chats-state',
  'vector-files-state', 'vector-max-entries', 'vector-query', 'vector-threshold',
  'vector-worldinfo-state', 'vn', 'while', 'wi-get-timed-effect', 'wi-set-timed-effect',
  'world', 'yt-script',
])

/** What the composer should do with what was typed. */
export type CommandResolution =
  /** Not a command at all; send it as a message. */
  | { kind: 'message' }
  /** An Iris command, ready to run. */
  | { kind: 'iris', command: CommandDescriptor, args: string }
  /**
   * Not in Iris's table. Hand the whole line to `script.slash` and let the host
   * decide — it recognises upstream's own names and refuses the rest **by
   * name**, which is a better answer than one written here from a list that
   * would drift.
   */
  | { kind: 'upstream', line: string }

/**
 * A bare `/` — the reader has opened the menu and typed nothing yet.
 *
 * Its own state rather than an unknown command, because forwarding `/` to the
 * host would produce a refusal for a line the reader has not finished writing.
 */
export const COMMAND_PREFIX = '/'

/**
 * Split a typed line into a command name and its arguments.
 *
 * Only the **name** is parsed here. Everything after the first run of
 * whitespace is handed on as one string, deliberately: upstream's argument
 * grammar has named arguments, quoting rules, pipes and an escape rule for
 * `|`, all of which live host-side in `@iris/compat-tavernhelper`'s parser. A
 * second implementation in the browser would agree in every test written
 * against it and disagree the first time a reader typed a backslash.
 * @param text - the raw draft.
 * @returns the name (lower-cased, no slash) and the rest, or undefined when
 * this is not a command line.
 */
export function parseCommandLine(text: string): { name: string, args: string } | undefined {
  if (!text.startsWith(COMMAND_PREFIX)) return undefined
  const body = text.slice(COMMAND_PREFIX.length)
  const match = /^([^\s|]*)([\s\S]*)$/.exec(body)
  if (match === null) return undefined
  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() }
}

/**
 * Decide what a typed line is.
 * @param text - the raw draft.
 * @param table - the commands Iris knows.
 * @returns the resolution the composer acts on.
 */
export function resolveCommand(
  text: string,
  table: readonly CommandDescriptor[],
): CommandResolution {
  const parsed = parseCommandLine(text)
  if (parsed === undefined) return { kind: 'message' }
  const command = table.find(row => row.name === parsed.name)
  if (command !== undefined) return { kind: 'iris', command, args: parsed.args }
  return { kind: 'upstream', line: text.trim() }
}

/**
 * The commands whose name starts with what has been typed.
 *
 * Prefix rather than fuzzy: the menu is opened by typing `/`, so the reader is
 * spelling a name they mean, and a fuzzy match would put `/help` under `/p`.
 * A line with arguments already typed matches nothing — the reader has chosen.
 * @param text - the raw draft.
 * @param table - the commands Iris knows.
 * @returns the rows to offer, in table order; empty when no menu belongs.
 */
export function commandCompletions(
  text: string,
  table: readonly CommandDescriptor[],
): CommandDescriptor[] {
  const parsed = parseCommandLine(text)
  if (parsed === undefined || parsed.args !== '') return []
  return table.filter(row => row.name.startsWith(parsed.name))
}

/**
 * The refusal for a name Iris does not have and the host did not accept.
 *
 * Worded here rather than reusing the host's sentence because the two failures
 * are different: the host says "this slash command is not implemented", which
 * is true and unhelpful to someone who was reaching for an Iris command. This
 * says both halves — the host refused it, and here is how to see what Iris has.
 * @param name - the name typed, without its slash.
 * @param reason - the host's own refusal text.
 * @returns the sentence to show.
 */
export function unknownCommandNotice(name: string, reason: string): string {
  return t('commandUnknown', { name, reason })
}

/**
 * The built-in table.
 *
 * A factory rather than a constant because `run` needs the store's actions,
 * and a module-level table closing over them would tie this file to a store
 * instance — the shell creates one per Cordis plugin and disposes it.
 * @param actions - what the commands are allowed to do.
 * @returns the table, in the order `/help` lists it.
 */
export function irisCommands(actions: {
  compact: () => Promise<void>
}): CommandDescriptor[] {
  const table: CommandDescriptor[] = [
    {
      name: 'compact',
      summary: () => t('commandCompactSummary'),
      idleOnly: true,
      run: async () => { await actions.compact() },
    },
    {
      name: 'help',
      summary: () => t('commandHelpSummary'),
      run: ({ notify }) => {
        notify('info', helpText(table))
      },
    },
  ]
  return table
}

/**
 * `/help`'s answer.
 *
 * Lists Iris's own commands and then says, in one line, that everything else
 * goes to the host — because a reader who has just been shown a two-item list
 * will otherwise conclude that `/trigger` does not work here.
 * @param table - the commands Iris knows.
 * @returns the text to show.
 */
export function helpText(table: readonly CommandDescriptor[]): string {
  const rows = table.map((row) => {
    const usage = row.usage?.()
    return `/${row.name}${usage === undefined ? '' : ` ${usage}`} — ${row.summary()}`
  })
  return [t('commandHelpHeading'), ...rows, t('commandHelpUpstream')].join('\n')
}
