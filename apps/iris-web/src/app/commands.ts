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
 * **The rule has already cost this table six names.** `model`, `tokens` and
 * `context` are all upstream's, so the per-conversation model override is
 * `/chat-model` and the capacity card is `/capacity`. `regenerate`, `continue`
 * and `impersonate` are upstream's too, and those are not re-spelled at all:
 * the actions stay where they are, on the newest reply's own button row
 * (`Message.tsx`), and the names stay reserved for upstream.
 *
 * Reserved is **not** the same as working. `script.slash` accepts three
 * commands today, so typing `/continue` reaches the host and is refused by
 * name — the honest answer, and the one §61 already records for every other
 * upstream name. What yielding buys is that the day the host implements it,
 * the name means what SillyTavern means and nothing here has to change.
 * `notes/apps/iris-web/DEVIATIONS.md` §61 and §61a record each decision.
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

/**
 * Which heading a command sits under in `/help`.
 *
 * Three, because a reader scanning the list is asking one of three questions —
 * *what can I do to this conversation*, *what goes into the next request*, and
 * *where are the settings* — and eight rows in one column made all three
 * answers look the same. The fourth bucket in `/help` is not a group: it is the
 * sentence saying that every other name goes to the host.
 */
export type CommandGroup = 'chat' | 'context' | 'app'

/** The order `/help` prints the groups in. */
export const COMMAND_GROUPS: readonly CommandGroup[] = ['chat', 'context', 'app']

/** One command the composer knows. */
export interface CommandDescriptor {
  /** The name without its slash, lower case. */
  name: string
  /** Which `/help` heading it sits under. */
  group: CommandGroup
  /** One line for the completion menu and for `/help`. */
  summary: () => string
  /** How to type it, when it takes anything. Absent means it takes nothing. */
  usage?: () => string
  /**
   * What to offer once the name has been typed and a space follows it.
   *
   * A **live read**, called at completion time rather than a list captured when
   * the table was built: the one command that has this is `/chat-model`, whose
   * choices are the endpoint's own answer and arrive from a probe the reader
   * may fire after the table exists. A captured array would offer the list from
   * before the connection was tested.
   * @param prefix - what has been typed after the name, trimmed.
   * @returns the values whose text starts with `prefix`, in the source's order.
   */
  argumentCompletions?: (prefix: string) => readonly string[]
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
  if (parsed === undefined || parsed.args !== '' || nameIsSettled(text)) return []
  return table.filter(row => row.name.startsWith(parsed.name))
}

/**
 * Whether the reader has finished typing the name.
 *
 * The separator, not `args`: `parseCommandLine` trims, so `/chat-model` and
 * `/chat-model ` both parse to an empty `args` while meaning different things —
 * the first is a name still being spelled and the second is a name chosen with
 * an argument about to be typed. The raw text is the only place that difference
 * survives, which is why this reads it rather than the parse.
 * @param text - the raw draft.
 * @returns true once whitespace or a pipe follows the name.
 */
function nameIsSettled(text: string): boolean {
  return /^\/[^\s|]*[\s|]/.test(text)
}

/**
 * The values to offer for a command's argument.
 *
 * Separate from {@link commandCompletions} rather than folded into it because
 * the two menus mean different things when picked: a name row replaces the line
 * with `/name `, and a value row completes the line the reader is already
 * writing. One function returning a mixed list would leave the caller
 * re-deciding which kind each row was.
 * @param text - the raw draft.
 * @param table - the commands Iris knows.
 * @returns the command being argued and the values that match, or undefined
 *   when this line is not one command's argument.
 */
export function commandArgumentCompletions(
  text: string,
  table: readonly CommandDescriptor[],
): { command: CommandDescriptor, values: readonly string[] } | undefined {
  if (!nameIsSettled(text)) return undefined
  const parsed = parseCommandLine(text)
  if (parsed === undefined) return undefined
  const command = table.find(row => row.name === parsed.name)
  if (command?.argumentCompletions === undefined) return undefined
  // An argument with a space in it is past completing — the reader is writing a
  // value this table did not offer, and a menu over its first word would be
  // offering to replace what they typed.
  if (/\s/.test(parsed.args)) return undefined
  const values = command.argumentCompletions(parsed.args)
  return values.length === 0 ? undefined : { command, values }
}

