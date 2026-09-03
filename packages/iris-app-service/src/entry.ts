/**
 * One live conversation.
 *
 * Holds the four things a chat is made of and keeps them consistent: the
 * append-only log, the variable store bound to it, the character it is played
 * with, and whether a turn is in flight.
 *
 * Editing and deleting a message are the awkward cases, and they are solved the
 * same way: project the log to SillyTavern's message list, change that, and
 * rebuild the log from it. An append-only log cannot rewrite a message in
 * place, and faking it with a shadowing candidate would silently turn every
 * edit into a swipe. The projection is already lossless in both directions —
 * `@iris/persistence` has round-trip tests — so going through it costs a
 * rebuild and buys exactly SillyTavern's semantics.
 *
 * @module @iris/app-service/entry
 */

import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { CharacterCard } from '@iris/character'
import { listCandidates, selectedCandidate } from '@iris/chat'
import type { TimedEffectState } from '@iris/lorebook'
import { expandHelperMacros } from '@iris/compat-tavernhelper'
import { applyCommands, formatYamlBlock, loadInitVars, scanDialects, type MvuData } from '@iris/mvu'
import { extractScripts } from '@iris/script'

import type { ResolvedWorldbook } from './worldbooks.ts'
import {
  exportMessages,
  importChat,
  withOriginalKeyOrder,
  type SillyTavernChatHeader,
  type SillyTavernMessage,
} from '@iris/persistence'
import type { ChatSummary, ChatView, PromptItemization, ScriptPromptPosition } from '@iris/protocol'
import type { MacroSubstitute, RegexScript } from '@iris/regex'
import { keyedMemoryBackend, memoryBackend, sessionMessageBackend, VariableStore, type ScopeBackend, type Variables } from '@iris/variables'

import { scriptIdOf } from './script-variables.ts'

import { busy } from './errors.ts'
import { applyPrune, applyPruned, DEFAULT_PRUNE, looksNeverCleaned, PRUNED_KEYS, type FloorRead, planPrune, prunedKeysOf, prunedNote, type PruneOptions } from './prune.ts'
import { scriptsOf, substituteFor } from './regex.ts'
import { textOf, toChatView, type Names, type PendingTurn } from './views.ts'

/** Iris's own header block inside a SillyTavern chat file. */
export interface IrisChatMeta {
  chatId: string
  characterId?: string
  title: string
  /** Unix epoch milliseconds of the last activity. */
  updatedAt: number
  /** The conversation this one was branched from, when it was. */
  parentChatId?: string
}

/**
 * One injection a card script registered, in upstream's full shape.
 *
 * Built to the upstream signature rather than to what any one card happens to
 * call: `injectPrompts` is a thin wrapper over `setExtensionPrompt`, and its
 * fields are `id / position / depth / role / content / should_scan / filter`.
 * All but `filter` cross this boundary — a filter is a **function**, evaluated
 * afresh on every assembly, so it composes in the façade the way
 * `updateVariablesWith` does.
 */
export interface ScriptInjection {
  value: string
  position: ScriptPromptPosition
  depth: number
  /** Upstream's `{system, user, assistant}` → `0 | 1 | 2`. */
  role?: 'system' | 'user' | 'assistant'
  /**
   * Whether this text is itself scanned for world-book keywords.
   *
   * Upstream's `should_scan`, default false. **Stored and not yet honoured** by
   * the scan pass — recorded here so a request that asks for it is kept rather
   * than quietly flattened to false, and so the gap is findable.
   */
  scan?: boolean
}

/** An empty MVU tree, before any book has declared anything. */
const EMPTY_MVU: MvuData = { initialized_lorebooks: {}, stat_data: {} }

/**
 * Read Iris's block out of a chat header.
 *
 * Stored inside the header rather than in a sidecar index, so a chat file is
 * self-describing: copy it into another install and it still knows its title.
 * @param header - the parsed header line.
 * @returns the block, with what the header itself can supply as fallback.
 */
export function readMeta(header: SillyTavernChatHeader): IrisChatMeta {
  const raw = header['iris']
  const meta = typeof raw === 'object' && raw !== null ? raw as Partial<IrisChatMeta> : {}
  return {
    chatId: typeof meta.chatId === 'string' ? meta.chatId : '',
    ...typeof meta.characterId === 'string' ? { characterId: meta.characterId } : {},
    title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : header.character_name,
    updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
    ...typeof meta.parentChatId === 'string' ? { parentChatId: meta.parentChatId } : {},
  }
}

/**
 * Whether a value is an MVU state tree rather than some other variable table.
 * @param value - the candidate.
 * @returns true when it carries a `stat_data` tree.
 */
function isMvuData(value: unknown): value is MvuData {
  return typeof value === 'object' && value !== null && 'stat_data' in value
}

/**
 * Chat-scope variables, stored where SillyTavern keeps them.
 *
 * `chat_metadata.variables` is the upstream location, and the header is written
 * back on every save, so these survive a restart for free.
 * @param header - the chat header to read and write.
 * @returns a backend for the `chat` scope.
 */
export function metadataBackend(header: SillyTavernChatHeader): ScopeBackend {
  return {
    read(): Variables {
      const stored = header.chat_metadata['variables']
      return typeof stored === 'object' && stored !== null ? stored as Variables : {}
    },
    write(_option, next): void {
      header.chat_metadata['variables'] = next
    },
  }
}

/**
 * The turn each projected chat-file line belongs to.
 *
 * Mirrors the walk in `exportMessages`, which is what makes the index this
 * returns line up with the index that function produces.
 * @param session - the chat log.
 * @returns one turn number per line, in line order.
 */
/**
 * Each chat line, in file order, with the turn it belongs to and who sent it.
 *
 * The single walk behind {@link lineTurns}. Roles are needed because the prune
 * rules count message indices — user rows included — and a second walk kept in
 * step by hand is a drift waiting to happen.
 * @param session - the chat log.
 * @returns one entry per line.
 */
