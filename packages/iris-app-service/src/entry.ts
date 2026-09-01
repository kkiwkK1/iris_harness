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
import {
  exportMessages,
  importChat,
  type SillyTavernChatHeader,
  type SillyTavernMessage,
} from '@iris/persistence'
import type { ChatSummary, ChatView, PromptItemization, ScriptPromptPosition } from '@iris/protocol'
import type { MacroSubstitute, RegexScript } from '@iris/regex'
import { keyedMemoryBackend, memoryBackend, sessionMessageBackend, VariableStore, type ScopeBackend, type Variables } from '@iris/variables'

import { scriptIdOf } from './script-variables.ts'

import { busy } from './errors.ts'
import { scriptsOf, substituteFor } from './regex.ts'
import { toChatView, type Names, type PendingTurn } from './views.ts'

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
export function lineTurns(session: Session): number[] {
  const turns: number[] = []
  const seen = new Set<number>()
  let turn = 0

  for (const event of session.events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }
    if (event.type === 'user/message') {
      turns.push(turn)
      continue
    }
    if (event.type !== 'assistant/message') continue
    if (seen.has(event.data.turn)) continue
    seen.add(event.data.turn)
    turns.push(event.data.turn)
  }
  return turns
}

/** One live conversation and everything bound to it. */
export class ChatEntry {
  readonly chatId: string
  header: SillyTavernChatHeader
  session: Session
  variables: VariableStore
  card: CharacterCard | undefined
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
  readonly extensionPrompts = new Map<string, { value: string, position: ScriptPromptPosition, depth: number }>()
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
  }) {
    this.chatId = input.chatId
    this.header = input.header
    this.session = input.session
    this.card = input.card
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
          formatBlock: formatYamlBlock,
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
    injection: { value: string, position: ScriptPromptPosition, depth: number } | undefined,
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
    const book = this.card?.data.character_book
    if (book === undefined) {
      this.#initVars = EMPTY_MVU
      return this.#initVars
    }
    const entries = Array.isArray(book.entries) ? book.entries : []
    this.#initVars = loadInitVars(
      [{ name: this.card?.data.name ?? 'character book', entries }],
      EMPTY_MVU,
    ).data
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
  toFile(): { header: SillyTavernChatHeader, messages: SillyTavernMessage[] } {
    const messages = exportMessages(this.session, this.header)
    for (const [index, saved] of this.#snapshotVariables()) {
      const line = messages[index]
      // Assistant lines only. A turn's user line and its reply share a turn
      // number, so writing the candidate's table to both would put the reply's
      // state on the user's message — and would clobber whatever the imported
      // file had there, which `iris/st-meta` has already restored verbatim.
      if (line === undefined || line.is_user) continue
      line['variables'] = saved.map(variables => variables ?? {})
    }
    return { header: this.header, messages }
  }

  /**
   * Put a loaded file's per-candidate variables back into the log.
   *
   * `importChat` restores the conversation but knows nothing about variables —
   * it carries them through as opaque unmodelled fields. Reattaching them here
   * is what makes MVU state survive a reload rather than silently resetting to
   * the world book's declaration.
   * @param lines - the message lines the log was rebuilt from.
   */
  hydrateVariables(lines: readonly SillyTavernMessage[]): void {
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
        if (candidate === undefined) continue
        if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) continue
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

  /** Per-candidate variables, keyed by the chat-file line they belong to. */
  #snapshotVariables(): Map<number, (Variables | undefined)[]> {
    const byCandidate = new Map<number, Variables>()
    for (const event of this.session.events) {
      if (event.type === 'iris/variables') byCandidate.set(event.data.candidateSeq, event.data.variables)
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