/**
 * How a command is written in a menu row and in `/help`: the name, and the
 * argument placeholder when it takes one.
 *
 * One helper for both surfaces because the placeholder is the part a reader
 * needs *before* choosing — `/rename` alone does not say that a title follows —
 * and two copies of the concatenation would drift the first time a command
 * gained an argument.
 * @param row - the command.
 * @returns `/name` or `/name <arg>`.
 */
export function commandLabel(row: CommandDescriptor): string {
  const usage = row.usage?.()
  return usage === undefined ? `/${row.name}` : `/${row.name} ${usage}`
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
  /** Start a conversation with the character the open one belongs to. */
  newChat: () => Promise<void>
  /**
   * Retitle one conversation.
   *
   * The id is a parameter rather than something the caller captured, because
   * `run` is handed the chat that was open when the line was dispatched and the
   * table outlives any one of them.
   */
  rename: (chatId: string, title: string) => Promise<void>
  /** Hand one conversation to the reader as a file. Id, for the same reason. */
  exportChat: (chatId: string) => Promise<void>
  /** Set or clear this conversation's model override. `null` clears it. */
  setModel: (model: string | null) => Promise<void>
  /** What the model control's menu is showing, read live. */
  modelChoices: () => ModelChoices
  /** Open the capacity card, or say why there is nothing to open. */
  showCapacity: () => boolean
  /** Open the settings drawer. */
  openSettings: () => void
}): CommandDescriptor[] {
  const table: CommandDescriptor[] = [
    {
      name: 'new',
      group: 'chat',
      summary: () => t('commandNewSummary'),
      /*
       * Gated. A reply arriving is written into the conversation this command
       * would navigate away from, and the store's `createChat` sets `stream:
       * undefined` — so running it under a request in flight discards the
       * reader's view of a reply that is still being paid for.
       */
      idleOnly: true,
      run: async () => { await actions.newChat() },
    },
    {
      name: 'rename',
      group: 'chat',
      summary: () => t('commandRenameSummary'),
      usage: () => t('commandRenameUsage'),
      run: async ({ args, chatId, notify }) => {
        if (args === '') {
          notify('error', t('commandNeedsArgument', { name: 'rename', usage: t('commandRenameUsage') }))
          return
        }
        await actions.rename(chatId, args)
        notify('info', t('commandRenameDone', { title: args }))
      },
    },
    {
      name: 'export',
      group: 'chat',
      summary: () => t('commandExportSummary'),
      /*
       * Gated, unlike the other two conversation commands. `chat.export` serves
       * what the host has **stored**, and a reply still streaming is not stored
       * yet — so an export taken mid-generation is a file silently missing its
       * last floor. The refusal names the command; a truncated file would not.
       */
      idleOnly: true,
      run: async ({ chatId }) => { await actions.exportChat(chatId) },
    },
    {
      name: 'chat-model',
      group: 'context',
      summary: () => t('commandModelSummary'),
      usage: () => t('commandModelUsage'),
      /*
       * **Not** gated, and that is the same decision the model control already
       * made: its menu is open and selectable while a reply arrives, because an
       * override applies from the *next* request and the one in flight has
       * already left. Gating the keyboard entry to a control the mouse can
       * still reach would make the two disagree about one action.
       */
      argumentCompletions: (prefix) => {
        const choices = actions.modelChoices()
        const rows = [
          ...choices.models,
          // Offered only when there is something to undo, exactly as the menu's
          // footer row is.
          ...choices.overridden ? [MODEL_DEFAULT_ARG] : [],
        ]
        const lower = prefix.toLowerCase()
        return rows.filter(row => row.toLowerCase().startsWith(lower))
      },
      run: async ({ args, notify }) => {
        const choices = actions.modelChoices()
        if (args === '') {
          notify('info', t('commandModelCurrent', {
            model: choices.current,
            models: choices.models.join(', '),
          }))
          return
        }
        if (args.toLowerCase() === MODEL_DEFAULT_ARG) {
          if (!choices.overridden) {
            notify('info', t('commandModelAlreadyDefault', { model: choices.current }))
            return
          }
          await actions.setModel(null)
          notify('info', t('commandModelCleared'))
          return
        }
        /*
         * An unlisted name is refused **only when the endpoint has actually
         * answered**, and `listed` is that fact rather than an inference from
         * the array's length: `models` always carries the model in force, so a
         * connection nobody has probed yields a one-row list that a length test
         * would read as a real catalogue and reject every valid id against.
         */
        if (choices.listed && !choices.models.includes(args)) {
          notify('error', t('commandModelUnknown', { model: args, models: choices.models.join(', ') }))
          return
        }
        await actions.setModel(args)
        notify('info', t('commandModelSet', { model: args }))
      },
    },
    {
      name: 'capacity',
      group: 'context',
      summary: () => t('commandCapacitySummary'),
      run: ({ notify }) => {
        // The card renders from the open chat's budget, so a conversation whose
        // budget the host has not reported has nothing to open — and an
        // apparently-ignored command is worse than a sentence saying so.
        if (!actions.showCapacity()) notify('error', t('commandCapacityNoBudget'))
      },
    },
    {
      name: 'compact',
      group: 'context',
      summary: () => t('commandCompactSummary'),
      idleOnly: true,
      run: async () => { await actions.compact() },
    },
    {
      name: 'config',
      group: 'app',
      summary: () => t('commandConfigSummary'),
      run: () => { actions.openSettings() },
    },
    {
      name: 'help',
      group: 'app',
      summary: () => t('commandHelpSummary'),
      run: ({ notify }) => {
        notify('info', helpText(table))
      },
    },
  ]
  return table
}