export function chatLines(session: Session): { turn: number, isUser: boolean, seq: number }[] {
  const lines: { turn: number, isUser: boolean, seq: number }[] = []
  const seen = new Set<number>()
  let turn = 0

  for (const event of session.events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }
    if (event.type === 'user/message') {
      lines.push({ turn, isUser: true, seq: event.seq })
      continue
    }
    if (event.type !== 'assistant/message') continue
    if (seen.has(event.data.turn)) continue
    seen.add(event.data.turn)
    lines.push({ turn: event.data.turn, isUser: false, seq: event.seq })
  }
  return lines
}

/**
 * The turn each chat line belongs to, in file order.
 * @param session - the chat log.
 * @returns one turn number per line.
 */
export function lineTurns(session: Session): number[] {
  return chatLines(session).map(line => line.turn)
}

/**
 * Whether each projected line is a system message, in line order.
 *
 * Built on {@link chatLines} rather than repeating its walk. The two used to be
 * separate loops that had to agree on what a line *is*, which is a shape that
 * stops agreeing the moment one of them is edited.
 *
 * `is_system` is not a field this host models — an imported system row becomes
 * an ordinary candidate and the flag rides through `iris/st-meta` — so this
 * reads it back from there rather than from the log's own shape.
 * @param session - the chat log.
 * @returns one flag per line, in the same order as {@link lineTurns}.
 */
export function lineSystemFlags(session: Session): boolean[] {
  const bySeq = new Map<number, boolean>()
  for (const event of session.events) {
    if (event.type !== 'iris/st-meta') continue
    bySeq.set(event.data.seq, event.data.fields['is_system'] === true)
  }
  return chatLines(session).map(line => bySeq.get(line.seq) ?? false)
}

/** One live conversation and everything bound to it. */
export class ChatEntry {
  readonly chatId: string
  header: SillyTavernChatHeader
  session: Session
  variables: VariableStore
  card: CharacterCard | undefined
  /**
   * Which book this chat's world info comes from, chosen once when the chat
   * opened.
   *
   * Resolved rather than derived on demand, because the choice is between two
   * sources and every consumer must make the same one: `worldInfoOf`,
   * `scanEntriesOf` and `initVars` reading the card directly is how they would
   * drift apart. Absent only on an entry built without a resolver, which is a
   * test's shape and not a host's.
   */
  worldbook: ResolvedWorldbook | undefined
  /** Sticky and cooldown windows, carried between turns. */
  timedEffects: TimedEffectState | undefined
  /** The turn currently streaming, if any. */
  pending: PendingTurn | undefined
  /**
   * Text a card script has injected, keyed so it can replace its own.
   *
   * Upstream's `setExtensionPrompt` is idempotent per key, and a card calling it
   * once a turn means to overwrite — accumulating instead would grow the prompt
   * without bound over a long chat, and the symptom (the model losing the early
   * conversation) looks nothing like its cause.
   *
   * Not persisted: an injection belongs to a running script, and a script that
   * is not running should not still be shaping the prompt.
   */
  readonly extensionPrompts = new Map<string, ScriptInjection>()
  /**
   * What each turn's prompt was made of, recorded as it was assembled.
   *
   * In memory only, and deliberately so for now: persisting it would mean
   * inventing a storage format for debugging output, and the preview mode
   * covers the case that matters without any record at all. A turn whose record
   * is gone is answered with a preview rather than with nothing.
   */
  readonly itemizations = new Map<number, PromptItemization>()

  #initVars: MvuData | undefined
  #initialVariables: Record<string, unknown> | undefined
  #scripts: RegexScript[] | undefined
  /** Storage for the `script` scope; outlives `rebuild`, so it is held here. */
  readonly #scriptScope: ScopeBackend
  /** Storage for the `global` scope; outlives `rebuild`, so it is held here. */
  readonly #globalScope: ScopeBackend
  /**
   * Variable scopes a macro asked for that this host has no store for.
   *
   * Collected rather than thrown: a missing scope must not take the turn down,
   * and the reader who needs to know is whoever reads the log after the prompt
   * went out. Drained by the caller once per request.
   */
  readonly unsupportedScopes = new Set<string>()
  #substitute: MacroSubstitute | undefined
  #abort: AbortController | undefined
  /** Row identities, one per chat-file line, plus one spare for a streaming row. */
  #keys: string[] = []
  #nextKey = 0

  /**
   * @param input - identity, the restored log, its header, and the character.
   */
  constructor(input: {
    chatId: string
    header: SillyTavernChatHeader
    session: Session
    card: CharacterCard | undefined
    /**
     * Storage for the `script` scope.
     *
     * Injected rather than made here because it outlives the chat: script
     * variables belong to the card, and two conversations with the same
     * character share them. Absent means in-memory, which is what a host with
     * nowhere to keep them should do.
     */
    scriptScope?: ScopeBackend
    /**
     * Storage for the `global` scope.
     *
     * Injected for the same reason as `scriptScope`: it outlives the chat.
     * Upstream's global scope is installation-wide, so an in-memory one is empty
     * on every start and a card storing an installation preference never finds
     * it again. Absent still means in-memory, which is what a host with nowhere
     * to keep it should do.
     */
    globalScope?: ScopeBackend
    /** The chosen world book; see the field of the same name. */
    worldbook?: ResolvedWorldbook
  }) {
    this.chatId = input.chatId
    this.header = input.header
    this.session = input.session
    this.card = input.card
    this.worldbook = input.worldbook
    // Assigned before the first `#makeStore`, and held, because `rebuild` makes
    // a new store: a backend created inside `#makeStore` would drop every script
    // table the moment a message was edited.
    // The fallback refuses a missing `script_id` exactly as the persistent
    // backend does, so a test running in memory cannot pass on a selector a real
    // deployment rejects.
    this.#scriptScope = input.scriptScope ?? keyedMemoryBackend(scriptIdOf)
    this.#globalScope = input.globalScope ?? memoryBackend()
    this.variables = this.#makeStore(input.session)
  }

  /** Speaker names, as the file records them. */
  get names(): Names {
    return { user: this.header.user_name, character: this.header.character_name }
  }

