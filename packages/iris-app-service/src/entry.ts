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
import { applyCommands, extractCommands, loadInitVars, type MvuData } from '@iris/mvu'
import {
  exportMessages,
  importChat,
  type SillyTavernChatHeader,
  type SillyTavernMessage,
} from '@iris/persistence'
import type { ChatSummary, ChatView } from '@iris/protocol'
import type { MacroSubstitute, RegexScript } from '@iris/regex'
import { memoryBackend, sessionMessageBackend, VariableStore, type ScopeBackend, type Variables } from '@iris/variables'

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

  #initVars: MvuData | undefined
  #scripts: RegexScript[] | undefined
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
  }) {
    this.chatId = input.chatId
    this.header = input.header
    this.session = input.session
    this.card = input.card
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
   * The macro expander this chat's scripts resolve their patterns with.
   *
   * Built once per chat because it closes over the speaker names, which is all
   * a script pattern can reference.
   */
  get substitute(): MacroSubstitute {
    this.#substitute ??= substituteFor(this.names)
    return this.#substitute
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
   * The spare `keys` mints past the end: a streaming row occupies it and the
   * settled row lands in the same slot. Only meaningful once the turn's user
   * line is in the log — before that the spare belongs to that line instead,
   * so a caller reads this after the driver has appended, not before.
   * @returns the identity to announce with `stream.start`.
   */
  get streamingKey(): string {
    const keys = this.keys
    return keys[keys.length - 1] as string
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
  recordVariables(turn: number, text: string): MvuData {
    const result = applyCommands(extractCommands(text), this.baselineFor(turn))
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
      if (line === undefined) continue
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
      const stored = lines[index]?.['variables']
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
      updatedAt: meta.updatedAt,
      messageCount: lineTurns(this.session).length,
    }
  }

  /** Bind a variable store to one log; the chat scope stays with the header. */
  #makeStore(session: Session): VariableStore {
    return new VariableStore({
      message: sessionMessageBackend(session),
      chat: metadataBackend(this.header),
      // Global variables are not reachable through the protocol yet, so nothing
      // would read a persisted copy back.
      global: memoryBackend(),
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