/**
 * What `/chat-model` reads about the model in force.
 *
 * The same four facts `model-menu.ts` computes for the control — read through a
 * thunk rather than passed as a value, because the endpoint's list arrives from
 * a probe the reader fires by opening that menu, which may happen long after
 * this table was built.
 */
export interface ModelChoices {
  /** The model this conversation is generating with. */
  current: string
  /** The rows the control offers: {@link current} first, then the source's own. */
  models: readonly string[]
  /** Whether {@link current} is this conversation's own choice. */
  overridden: boolean
  /**
   * Whether the **endpoint** has said anything, as opposed to `models` simply
   * carrying the model in force. `model-menu.ts`'s `empty` is this fact; the
   * array's length is not, and `/chat-model`'s refusal turns on the difference.
   */
  listed: boolean
}

/**
 * The word that clears the override.
 *
 * A keyword rather than the menu's sentinel id: `RESTORE_ID` in `Composer.tsx`
 * is a leading space, which nobody can type. The cost is that a model whose id
 * is literally `default` cannot be set from this command — the control's menu
 * still can, and that is recorded in `notes/apps/iris-web/DEVIATIONS.md` §61
 * rather than papered over.
 */
export const MODEL_DEFAULT_ARG = 'default'

/**
 * `/help`'s answer.
 *
 * Lists Iris's own commands under three headings and then says, in one line,
 * that everything else goes to the host — because a reader who has just been
 * shown a short list will otherwise conclude that `/trigger` does not work
 * here. The headings arrived with the second batch: eight rows in one column
 * answered three different questions and looked like one answer.
 *
 * A group with no commands prints **no heading**, so the shape follows the
 * table rather than this function's idea of it — the alternative is a heading
 * over nothing the first time a group is emptied.
 * @param table - the commands Iris knows.
 * @returns the text to show.
 */
export function helpText(table: readonly CommandDescriptor[]): string {
  const lines: string[] = [t('commandHelpHeading')]
  for (const group of COMMAND_GROUPS) {
    const rows = table.filter(row => row.group === group)
    if (rows.length === 0) continue
    lines.push(t(GROUP_HEADINGS[group]))
    for (const row of rows) lines.push(`${commandLabel(row)} — ${row.summary()}`)
  }
  lines.push(t('commandHelpUpstream'))
  return lines.join('\n')
}

/** Which string each `/help` heading reads. */
const GROUP_HEADINGS: Record<CommandGroup, 'commandGroupChat' | 'commandGroupContext' | 'commandGroupApp'> = {
  chat: 'commandGroupChat',
  context: 'commandGroupContext',
  app: 'commandGroupApp',
}