  /** Iris's header block. */
  get meta(): IrisChatMeta {
    return readMeta(this.header)
  }

  /**
   * The regex scripts this chat runs, in upstream's order.
   *
   * Resolved once per chat rather than per message: a turn runs them over every
   * message in the prompt, and re-sorting the card's list each time would be
   * work proportional to the square of the conversation.
   */
  get scripts(): readonly RegexScript[] {
    this.#scripts ??= scriptsOf(this.card)
    return this.#scripts
  }

  /**
   * The starting variables the card ships beside its scripts.
   *
   * Upstream's `initial` scope: what a reset resets to. Deliberately not the
   * `character` scope, which is a live store with a different lifetime — a
   * template writing into `initial` would be editing the card's own baseline.
   */
  get initialVariables(): Record<string, unknown> {
    if (this.#initialVariables === undefined) {
      this.#initialVariables = this.card === undefined ? {} : extractScripts(this.card).variables
    }
    return this.#initialVariables
  }

  /**
   * The macro expander this chat's scripts resolve their patterns with.
   *
   * Built once per chat because it closes over the speaker names, which is all
   * a script pattern can reference.
   */
  get substitute(): MacroSubstitute {
    // Composed, not replaced: SillyTavern's own macros first, then Tavern
    // Helper's. TH registers its as "macro-like" on top of the tavern's, and a
    // host that expands only the first family sends `{{format_message_variable
    // ::stat_data}}` to the model verbatim — which is how a card that asks the
    // model to patch a state it can no longer see gets a reply with no patch.
    //
    // The trees are read at call time rather than captured, because they change
    // every turn and this getter is resolved once.
    if (this.#substitute === undefined) {
      // No variable store is supplied, and that is measured rather than
      // overlooked. `createMacroContext` then makes one in-memory store, and
      // because this getter caches its expander, **that one store is shared by
      // every expansion in this chat** — which is what a preset needs: its
      // `{{setvar}}` prompts run before the `{{getvar}}` prompt that reads them
      // back, inside one assembly.
      //
      // Binding it to the chat's persistent scopes was tried and reverted. It
      // was not needed (the preset works without it, verified end to end) and it
      // turned `prompt.itemize` — a read — into a write: previewing a prompt
      // stored three menu選択 into `chat_metadata.variables`. The fidelity gap it
      // would have closed is real but unmeasured: `{{setvar}}` here does not
      // survive a restart and is invisible to a card reading
      // `getVariables({type: 'chat'})`. Nothing in the corpus depends on either,
      // so the side effect was the only certain consequence.
      const tavern = substituteFor(this.names)
      this.#substitute = (text, options) => {
        const expanded = tavern(text, options)
        // `postProcess` marks the regex-pattern path, where every expanded value
        // is escaped before being read as syntax. A variable macro there would
        // put an unescaped YAML block into a pattern, so it is left alone: the
        // corpus writes these macros into prompts, never into `findRegex`, and
        // expanding one here would be a guess with no evidence behind it.
        if (options?.postProcess !== undefined) return expanded
        return expandHelperMacros(expanded, {
          variables: {
            // Upstream searches the chat for the last message whose selected
            // swipe carries variables — and during generation the pending reply
            // is not in that array yet, because nothing has written it. Asking
            // the message scope directly would resolve to that pending turn,
            // which has no candidate, and the read throws: the macro then renders
            // `null` on exactly the request that needed the state most.
            //
            // `baselineFor` is the same question already answered elsewhere —
            // what state does this turn start from — and it falls back to the
            // card's `[InitVar]` tree, so a chat's very first generation shows
            // the declared starting state instead of nothing.
            message: this.baselineFor(this.pending?.turn ?? this.lastTurn + 1),
            chat: this.#scopeOrEmpty({ type: 'chat' }),
            global: this.#scopeOrEmpty({ type: 'global' }),
            // `character` and `preset` have no store on this host. Absent reads
            // as `null`, which is the honest answer — not an empty tree, which
            // would claim the scope exists and holds nothing.
          },
          onUnsupportedScope: (scope) => { this.unsupportedScopes.add(scope) },
        })
      }
    }
    return this.#substitute
  }

  /**
   * One scope's tree, empty when its backend could not answer.
   *
   * **Never `undefined`.** In the macro sources, an absent key means one thing
   * only — this host implements no such scope — and the report built from it
   * says exactly that. A backend that exists and threw is a different fact, and
   * returning `undefined` for it would make the report assert something untrue
   * about a scope Iris does implement.
   *
   * That leaves a throwing backend rendering as empty, which is the same lie in
   * miniature. It is accepted rather than plumbed: `chat` and `global` are
   * served by a metadata reader and an in-memory map, neither of which throws in
   * practice, and the corpus's 42 variable-macro uses all name `message`. If a
   * backend here ever does start failing, this is the line that hid it.
   * @param option - the scope selector.
   * @returns the tree, or an empty one.
   */
  #scopeOrEmpty(option: Parameters<VariableStore['getVariables']>[0]): unknown {
    try {
      return this.variables.getVariables(option)
    } catch {
      return {}
    }
  }

  /** Whether a turn is in flight. */
  get generating(): boolean {
    return this.#abort !== undefined
  }

  /** The highest turn the log has opened, or `-1` when it has none. */
  get lastTurn(): number {
    let turn = -1
    for (const event of this.session.events) {
      if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
    }
    return turn
  }

  /**
   * Update the header block and stamp the chat as touched.
   * @param patch - fields to change.
   */
  touch(patch: Partial<IrisChatMeta> = {}): void {
    this.header['iris'] = { ...this.meta, ...patch, updatedAt: Date.now() }
  }

  /**
   * Stable identity for each row of the view.
   *
   * Minted here rather than derived in the projection because nothing in the
   * log survives a rebuild: `importChat` reassigns every `seq`, and removing a
   * user line renumbers the turns after it. A UI keyed on either would reattach
   * an open editor to the neighbouring message the moment something is deleted,
   * which is the failure `MessageView.key` exists to prevent.
   *
   * One spare is always minted past the end. A streaming row occupies that slot
   * and the settled row then lands in the same one, so a reply keeps a single
   * identity from its first token to its last.
   * @returns one key per row, in row order.
   */
  get keys(): readonly string[] {
    const wanted = lineTurns(this.session).length + 1
    while (this.#keys.length < wanted) {
      this.#keys.push(`m${String(this.#nextKey)}`)
      this.#nextKey += 1
    }
    return this.#keys
  }

  /**
   * Identity of the row a generation streams into.
   *
   * Two cases, and they land in different slots. A new turn has no row yet, so
   * it takes the spare `keys` mints past the end. A reroll writes into the row
   * the turn already has, which is the last chat-file line — announcing the
   * spare there would name a row no view contains, and the bubble would remount
   * the moment the reply settled.
   *
   * Only meaningful once the turn's user line is in the log: before that the
   * spare belongs to that line instead, so a caller reads this after the driver
   * has appended, not before.
   * @param turn - the turn about to be generated.
   * @returns the identity to announce with `stream.start`.
   */
  streamingKeyFor(turn: number): string {
    const keys = this.keys
    const rerolling = listCandidates(this.session, turn).length > 0
    const index = rerolling ? keys.length - 2 : keys.length - 1
    return keys[index] ?? keys[keys.length - 1] as string
  }

  /**
   * Set or clear one keyed injection.
   * @param key - the script's own key for this injection.
   * @param injection - the text and placement, or `undefined` to remove it.
   */
  setExtensionPrompt(
    key: string,
    injection: ScriptInjection | undefined,
  ): void {
    // An empty string is how upstream clears one, so it is treated as removal
    // rather than stored as a contribution that renders to nothing.
    if (injection === undefined || injection.value.trim().length === 0) this.extensionPrompts.delete(key)
    else this.extensionPrompts.set(key, injection)
  }

  /**
   * Claim the chat for one generation.
   * @param turn - the turn about to be generated.
   * @returns the signal to hand the driver.
   * @throws {AppError} `busy` when a turn is already in flight.
   */
  begin(turn: number): AbortSignal {
    if (this.#abort !== undefined) throw busy('that chat is already generating')
    this.#abort = new AbortController()
    this.pending = { turn, text: '', reasoning: '' }
    return this.#abort.signal
  }

  /** Release the chat after a generation ends, however it ended. */
  finish(): void {
    this.#abort = undefined
    this.pending = undefined
  }

  /**
   * Interrupt the turn in flight.
   * @returns whether there was one.
   */
  abort(): boolean {
    if (this.#abort === undefined) return false
    this.#abort.abort()
    return true
  }

  /**
   * The state a turn's commands should be folded into.
   *
   * The nearest earlier turn's state, NOT the state as it stands: regenerating
   * must start from the same baseline the discarded reply did, or a rerolled
   * turn compounds the consequences of a reply the user rejected.
   * @param turn - the turn being generated.
   * @returns the baseline tree.
   */
  baselineFor(turn: number): MvuData {
    for (let earlier = turn - 1; earlier >= 0; earlier -= 1) {
      let stored: Variables
      try {
        stored = this.variables.getVariables({ type: 'message', message_id: earlier })
      } catch {
        // That turn produced no candidate to attach variables to.
        continue
      }
      if (isMvuData(stored)) return stored
    }
    return this.initVars()
  }

  /**
   * The variable tree the character's world book declares.
   *
   * Computed once per chat: `loadInitVars` records which books it has folded
   * in, and re-running it must not undo later edits.
   * @returns the declared tree, empty when the card ships no `[InitVar]` entry.
   */
  initVars(): MvuData {
    if (this.#initVars !== undefined) return this.#initVars
    // The chosen book, not the embedded one. A card that declares `[InitVar]`
    // in its named book and ships no embedded copy would otherwise start with
    // no declared tree at all, and MVU's `set` refuses a path that does not
    // exist — so the symptom would be every variable update silently failing.
    const chosen = this.worldbook

    // Globally selected books seed variables too, and **before** the
    // character's. That order is not a guess: MVU's `getEnabledLorebookList`
    // builds `[...selected_global_lorebooks, primary, ...additional]`
    // (`MagVarUpdate/src/function/initvar/variable_init.ts:230`), so a global
    // book's `[InitVar]` is folded first and the character's declaration wins
    // where they overlap.
    //
    // **This is the opposite of the order `scanEntriesOf` builds, and neither is
    // a typo.** That one is character-first, by the installation's
    // `world_info_character_strategy`; this one is global-first, by MVU's
    // hardcoded list. The same note sits beside that construction, because a
    // reader who finds only one of the two will reasonably conclude the other
    // is a mistake. Matching them up would be plausible tidiness that changes
    // behaviour.
    const books: { name: string, entries: unknown[] }[] = []
    const seen = new Set<string>()
    for (const book of chosen?.global ?? []) {
      if (seen.has(book.world)) continue
      seen.add(book.world)
      books.push({ name: book.world, entries: book.entries })
    }

    // The chosen book, not the embedded one. A card that declares `[InitVar]`
    // in its named book and ships no embedded copy would otherwise start with
    // no declared tree at all, and MVU's `set` refuses a path that does not
    // exist — so the symptom would be every variable update silently failing.
    const ownName = chosen?.world ?? this.card?.data.name ?? 'character book'
    const own = chosen !== undefined
      ? chosen.entries
      : (() => {
        const book = this.card?.data.character_book
        return book !== undefined && Array.isArray(book.entries) ? book.entries : []
      })()
    if (own.length > 0 && !seen.has(ownName)) books.push({ name: ownName, entries: own })

    if (books.length === 0) {
      this.#initVars = EMPTY_MVU
      return this.#initVars
    }
    this.#initVars = loadInitVars(books as Parameters<typeof loadInitVars>[0], EMPTY_MVU).data
    return this.#initVars
  }

  /**
   * Fold a generated reply's MVU commands into the state and attach the result
   * to the candidate that produced it.
   *
   * Attaching per candidate is the whole point: swiping back to an earlier
   * reply restores that reply's consequences because the text and the state are
   * the same object in the log.
   * @param turn - the turn the candidate belongs to.
   * @param text - the candidate's visible text.
   * @returns the state now attached to the candidate.
   */
  recordVariables(turn: number, text: string, onReport?: (message: string) => void): MvuData {
    // Both dialects, because a card asks for one of them and nothing here knows
    // which. Reading only the legacy one is exactly how the `<JSONPatch>` cards
    // silently stopped folding.
    const scan = scanDialects(text)
    for (const rejection of scan.rejected) onReport?.(`MVU: ${rejection}`)
    // A block the model wrote and nothing understood is the signal that was
    // missing when this broke; it costs one line and it is the only thing that
    // distinguishes "the model did not answer" from "we could not read it".
    //
    // Gated on the operation count, not on the block count. `<JSONPatch>[]` is a
    // model saying "nothing changed this turn" — a correct answer, and the most
    // ordinary one on a quiet turn. Reporting it would point whoever reads the
    // log at a parser that is working perfectly.
    if (scan.jsonPatchOperations > 0 && scan.commands.length === 0) {
      onReport?.(`MVU: a reply carried ${String(scan.jsonPatchOperations)} <JSONPatch> operation(s) that produced no commands`)
    }
    // The same signal for the other dialect. Not gated on the command count
    // being zero: a reply where four calls of five were understood has lost an
    // update, and upstream loses it in silence. Every drop is worth a line.
    if (scan.legacyAttempts > scan.legacyCommands) {
      const dropped = scan.legacyAttempts - scan.legacyCommands
      onReport?.(`MVU: a reply started ${String(scan.legacyAttempts)} _.verb() call(s) and ${String(dropped)} could not be read`)
    }
    const result = applyCommands(scan.commands, this.baselineFor(turn))
    for (const failure of result.failures) onReport?.(`MVU: ${failure.reason}`)
    this.variables.replaceVariables(
      result.data as unknown as Variables,
      { type: 'message', message_id: turn },
    )
    return result.data
  }

  /** The newest turn's variables, for a status-bar surface. */
  currentVariables(): Record<string, unknown> | undefined {
    try {
      const variables = this.variables.getVariables({ type: 'message' })
      return Object.keys(variables).length > 0 ? variables : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Rebuild the log from an edited SillyTavern message list.
   *
   * Per-candidate variables are carried across by position, which is why the
   * caller supplies the index mapping rather than a free-form mutator: without
   * knowing where each surviving line came from, a rebuild would silently drop
   * the state attached to every reply.
   * @param lines - the new message list.
   * @param sourceOf - old line index for each new one, or `undefined` for a
   *   line with no predecessor.
   */
  rebuild(lines: SillyTavernMessage[], sourceOf: (index: number) => number | undefined): void {
    const before = this.#snapshotVariables()

    // Row identities travel the same mapping as the variables, and for the same
    // reason: the rebuilt log cannot say which of its lines used to be which.
    const previousKeys = this.#keys
    this.#keys = lines.map((_line, index) => {
      const source = sourceOf(index)
      const carried = source === undefined ? undefined : previousKeys[source]
      if (carried !== undefined) return carried
      const minted = `m${String(this.#nextKey)}`
      this.#nextKey += 1
      return minted
    })

    const rebuilt = importChat({ header: this.header, messages: lines }, this.chatId)
    const turns = lineTurns(rebuilt)

    this.session = rebuilt
    this.variables = this.#makeStore(rebuilt)

    for (let index = 0; index < lines.length; index += 1) {
      const source = sourceOf(index)
      if (source === undefined) continue
      const saved = before.get(source)
      if (saved === undefined) continue

      const turn = turns[index]
      if (turn === undefined) continue
      const candidates = listCandidates(rebuilt, turn)
      for (let swipe = 0; swipe < saved.length; swipe += 1) {
        const variables = saved[swipe]
        const candidate = candidates[swipe]
        if (variables === undefined || candidate === undefined) continue
        rebuilt.append('iris/variables', { candidateSeq: candidate.seq, variables })
      }
    }
  }

  /**
   * The chat file as it should be written.
   *
   * Per-candidate variables are attached where SillyTavern keeps them —
   * `chat[i].variables[swipe_id]`, an array parallel to `swipes` — so MVU state
   * survives a restart and a chat exported from Iris carries its state into a
   * SillyTavern install.
   * @returns header and message lines.
   */
  toFile(onReport?: (message: string) => void): { header: SillyTavernChatHeader, messages: SillyTavernMessage[] } {
    const messages = exportMessages(this.session, this.header)
    for (const [index, saved] of this.#snapshotVariables()) {
      const line = messages[index]
      // Assistant lines only. A turn's user line and its reply share a turn
      // number, so writing the candidate's table to both would put the reply's
      // state on the user's message — and would clobber whatever the imported
      // file had there, which `iris/st-meta` has already restored verbatim.
      if (line === undefined || line.is_user) continue
      // One table per swipe, which is the width upstream rebuilds to:
      // `_.range(0, swipes?.length ?? 1)`. Missing entries become `{}`; extra
      // ones are dropped, because a table with no swipe to belong to cannot be
      // addressed and would be read back onto the wrong reply.
      //
      // **The floor of one is ours.** Upstream's `?? 1` catches a missing
      // `swipes`, but an empty array is not nullish, so a line carrying
      // `swipes: []` would rebuild to zero tables and silently discard the
      // state of a reply that exists. Upstream cannot receive that shape; we
      // can, so it is refused here rather than written out.
      const swipes = line['swipes']
      const width = Math.max(1, Array.isArray(swipes) ? swipes.length : 1)
      const tables = saved.map(variables => variables ?? {})
      if (tables.length > width) {
        onReport?.(
          `variables: line ${String(index)} holds ${String(tables.length)} table(s) but the`
          + ` line has ${String(width)} swipe(s); ${String(tables.length - width)} dropped on export`,
        )
      }
      line['variables'] = Array.from({ length: width }, (_unused, swipe) => tables[swipe] ?? {})
    }
    // Put every line's keys back where the file had them.
    //
    // **This step used to be unnecessary, and that was the problem.** The
    // assignment above lands in place only while a `variables` key already
    // exists, which it did because `iris/st-meta` carried a full copy of the
    // table — 93.6% of that event's bytes, kept for nothing but this key's
    // position. With the copy gone the assignment appends, and the export stops
    // being byte-identical to the file it came from. The order is now recorded
    // deliberately instead of being a side effect of a duplicate, so a future
    // change to the assignments above cannot quietly break the round trip.
    return {
      header: this.header,
      messages: messages.map(line => withOriginalKeyOrder(line)),
    }
  }

  /**
   * Put a loaded file's per-candidate variables back into the log.
   *
   * `importChat` restores the conversation but knows nothing about variables —
   * it carries them through as opaque unmodelled fields. Reattaching them here
   * is what makes MVU state survive a reload rather than silently resetting to
   * the world book's declaration.
   * **Two tables can be dropped here, and both used to go without saying so.**
   * A file may carry more tables than the line has candidates, or a table that
   * is not an object; each was a bare `continue`. Dropping is still the right
   * behaviour — there is no candidate to attach the table to, and inventing one
   * would fabricate a swipe the conversation never had — but a drop that says
   * nothing is indistinguishable from a file that never carried the table, and
   * the symptom reaches the user as variables that quietly reset.
   *
   * Measured on the corpus: 1 line in 1235 carries a surplus table
   * (`floor 6: variables[2] vs swipes[1]`). Small, and audible now.
   * @param lines - the message lines the log was rebuilt from.
   * @param onReport - told about each dropped table; absent means silence.
   */
  hydrateVariables(
    lines: readonly SillyTavernMessage[],
    onReport?: (message: string) => void,
  ): void {
    const turns = lineTurns(this.session)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      // Only a reply's table belongs to a candidate. A user line's own
      // `variables` ride through untouched as an unmodelled field; attaching
      // them here would overwrite the reply's state for the same turn.
      if (line === undefined || line.is_user) continue
      const stored = line['variables']
      if (!Array.isArray(stored)) continue
      const turn = turns[index]
      if (turn === undefined) continue
      const candidates = listCandidates(this.session, turn)
      for (let swipe = 0; swipe < stored.length; swipe += 1) {
        const variables = stored[swipe]
        const candidate = candidates[swipe]
        if (candidate === undefined) {
          onReport?.(
            `variables: line ${String(index)} carries ${String(stored.length)} table(s) `
            + `but the turn has ${String(candidates.length)} candidate(s); table ${String(swipe)} dropped`,
          )
          continue
        }
        if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
          onReport?.(
            `variables: line ${String(index)} table ${String(swipe)} is `
            + `${Array.isArray(variables) ? 'an array' : typeof variables}, not an object; dropped`,
          )
          continue
        }
        this.session.append('iris/variables', { candidateSeq: candidate.seq, variables: variables as Variables })
      }
    }
  }

  /** The open-conversation view. */
  toView(): ChatView {
    const meta = this.meta
    return toChatView({
      chatId: this.chatId,
      title: meta.title,
      characterId: meta.characterId,
      session: this.session,
      names: this.names,
      keys: this.keys,
      pending: this.pending,
      scripts: this.scripts,
      substitute: this.substitute,
      variables: this.currentVariables(),
    })
  }

  /** The sidebar entry. */
  toSummary(): ChatSummary {
    const meta = this.meta
    return {
      chatId: this.chatId,
      title: meta.title,
      ...meta.characterId === undefined ? {} : { characterId: meta.characterId },
      ...meta.parentChatId === undefined ? {} : { parentChatId: meta.parentChatId },
      updatedAt: meta.updatedAt,
      messageCount: lineTurns(this.session).length,
    }
  }

  /** Bind a variable store to one log; the chat scope stays with the header. */
  #makeStore(session: Session): VariableStore {
    return new VariableStore({
      message: sessionMessageBackend(session),
      chat: metadataBackend(this.header),
      global: this.#globalScope,
      // Partitioned by script id, so one card's script cannot read another's
      // bookkeeping. Supplied by the caller — see the constructor.
      script: this.#scriptScope,
    })
  }

  /**
   * One floor's own variable layer, as a message frame reads it.
   *
   * Upstream, in `JS-Slash-Runner/src/function/variables.ts`:
   *
   * ```js
   * return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
   * ```
   *
   * Three things in that line are load-bearing and none of them is what the
   * `message` **scope** does here:
   *
   * - It reads **that floor's own slot**, with no walk backwards. The scope
   *   inherits from earlier turns so that a turn which wrote nothing still reads
   *   the running state; a floor anchor must not, or every floor would report
   *   the newest state it could reach and the anchoring would be decorative.
   * - It follows the **selected** swipe, `variables` being an array parallel to
   *   `swipes`.
   * - An absent layer is `{}` — an empty table, not `null` and not a refusal.
   *   A floor genuinely may have no variables, and that is not an error.
   * @param messageId - the chat-file line index, which is what a card counts.
   * @returns that floor's table, empty when it has none.
   */
  floorVariables(messageId: number): Variables {
    const turn = lineTurns(this.session)[messageId]
    if (turn === undefined) return {}
    const candidate = selectedCandidate(this.session, turn)
    if (candidate === undefined) return {}

    // The **last** table written for this candidate, not the first. The log is
    // append-only, so a floor that is written more than once — seeded at chat
    // creation and then updated by `script.setVariables`, say — has several
    // `iris/variables` events, and returning on the first match reports the
    // table as it was when the floor was born. The reading is well-formed,
    // complete, and stale, which is the failure that looks like nothing
    // happening. It stayed hidden because the ordinary path writes each
    // candidate once, so first and last coincide everywhere except after an
    // explicit write.
    let latest: Variables | undefined
    for (const event of this.session.events) {
      if (event.type === 'iris/variables' && event.data.candidateSeq === candidate.seq) {
        latest = event.data.variables as Variables
      }
    }
    if (latest === undefined) return {}

    // Through the prune record: a floor whose table was trimmed must report
    // what survived, not what was written. A pruned floor and one that never
    // wrote anything are the same thing to a reader, and upstream answers
    // both with `{}` — see `prune.ts` for why nothing is restored.
    return applyPruned(latest, prunedKeysOf(this.session).get(candidate.seq)) as Variables
  }

  /**
   * A floor's table together with **how it was arrived at**.
   *
   * {@link floorVariables} answers with a table and nothing else, which is right
   * for the ordinary read and wrong for a pruned floor: `{}` there means "this
   * was deleted" but reads as "there was never anything here". This carries the
   * distinction in a field of its own.
   *
   * **Replay is off unless asked for, and that is a ruling rather than a
   * default.** Two independent measurements put it there:
   *
   * - **Fidelity.** Replaying one floor forward from the previous floor's stored
   *   table reproduces `stat_data` in 93 of 121 adjacent full-floor corpus pairs
   *   — **77%**. The other 23% return a value that differs from what was stored,
   *   silently. Folding is deterministic (checked three ways), which does not
   *   help: it deterministically returns the same wrong value.
   * - **Cost.** A fold is p50 1.98 ms against a 187 KB state, so replaying one
   *   snapshot interval is ~108 ms of **synchronous** CPU. Not latency that
   *   overlaps with other work — 108 ms during which this process serves nobody.
   *
   * So the safe default is the named refusal, and replay is an explicit request
   * whose answer is labelled `replayed`.
   * @param messageId - the chat-file line index, which is what a card counts.
   * @param options - `replay` asks for reconstruction of a pruned floor.
   * @returns the table and its provenance.
   */
  readFloorVariables(messageId: number, options: { replay?: boolean } = {}): FloorRead {
    const turn = lineTurns(this.session)[messageId]
    const candidate = turn === undefined ? undefined : selectedCandidate(this.session, turn)
    if (turn === undefined || candidate === undefined) {
      return { variables: {}, origin: 'stored', note: `no floor at line ${String(messageId)}` }
    }

    const removed = prunedKeysOf(this.session).get(candidate.seq)
    const survived = this.floorVariables(messageId)
    if (removed === undefined || removed.size === 0) {
      return { variables: survived, origin: 'stored', note: 'as stored' }
    }

    const snapshot = this.#nearestIntactTurn(turn)
    if (options.replay !== true || snapshot === undefined) {
      return {
        variables: survived,
        origin: 'pruned',
        note: prunedNote(turn, removed, snapshot),
      }
    }

    const replayed = this.#replayFrom(snapshot, turn)
    return {
      variables: replayed as unknown as Record<string, unknown>,
      origin: 'replayed',
      note: `replayed from turn ${String(snapshot)}; this is a recomputed value and may differ from the one stored at the time`,
      replayedFrom: snapshot,
      replayedFloors: turn - snapshot,
    }
  }

  /**
   * The newest turn at or before `turn` whose table was never pruned.
   *
   * The starting point a replay is only as good as.
   *
   * **This walks back deliberately; do not simplify it to
   * `turn - turn % snapshotInterval`.** The interval is a user setting that can
   * change, and a floor kept under an *old* value is still perfectly intact.
   * Arithmetic against the *current* interval skips past such a floor and picks
   * a start further back than necessary — and that is not merely slower.
   * Fidelity falls as the replay lengthens: one folded floor reproduced the
   * stored `stat_data` in 93 of 121 corpus pairs, and every extra floor is
   * another chance to diverge with nothing saying it did. **The shortest
   * correct replay is also the most accurate one**, which is why the start is
   * found by asking each floor whether it survived rather than by computing
   * where a snapshot ought to be.
   * @param turn - the floor being asked about.
   * @returns the turn to fold forward from, or undefined when none survives.
   */
  #nearestIntactTurn(turn: number): number | undefined {
    const removed = prunedKeysOf(this.session)
    for (let earlier = turn - 1; earlier >= 0; earlier -= 1) {
      const candidate = selectedCandidate(this.session, earlier)
      if (candidate === undefined) continue
      const trimmed = removed.get(candidate.seq)
      if (trimmed === undefined || trimmed.size === 0) return earlier
    }
    return undefined
  }

  /**
   * Fold every turn's reply text forward from an intact floor.
   *
   * Reads each floor's **message text**, not its variables — the same material
   * upstream's `restoreVariables` uses, and the reason a future message-text
   * window must not evict the `mes` of any floor a replay can reach.
   * @param from - the intact turn to start at, whose stored table seeds the fold.
   * @param to - the turn wanted.
   * @returns the reconstructed table.
   */
  #replayFrom(from: number, to: number): MvuData {
    let state = this.baselineFor(from + 1)
    for (let turn = from + 1; turn <= to; turn += 1) {
      const candidate = selectedCandidate(this.session, turn)
      if (candidate === undefined) continue
      state = applyCommands(scanDialects(textOf(candidate.message)).commands, state).data
    }
    return state
  }

  /**
   * Trim the variable tables of turns old enough to have stopped mattering.
   *
   * The rule and the reasoning live in `prune.ts`. What belongs here is the one
   * sentence a caller needs: **this deletes state and nothing restores it.** The
   * snapshots kept on the interval are the only points a long conversation can
   * be reasoned back to.
   *
   * Nothing is rewritten — a prune is an appended record, so the log still says
   * exactly what happened and can explain, later, why a given floor reads empty.
   * @param options - the interval and the protection window.
   * @param onReport - told what was decided, per pruned turn.
   * @returns how many turns were pruned.
   */
  /**
   * Say so, once, when this chat is one upstream would offer to clean.
   *
   * Detection only. Upstream sweeps `[1, len - 1 - keep]` here — far more than
   * the periodic window — but only after asking, with an option to export the
   * chat first. **Doing the sweep without the question is the one version of
   * this that must not exist**, so this host reports and stops.
   *
   * Once per loaded chat: the condition stays true for as long as we decline to
   * act on it, so repeating it every turn would bury the log in a notice that
   * never changes.
   * @param options - the protection window, for the length gate.
   * @returns the line to report, or undefined when there is nothing to say.
   */
  legacyCleanupNote(options: PruneOptions = DEFAULT_PRUNE): string | undefined {
    if (this.#saidNeverCleaned) return undefined
    let firstFloor: Variables | undefined
    // Message 1, as upstream reads it. On this host a user row answers with its
    // reply’s table, which is the residual recorded in DEVIATIONS 14 — the
    // floor being asked about is the same one either way.
    try { firstFloor = this.readFloorVariables(1).variables } catch { return undefined }
    if (!looksNeverCleaned(firstFloor, chatLines(this.session).length, options)) return undefined
    this.#saidNeverCleaned = true
    return "this chat has never been cleaned: SillyTavern would offer to trim its"
      + " older variable tables here, with a backup first. This host does not do that"
      + " on its own — the periodic cleanup only ever touches a window near the"
      + ` newest ${String(options.keepRecent)} messages.`
  }

  /** Whether {@link legacyCleanupNote} has already spoken for this chat. */
  #saidNeverCleaned = false

  prune(options: PruneOptions = DEFAULT_PRUNE, onReport?: (message: string) => void): number {
    const removed = prunedKeysOf(this.session)
    const layers: { turn: number, index: number, candidateSeq: number, variables: Variables }[] = []
    const written = new Map<number, Variables>()
    for (const event of this.session.events) {
      if (event.type === 'iris/variables') written.set(event.data.candidateSeq, event.data.variables as Variables)
    }

    // The rules count chat lines, user rows included, so every layer travels
    // with the index of the line its reply occupies rather than its turn.
    const lines = chatLines(this.session)
    const newestIndex = lines.length - 1
    const replyIndex = new Map<number, number>()
    for (const [index, line] of lines.entries()) if (!line.isUser) replyIndex.set(line.turn, index)
    const turns = lines.map(line => line.turn)

    for (const turn of new Set(turns.filter((value): value is number => value !== undefined))) {
      for (const candidate of listCandidates(this.session, turn)) {
        const table = written.get(candidate.seq)
        if (table === undefined) continue
        // Already-pruned layers are excluded rather than re-planned: replanning
        // them would append a second record saying the same thing, and the count
        // this returns would report work that did not happen.
        if ((removed.get(candidate.seq)?.size ?? 0) > 0) continue
        const index = replyIndex.get(turn)
        // No line means no address the rules can read. Keeping it is the safe
        // direction, because the alternative deletes data on a guess.
        if (index === undefined) continue
        layers.push({ turn, index, candidateSeq: candidate.seq, variables: table })
      }
    }

    const plan = planPrune(layers, newestIndex, options)

    // **One line per run, not one per layer.** A run trims a whole window, and
    // twenty identical sentences are how a log stops being read — but the run
    // itself must speak every time, because it deletes something nothing restores.
    const taken = plan.filter(decision => decision.removed !== undefined)
    if (taken.length > 0) {
      const at = taken.map(decision => layers.find(one => one.candidateSeq === decision.candidateSeq)?.index)
        .filter((index): index is number => index !== undefined)
        .sort((first, second) => first - second)
      const listed = at.slice(0, 8).map(String).join(", ")
      const more = at.length > 8 ? ` and ${String(at.length - 8)} more` : ""
      // The newest floor below the trimmed range that still holds its table: the
      // point a reader has to fall back to, which is the only thing that makes the
      // loss navigable rather than merely announced.
      const kept = layers.filter(layer => !taken.some(decision => decision.candidateSeq === layer.candidateSeq))
        .map(layer => layer.index)
        .filter(index => index < (at[0] ?? 0))
      const nearest = kept.length === 0 ? undefined : Math.max(...kept)
      onReport?.(
        `variables: trimmed ${String(taken.length)} floor(s) at message ${listed}${more};`
        + ` removed ${PRUNED_KEYS.join(", ")} from each.`
        + (nearest === undefined
          ? " No intact floor remains below them."
          : ` The nearest intact floor below them is message ${String(nearest)}.`)
        + " This is not reversible.",
      )
    }
    return applyPrune(this.session, plan, layers)
  }

  /** Per-candidate variables, keyed by the chat-file line they belong to. */
  #snapshotVariables(): Map<number, (Variables | undefined)[]> {
    const byCandidate = new Map<number, Variables>()
    for (const event of this.session.events) {
      if (event.type === 'iris/variables') byCandidate.set(event.data.candidateSeq, event.data.variables)
    }
    // Applied once over the finished map rather than per event: a later
    // `iris/variables` for the same candidate is a rewrite, and the prune record
    // describes whatever the newest one says.
    const removed = prunedKeysOf(this.session)
    for (const [seq, table] of byCandidate) {
      byCandidate.set(seq, applyPruned(table, removed.get(seq)) as Variables)
    }

    const snapshot = new Map<number, (Variables | undefined)[]>()
    const turns = lineTurns(this.session)
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]
      if (turn === undefined) continue
      const candidates = listCandidates(this.session, turn)
      if (candidates.length === 0) continue
      const saved = candidates.map(candidate => byCandidate.get(candidate.seq))
      if (saved.some(entry => entry !== undefined)) snapshot.set(index, saved)
    }
    return snapshot
  }
}

/**
 * Which swipe of a turn is showing.
 * @param session - the chat log.
 * @param turn - the turn.
 * @returns the selected index, or `0` when the turn produced nothing.
 */
export function selectedIndex(session: Session, turn: number): number {
  return selectedCandidate(session, turn)?.index ?? 0
}

/**
 * Create an empty log for a new conversation.
 * @param chatId - the conversation's identity.
 * @returns a fresh session.
 */
export function createSession(chatId: string): Session {
  return Session.create(SessionId(chatId))
}
