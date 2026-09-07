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
import type { TimedEffect, TimedEffectState } from '@iris/lorebook'
import { expandHelperMacros } from '@iris/compat-tavernhelper'
import { createMacroContext, createMemoryVariableStore, expandMacros, type MacroMessage, type MemoryVariableStore, type TokenBudget } from '@iris/macro'
import { applyCommands, formatYamlBlock, loadInitVars, scanDialects, type MvuData } from '@iris/mvu'
import { extractScripts } from '@iris/script'

import type { ResolvedWorldbook } from './worldbooks.ts'
import { rowFields,
  exportMessages,
  importChat,
  withOriginalKeyOrder,
  type SillyTavernChatHeader,
  type SillyTavernMessage,
} from '@iris/persistence'
import type { ChatSummary, ChatView, PromptItemization, ScriptPromptPosition, TurnUsage } from '@iris/protocol'
import type { MacroSubstitute, RegexScript } from '@iris/regex'
import { keyedMemoryBackend, memoryBackend, sessionMessageBackend, VariableStore, type ScopeBackend, type Variables } from '@iris/variables'

import { scriptIdOf } from './script-variables.ts'

import { busy } from './errors.ts'
import { applyPrune, periodicWindow, SNAPSHOT_KEY, prunedRowsOf, applyRowPrune, applyPruned, DEFAULT_PRUNE, IGNORE_CLEANUP_KEY, legacyWindow, looksNeverCleaned, PRUNED_KEYS, type FloorRead, planPrune, prunedKeysOf, prunedNote, type PruneOptions } from './prune.ts'
import { scriptsOf } from './regex.ts'
import { parseFingerprint, type PromptFingerprint } from './fingerprint.ts'
import { fingerprintBySeq, parseUsage, usageBySeq, usageFieldOf, USAGE_FIELD } from './usage.ts'
import { projectMessages, textOf, toChatView, type Names, type PendingTurn } from './views.ts'

/**
 * One generation's per-candidate record, as the log holds it and the file
 * writes it: what the provider charged, and which request it was charged for.
 */
interface StoredGeneration {
  usage: TurnUsage
  fingerprint?: PromptFingerprint
}

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
  /**
   * Which frame run put it here, when the shell said which.
   *
   * Absent means no run owns it, so no run ending can clear it and it lives
   * until the chat closes — the behaviour every injection had before runs
   * existed. That is why the absence is reported rather than defaulted: an
   * injection nothing can clear is a leak, and a silent one.
   */
  runId?: string
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

/** The shape one sticky or cooldown window takes in `chat_metadata.timedWorldInfo`. */
interface StoredTimedEffect {
  hash: number
  start: number
  end: number
  protected: boolean
}

/**
 * Whether a value reads as one stored timed-effect window.
 *
 * Structural, not exact: upstream's own reader deletes entries whose value is
 * "not an object" and accepts everything else, trusting the file it wrote. This
 * checks the fields the engine will actually do arithmetic on, because a
 * window carrying `start: "three"` would poison a comparison rather than throw.
 * @param value - the candidate.
 * @returns true when the shape is usable.
 */
function isStoredTimedEffect(value: unknown): value is StoredTimedEffect {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row['hash'] === 'number'
    && typeof row['start'] === 'number'
    && typeof row['end'] === 'number'
    && typeof row['protected'] === 'boolean'
}

/**
 * Read the persisted sticky and cooldown windows out of a chat header.
 *
 * Upstream keeps these in `chat_metadata.timedWorldInfo` — regular chat
 * metadata, saved with the chat file — keyed by `"<world>.<uid>"`, with the
 * entry hash, the chat length the window opened at, and the chat length it
 * closes at. Reading the same key and the same shape is what makes a window
 * survive a host restart the way it survives anything else in SillyTavern, and
 * what makes the key legible if a chat ever moves between the two programs.
 * (The hashes themselves are Iris's and are not ST's; a chat arriving from
 * upstream carries windows that match no Iris entry, and the engine's own
 * rule for that — keep the window until it would have expired, then drop it —
 * is the gentlest possible landing.)
 * @param metadata - the chat header's metadata block.
 * @returns the windows, or undefined when none are stored.
 */
export function readTimedEffects(metadata: Record<string, unknown>): TimedEffectState | undefined {
  const stored = metadata['timedWorldInfo']
  if (typeof stored !== 'object' || stored === null) return undefined
  const raw = stored as Record<string, unknown>

  const readWindows = (kind: 'sticky' | 'cooldown'): Record<string, TimedEffect> => {
    const out: Record<string, TimedEffect> = {}
    const table = raw[kind]
    if (typeof table !== 'object' || table === null) return out
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (!isStoredTimedEffect(value)) continue
      out[key] = value
    }
    return out
  }

  const sticky = readWindows('sticky')
  const cooldown = readWindows('cooldown')
  if (Object.keys(sticky).length === 0 && Object.keys(cooldown).length === 0) return undefined
  return { sticky, cooldown }
}

/**
 * Write the timed-effect windows into a chat header's metadata.
 *
 * The mirror of {@link readTimedEffects}, and the write half of why the
 * windows survive: the engine returns fresh state every scan, the caller hands
 * it here beside the live field, and the next `save` puts it on disk. The same
 * key upstream uses, so the metadata a card script reads (`chatMetadata` in the
 * snapshot) shows the windows exactly as upstream's would.
 * @param metadata - the chat header's metadata block, mutated in place.
 * @param state - the engine's returned windows.
 */
export function writeTimedEffects(metadata: Record<string, unknown>, state: TimedEffectState): void {
  metadata['timedWorldInfo'] = structuredClone(state)
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

  /**
   * World-info outlet prompts by name, as the last scan produced them.
   *
   * Upstream keeps the activated outlet buckets in `extension_prompts` and
   * `{{outlet::key}}` reads them back from there, so a macro's answer is
   * "whatever the newest scan that filled this store produced". The host assigns
   * this through the prompt builder's sink between the scan and the expansion of
   * the preset's own text, which is the same order upstream's
   * `setExtensionPrompt` runs in. In memory, like every other live-scan product.
   */
  outletPrompts: Record<string, string> = {}
  /**
   * Index of the first message the last real assembly kept — what
   * `{{firstIncludedMessageId}}` answers.
   *
   * Upstream reads `chat_metadata.lastInContextMessageId`, written by the
   * previous generation's budget trim, so the value is one generation stale by
   * design and unset before the first one. Same shape here: assigned after a
   * real turn's assembly, never by a preview, and in memory only.
   */
  firstIncludedMessageId: number | undefined
  /**
   * The token budget the `{{maxContext}}` family reports.
   *
   * Assigned by the host per generation from the same settings the assembler
   * runs under — the context window, and the reply budget (`maxTokens` when
   * configured, else the assembly reserve). Absent until then, which renders
   * the three macros empty rather than pretending a route that is not there.
   */
  tokenBudget: TokenBudget | undefined

  #initVars: MvuData | undefined
  #initialVariables: Record<string, unknown> | undefined
  #scripts: RegexScript[] | undefined
  /** The global regex tier this chat opened with; replaced by `setGlobalScripts`. */
  #globalScripts: readonly RegexScript[]
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
  /** The active persona description, read at expansion time; see the constructor input. */
  #persona: (() => string) | undefined
  /**
   * The macro tier's one variable store, created on first use and held.
   *
   * Because the substitute rebuilds its context per call (the floors and the
   * outlet store change every turn; the store must not), the store it hands that
   * context is this one — a preset's `{{setvar}}` prompts and the `{{getvar}}`
   * prompt that reads them back stay in one table inside a single assembly.
   */
  #macroVariables: MemoryVariableStore | undefined
  /**
   * The floor view macros read, cached.
   *
   * Built from the same projection the UI renders, and invalidated at the three
   * places the conversation can change under it: `rebuild` (edits, deletes,
   * imports), and the two `pending` transitions (a turn starting and settling
   * both change what the newest floor is).
   */
  #macroChat: MacroMessage[] | undefined
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
    /**
     * The active persona description, read at expansion time.
     *
     * A function rather than a value because the user can switch personas while
     * the host runs, and a snapshot taken when the chat opened would serve the
     * old one. Absent means no persona, which is what `{{persona}}` expanded to
     * before a persona store existed.
     */
    persona?: () => string
    /**
     * The profile's global regex scripts, as they stand at open time.
     *
     * A snapshot rather than a live provider because the getter below is
     * synchronous and feeds three directions; {@link setGlobalScripts} is how a
     * change reaches entries that are already open.
     */
    globalScripts?: readonly RegexScript[]
  }) {
    this.chatId = input.chatId
    this.header = input.header
    this.session = input.session
    this.card = input.card
    this.worldbook = input.worldbook
    this.#persona = input.persona
    this.#globalScripts = input.globalScripts ?? []
    // Sticky and cooldown windows outlive the process in upstream: they live in
    // `chat_metadata.timedWorldInfo`, which is saved with the chat file. Restored
    // here rather than by the caller because every construction path — open,
    // branch, import — reads the same header, and a window that resets because a
    // host restarted would otherwise let a sticky entry lapse (or a cooled entry
    // fire) silently.
    this.timedEffects = readTimedEffects(input.header.chat_metadata)
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
    this.#scripts ??= scriptsOf(this.card, this.#globalScripts)
    return this.#scripts
  }

  /**
   * Replace the global tier and drop the composed list.
   *
   * This is how a `regex.set` reaches chats that are already open: the snapshot
   * each entry composed at open time is otherwise a fact about the past, and a
   * script the user just switched off would keep rewriting every page until the
   * chat happened to be reopened.
   */
  setGlobalScripts(scripts: readonly RegexScript[]): void {
    this.#globalScripts = scripts
    this.#scripts = undefined
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
   * Built once per chat, but the context under it is rebuilt per call: the
   * speaker names are fixed, while the floors, the outlet buckets and the token
   * budget all change from turn to turn and a cached context would serve
   * last turn's answer. Only the variable store is held across calls — see
   * {@link #macroVariables} for why it must be one table, not one per call.
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
      // The one store is held on the entry (`#macroVariables`) and supplied to
      // every per-call context, so **it is shared by every expansion in this
      // chat** — which is what a preset needs: its `{{setvar}}` prompts run
      // before the `{{getvar}}` prompt that reads them back, inside one
      // assembly.
      //
      // Binding it to the chat's persistent scopes was tried and reverted. It
      // was not needed (the preset works without it, verified end to end) and it
      // turned `prompt.itemize` — a read — into a write: previewing a prompt
      // stored three menu選択 into `chat_metadata.variables`. The fidelity gap it
      // would have closed is real but unmeasured: `{{setvar}}` here does not
      // survive a restart and is invisible to a card reading
      // `getVariables({type: 'chat'})`. Nothing in the corpus depends on either,
      // so the side effect was the only certain consequence.
      const variables = this.#macroVariables ??= createMemoryVariableStore()
      const { character, user } = this.names
      this.#substitute = (text, options) => {
        const macros = createMacroContext({
          char: character,
          user,
          // The active persona description, what upstream's `{{persona}}`
          // expands to (`script.js:3353`, the persona row of the macro
          // environment, which trims: `persona_description?.trim()`). Read at
          // expansion time, so a switch reaches the next expansion of this chat
          // without reopening it.
          persona: this.#persona?.().trim() ?? '',
          variables,
          chat: this.macroChat,
          // Same lifetime as upstream's `extension_prompts` round-trip: the
          // newest scan's buckets, read back wherever a template asks.
          outlet: key => this.outletPrompts[key] ?? '',
          ...this.firstIncludedMessageId === undefined
            ? {}
            : { firstIncludedMessageId: this.firstIncludedMessageId },
          ...this.tokenBudget === undefined ? {} : { tokenBudget: this.tokenBudget },
        })
        const expanded = expandMacros(text, macros, options?.postProcess === undefined
          ? {}
          : { postProcess: options.postProcess })
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
   * The conversation as macros see it: one row per chat-file line, in file
   * order, carrying each assistant line's candidate count and selection — the
   * `swipes`/`swipe_id` pair the swipe macros answer from.
   *
   * Deliberately the same walk that builds the UI's view (`projectMessages`):
   * one projection owns the turn-to-floor mapping, so a macro's `{{lastMessage}}`
   * and the surface's bottom row can never disagree about which floor is last.
   * The streaming row is left out: upstream's last-message macros skip a swipe
   * in progress (`getLastMessageId`'s `exclude_swipe_in_propress` default), and
   * a row still being generated is exactly that — the newest *settled* floor is
   * what `{{lastMessage}}` and the swipe pair answer from. Display-side regex
   * scripts are not applied either: macros see the stored text, which is what
   * the prompt sees too.
   */
  get macroChat(): readonly MacroMessage[] {
    if (this.#macroChat === undefined) {
      this.#macroChat = projectMessages(this.session, this.names, { keys: this.#keys })
        .filter(view => view.streaming !== true)
        .map(view => ({
          role: view.role,
          content: view.text,
          name: view.name,
          ...(view.swipes === undefined ? {} : { swipes: view.swipes.count, swipeId: view.swipes.index }),
        }))
    }
    return this.#macroChat
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
    // Remembered even when the value was empty — an `uninject` still proves the
    // run exists, and forgetting it would make a later run end look like a
    // mismatched pair.
    if (injection?.runId !== undefined) this.#seenRuns.add(injection.runId)
  }

  /**
   * Drop every injection a finished frame run left behind.
   *
   * **Only that run's.** Upstream empties one global table on every chat open,
   * which it can afford because it has exactly one active chat. This host may be
   * serving the same conversation to a second page whose run is still live, and
   * clearing by chat would pull that page's injected text out from under it —
   * the reason DEVIATIONS 10 holds injections per chat instead of clearing on
   * switch. Keyed by run, the two pages do not collide.
   * @param runId - the run the shell has torn down.
   * @returns how many injections went.
   */
  endScriptRun(runId: string): number {
    let cleared = 0
    for (const [key, injection] of [...this.extensionPrompts]) {
      if (injection.runId !== runId) continue
      this.extensionPrompts.delete(key)
      cleared += 1
    }
    return cleared
  }

  /**
   * Whether any injection on this chat has ever named this run.
   *
   * **Not the same question as "did it clear anything".** A run that injected
   * and was already cleared is known and clears nothing; a run this chat has
   * never seen clears nothing either, and the second is the shape a mismatched
   * `(chatId, runId)` pair takes. Telling them apart is the whole reason this
   * exists — and it is decided by having *seen* the name, never by reading
   * structure out of it.
   *
   * The one case it cannot separate: a run that legitimately injected nothing
   * looks exactly like a mismatch, because the host was never told it started.
   * The report says both possibilities rather than choosing one.
   * @param runId - the run to ask about.
   * @returns whether it has ever injected here.
   */
  hasScriptRun(runId: string): boolean {
    return this.#seenRuns.has(runId)
  }

  /** Runs that have injected on this chat, so an unknown one can be named. */
  readonly #seenRuns = new Set<string>()

  /**
   * Claim the chat for one generation.
   * @param turn - the turn about to be generated.
   * @returns the signal to hand the driver.
   * @throws {AppError} `busy` when a turn is already in flight.
   */
  begin(turn: number): AbortSignal {
    if (this.#abort !== undefined) throw busy('that chat is already generating')
    this.#abort = new AbortController()
    // The streaming row becomes the newest floor for macros too, exactly as the
    // growing message is the newest line upstream.
    this.#macroChat = undefined
    this.pending = { turn, text: '', reasoning: '' }
    return this.#abort.signal
  }

  /** Release the chat after a generation ends, however it ended. */
  finish(): void {
    this.#abort = undefined
    // The settled candidates (or their absence after an abort) change the newest
    // floor's swipe pair; the next expansion must re-walk the log.
    this.#macroChat = undefined
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

    // The host-stored extras, after the primary. MVU's own list reads
    // `[...selected_global_lorebooks, primary, ...additional]`
    // (`initvar/variable_init.ts:230`) — the additional bindings have a named
    // position in it, so a book the user bound to this character through the
    // host seeds variables exactly as it would upstream. Same skip rules as
    // above: a name already folded (an extra that duplicates the primary or a
    // global) contributes once, and an empty book leaves no row.
    for (const book of chosen?.additional ?? []) {
      if (seen.has(book.world) || book.entries.length === 0) continue
      seen.add(book.world)
      books.push({ name: book.world, entries: book.entries })
    }

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

  /**
   * Hold what the provider charged until there is a candidate to hang it on.
   *
   * The `usage` chunk arrives while the reply is still streaming — before the
   * driver has appended the candidate — so the number has nowhere to live for
   * the length of one turn. It rides on `pending`, which is the host's own
   * record of the generation in flight and is cleared by {@link finish}
   * whatever the outcome: a turn that failed leaves nothing behind, which is
   * correct, because no candidate was written either.
   *
   * Guarded on the turn rather than trusting the caller: a chunk arriving for
   * a turn that is no longer pending belongs to a generation that has already
   * settled or been abandoned, and attaching it would charge this turn for
   * that one.
   * @param turn - the turn the chunk arrived for.
   * @param usage - what the provider reported.
   */
  noteUsage(turn: number, usage: TurnUsage): void {
    if (this.pending === undefined || this.pending.turn !== turn) return
    this.pending.usage = usage
  }

  /**
   * Hold which request this generation sent until there is a candidate to hang
   * it on.
   *
   * The same shape and the same guard as {@link noteUsage} beside it — the
   * fingerprint is computed at the moment the body leaves for the provider,
   * which is before the candidate exists — and for the same reason: a
   * fingerprint arriving for a turn that is no longer pending belongs to a
   * generation that has already settled, and attaching it would label this
   * turn's cost with that turn's prompt.
   * @param turn - the turn the request was assembled for.
   * @param fingerprint - the hashes of the body that went out.
   */
  notePromptFingerprint(turn: number, fingerprint: PromptFingerprint): void {
    if (this.pending === undefined || this.pending.turn !== turn) return
    this.pending.fingerprint = fingerprint
  }

  /**
   * Attach a generation's cost to the candidate it produced.
   *
   * **The newest candidate of the turn, not the selected one.** A generation
   * always appends, so the newest candidate is by construction the one just
   * paid for — while `selectedCandidate` answers with whatever the last
   * `iris/swipe-select` chose, which after "swipe back, then regenerate" is an
   * *older* candidate (measured: `selectedCandidate` returns index 0 after a
   * third generation on a turn whose selection was moved to 0). Reading the
   * selection here would file this turn's bill against a reply that was
   * generated earlier and is already carrying its own.
   *
   * Nothing is recorded when the provider reported nothing — see the protocol's
   * `TurnUsage`: no field may be invented, and a generation with no usage at
   * all must produce no record rather than a zero-filled one. **The request
   * fingerprint rides on that same record**, so a provider that reports no
   * usage leaves no stored fingerprint either: the pair exists to be read
   * together (a prefix hash beside a cache figure), and half of it persisted
   * alone would answer nothing while looking like an answer. The report line
   * this generation emitted still carries both.
   * @param turn - the turn that just settled.
   * @param usage - what it cost; the noted value when absent.
   * @returns whether a record was appended.
   */
  recordUsage(turn: number, usage: TurnUsage | undefined = this.pending?.usage): boolean {
    if (usage === undefined) return false
    const candidates = listCandidates(this.session, turn)
    const candidate = candidates[candidates.length - 1]
    // An impersonation's text became a *user* line, so its turn has no
    // candidate. Its cost is genuinely unrecordable in this shape and is
    // dropped rather than parked on a neighbouring reply.
    if (candidate === undefined) return false
    const fingerprint = this.pending?.turn === turn ? this.pending.fingerprint : undefined
    this.session.append('iris/usage', {
      candidateSeq: candidate.seq,
      usage,
      ...fingerprint === undefined ? {} : { fingerprint },
    })
    return true
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
    // Costs travel with the same mapping as the variables, and for the same
    // reason: `importChat` reassigns every seq, so a per-candidate record that
    // is not carried across by position is lost. A reply-shaping trim rebuilds
    // the log **immediately after** the usage was recorded, so dropping it here
    // would make the number vanish for every chat with `trimSentences` on —
    // visible only as "the numbers show up for some users and not others".
    const beforeUsage = this.#snapshotUsage()
    // The floor projection is a view of the old log; every macro that reads it
    // after this point must see the rebuilt one.
    this.#macroChat = undefined

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
      const turn = turns[index]
      if (turn === undefined) continue
      const candidates = listCandidates(rebuilt, turn)

      const saved = before.get(source)
      for (let swipe = 0; swipe < (saved?.length ?? 0); swipe += 1) {
        const variables = saved?.[swipe]
        const candidate = candidates[swipe]
        if (variables === undefined || candidate === undefined) continue
        rebuilt.append('iris/variables', { candidateSeq: candidate.seq, variables })
      }

      const savedUsage = beforeUsage.get(source)
      for (let swipe = 0; swipe < (savedUsage?.length ?? 0); swipe += 1) {
        const record = savedUsage?.[swipe]
        const candidate = candidates[swipe]
        if (record === undefined || candidate === undefined) continue
        // Cost and fingerprint travel together, as one record: a rebuild that
        // carried the cost across and left the hashes behind would make a
        // sentence trim look like a prompt change.
        rebuilt.append('iris/usage', {
          candidateSeq: candidate.seq,
          usage: record.usage,
          ...record.fingerprint === undefined ? {} : { fingerprint: record.fingerprint },
        })
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
    // What each generation cost, in the same positional shape as the tables
    // above: one entry per swipe, `null` where that swipe reported nothing.
    // `null` rather than a gap, because a sparse array serialises to `null`s
    // anyway and an explicit one says "this swipe was generated and its
    // provider told us nothing" rather than leaving the reader to count.
    //
    // Written outside `extra` on purpose — see `USAGE_FIELD` for the
    // measurement that decided it. SillyTavern's own `extra.token_count` is
    // never read and never written here.
    //
    // The request fingerprint is written into the **same object** as the
    // buckets, not into a sibling array: it is one record about one generation,
    // and a parallel array would be a second thing for SillyTavern's swipe
    // deletion to shift out from under (`USAGE_FIELD` names that residual).
    // `parseUsage` ignores the two extra keys, so a file written here is read
    // back by an older reader with its costs intact.
    for (const [index, saved] of this.#snapshotUsage()) {
      const line = messages[index]
      // Assistant lines only, for the reason the tables give above: a turn's
      // user line shares its turn number and would be charged for the reply.
      if (line === undefined || line.is_user) continue
      const swipes = line['swipes']
      const width = Math.max(1, Array.isArray(swipes) ? swipes.length : 1)
      line[USAGE_FIELD] = Array.from({ length: width }, (_unused, swipe) => {
        const record = saved[swipe]
        if (record === undefined) return null
        return { ...record.usage, ...record.fingerprint ?? {} }
      })
    }

    // **Row-level trims, applied on the way out.** A user row’s table is not a
    // candidate in this log, so nothing above has touched it; the record says
    // which keys a sweep took from it. Applied here rather than at import
    // because the log must keep saying what the file originally held.
    const trimmedRows = prunedRowsOf(this.session)
    if (trimmedRows.removed.size > 0 || trimmedRows.marked.size > 0) {
      for (const [index, line] of messages.entries()) {
        if (line === undefined || line.is_user !== true) continue
        const tables = line['variables']
        if (!Array.isArray(tables) || tables.length === 0) continue
        const first = tables[0]
        if (typeof first !== 'object' || first === null) continue
        const next = applyRowPrune(
          first as Record<string, unknown>,
          trimmedRows.removed.get(index),
          trimmedRows.marked.has(index),
        )
        line['variables'] = [next, ...tables.slice(1)]
      }
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

  /**
   * Put a loaded file's per-candidate costs back into the log.
   *
   * The same shape and the same drop rules as {@link hydrateVariables} beside
   * it: entries are positional, a surplus entry has no candidate to belong to
   * and is dropped with a report, and an entry that is not a well-formed usage
   * object is dropped rather than carried (`parseUsage` says why).
   *
   * **Nothing is computed for a reply that carries none.** A conversation
   * imported from SillyTavern, or one generated before this host recorded
   * usage, has no provider figures and never will — the request was made and
   * answered long ago. Estimating them here would put a number that looks like
   * a measurement next to ones that are.
   * @param lines - the message lines the log was rebuilt from.
   * @param onReport - told about each dropped entry; absent means silence.
   */
  hydrateUsage(
    lines: readonly SillyTavernMessage[],
    onReport?: (message: string) => void,
  ): void {
    const turns = lineTurns(this.session)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === undefined || line.is_user) continue
      const stored = usageFieldOf(line)
      if (stored.length === 0) continue
      const turn = turns[index]
      if (turn === undefined) continue
      const candidates = listCandidates(this.session, turn)
      for (let swipe = 0; swipe < stored.length; swipe += 1) {
        const usage = parseUsage(stored[swipe])
        // A `null` entry is the ordinary case — that swipe reported nothing —
        // and says nothing worth reporting.
        if (usage === undefined) {
          if (stored[swipe] !== null && stored[swipe] !== undefined) {
            onReport?.(
              `usage: line ${String(index)} entry ${String(swipe)} is not a usage record; dropped`,
            )
          }
          continue
        }
        const candidate = candidates[swipe]
        if (candidate === undefined) {
          onReport?.(
            `usage: line ${String(index)} carries ${String(stored.length)} entr(ies) `
            + `but the turn has ${String(candidates.length)} candidate(s); entry ${String(swipe)} dropped`,
          )
          continue
        }
        // The fingerprint is read from the same object, and its absence says
        // nothing: every chat written before this record existed has costs and
        // no hashes, which is exactly the state a reader must not mistake for
        // "the prompt changed".
        const fingerprint = parseFingerprint(stored[swipe])
        this.session.append('iris/usage', {
          candidateSeq: candidate.seq,
          usage,
          ...fingerprint === undefined ? {} : { fingerprint },
        })
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
   * The line that records, for the diagnostics view, that this chat qualifies.
   *
   * **Not the dialog.** The three-button prompt is raised by `cleanup.offer` on
   * every `chat.open`, which is when upstream asks; this is only the written
   * record of the same fact, and it is the half that is rationed.
   *
   * Once per loaded chat, because the condition holds until someone answers and
   * a line per turn would bury the log in a notice that never changes. The
   * weaker guarantee is deliberate — see the faithful-reproduction column, which
   * also says why the flag is not persisted into the user's own chat file.
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
    return "this chat has never been cleaned: SillyTavern offers to trim its older"
      + " variable tables here, with a backup first. The same offer has been raised"
      + " for this chat; until something answers it nothing is swept, and the"
      + ` periodic cleanup only touches a window near the newest ${String(options.keepRecent)} messages.`
  }

  /**
   * The offer this chat would raise, or undefined when it would raise none.
   * @param options - the interval and the protection window.
   * @returns the range a sweep would cover and how many layers sit in it.
   */
  legacyCleanupOffer(options: PruneOptions = DEFAULT_PRUNE): {
    lines: number, from: number, to: number, layers: number,
  } | undefined {
    const lines = chatLines(this.session).length
    if (!looksNeverCleaned(this.#firstRowTable(), lines, options)) return undefined
    const { from, to } = legacyWindow(lines, options)
    const layers = this.#legacyLayers(options).length
    return { lines, from, to, layers }
  }

  /**
   * The layers a legacy sweep would take.
   * @param options - the interval and the protection window.
   * @returns one entry per layer the plan marks for removal.
   */
  #legacyLayers(options: PruneOptions): { removed?: string[] }[] {
    const lines = chatLines(this.session)
    const plan = planPrune(
      this.#pruneLayers(),
      lines.length - 1,
      options,
      legacyWindow(lines.length, options),
    )
    return plan.filter(decision => decision.removed !== undefined)
  }

  /**
   * Run the sweep upstream runs once a user has agreed to it.
   *
   * **Only ever after an answer.** The range is the whole history bar the
   * protected tail, which is why upstream asks first and offers a backup; this
   * method is the "yes" branch and nothing calls it on its own.
   * @param options - the interval and the protection window.
   * @param onReport - told what went.
   * @returns how many layers were trimmed.
   */
  sweepLegacy(options: PruneOptions = DEFAULT_PRUNE, onReport?: (message: string) => void): number {
    const lines = chatLines(this.session)
    const layers = this.#pruneLayers()
    const plan = planPrune(layers, lines.length - 1, options, legacyWindow(lines.length, options))
    const rowsTrimmed = this.#pruneRows(legacyWindow(lines.length, options), options)
    const taken = plan.filter(decision => decision.removed !== undefined)
    if (taken.length > 0) {
      const at = taken.map(decision => layers.find(one => one.candidateSeq === decision.candidateSeq)?.index)
        .filter((index): index is number => index !== undefined)
        .sort((first, second) => first - second)
      // The total, not one path’s share. Replies and user rows go by the same
      // rule from different places, and counting only replies made a run that
      // deleted forty-two tables announce twenty-one.
      const rows = rowsTrimmed > 0 ? ` and ${String(rowsTrimmed)} user row(s)` : ""
      onReport?.(
        `variables: a one-time cleanup trimmed ${String(taken.length)} floor(s)${rows} between`
        + ` message ${String(at[0])} and ${String(at[at.length - 1])}, which you agreed to.`
        + " This is not reversible.",
      )
    }
    return applyPrune(this.session, plan, layers) + rowsTrimmed
  }

  /**
   * Record that this chat declined the offer, under upstream’s own key.
   *
   * Written where upstream writes it — `chat[1].variables[0]` — so a chat moved
   * between the two hosts carries the answer its owner gave. This is the one
   * piece of state here that belongs in the user’s file, because it is the
   * user’s decision rather than our bookkeeping.
   * @returns whether the refusal was recorded.
   */
  recordCleanupRefusal(): boolean {
    const line = chatLines(this.session)[1]
    if (line === undefined) return false
    const fields = rowFields(this.session, line.seq)
    const tables = Array.isArray(fields['variables']) ? [...fields['variables'] as unknown[]] : []
    const first = typeof tables[0] === 'object' && tables[0] !== null ? tables[0] as Record<string, unknown> : {}
    tables[0] = { ...first, [IGNORE_CLEANUP_KEY]: true }
    // **Appended, not edited.** The log never rewrites what it already said;
    // `rowFields` reads the newest record for a line, so a fresh set of carried
    // fields is how a row-level value changes after import.
    this.session.append('iris/st-meta', { seq: line.seq, fields: { ...fields, variables: tables }, order: 1 })
    return true
  }

  /**
   * The table on message 1 **as the file holds it**, not as a card would read it.
   *
   * Two different objects share one address here, and using the wrong one
   * widens a deletion feature. A card asking for message 1 gets its *turn’s*
   * table, because this host has no per-user-row variable store — the residual
   * recorded in DEVIATIONS 14. But upstream’s legacy gate is not asking what a
   * card would read; it is asking **what shape this file is**, and it reads the
   * literal `chat[1].variables[0]`.
   *
   * On a chat SillyTavern grew, that row has a table: measured on the corpus,
   * 16 of 17 chats with three or more messages carry one on `chat[1]`, and
   * 1217 of 1219 user rows carry one overall. On a chat this host grew it does
   * not, because we do not write tables to user rows. **That difference is the
   * gate**, and reading it through the card-facing projection erases it — every
   * long chat then answers yes, and a whole-history sweep gets offered where
   * upstream would never offer one.
   * @returns the row’s own first table, or undefined when it has none.
   */
  #firstRowTable(): Record<string, unknown> | undefined {
    return this.#rowTable(1)
  }

  /**
   * Trim the row-level tables in a range, and record it as one event.
   *
   * **User rows only.** An assistant row’s table is rebuilt from its candidate
   * on export, so trimming it here would be doing the same work twice against a
   * value that is about to be overwritten. A user row has no candidate — its
   * table rides through `iris/st-meta` — and upstream trims it all the same,
   * because `cleanupMessageVariables` walks the range without asking `is_user`.
   * @param range - the inclusive message-index range to examine.
   * @param options - the interval, for the snapshot rule.
   * @returns how many rows were trimmed.
   */
  #pruneRows(range: { from: number, to: number }, options: PruneOptions): number {
    const already = prunedRowsOf(this.session)
    const rows: { index: number, removed: string[] }[] = []
    const marked: number[] = []

    for (const [index, line] of chatLines(this.session).entries()) {
      if (!line.isUser || index < range.from || index > range.to) continue
      const table = this.#rowTable(index)
      if (table === undefined) continue
      if (table[SNAPSHOT_KEY] === true) continue
      // The interval rule does not ask `is_user` either: a user row on the
      // interval is kept and marked, exactly as a reply would be.
      if (options.snapshotInterval > 0 && index % options.snapshotInterval === 0) {
        if (!already.marked.has(index)) marked.push(index)
        continue
      }
      const removed = PRUNED_KEYS.filter(key => key in table)
      if (removed.length === 0) continue
      rows.push({ index, removed: [...removed] })
    }

    if (rows.length === 0 && marked.length === 0) return 0
    this.session.append('iris/rows-pruned', { rows, marked, at: Date.now() })
    return rows.length
  }

  /**
   * One row’s own table, as it reads after every trim recorded here.
   * @param index - the message index.
   * @returns the table, or undefined when the row carries none.
   */
  #rowTable(index: number): Record<string, unknown> | undefined {
    const line = chatLines(this.session)[index]
    if (line === undefined) return undefined
    const tables = rowFields(this.session, line.seq)['variables']
    if (!Array.isArray(tables)) return undefined
    const first = tables[0]
    if (typeof first !== 'object' || first === null) return undefined
    const { removed, marked } = prunedRowsOf(this.session)
    return applyRowPrune(first as Record<string, unknown>, removed.get(index), marked.has(index))
  }


  /** Whether {@link legacyCleanupNote} has already spoken for this chat. */
  #saidNeverCleaned = false

  /**
   * Every layer a cleanup could consider, with the message index that addresses it.
   *
   * Shared by the periodic pass and the one-time sweep so the two cannot drift on
   * what a layer *is* — they differ only in the range they examine.
   * @returns one entry per candidate table not already pruned.
   */
  #pruneLayers(): { turn: number, index: number, candidateSeq: number, variables: Variables }[] {
    const removed = prunedKeysOf(this.session)
    const layers: { turn: number, index: number, candidateSeq: number, variables: Variables }[] = []
    const written = new Map<number, Variables>()
    for (const event of this.session.events) {
      if (event.type === 'iris/variables') written.set(event.data.candidateSeq, event.data.variables as Variables)
    }

    // The rules count chat lines, user rows included, so every layer travels
    // with the index of the line its reply occupies rather than its turn.
    const lines = chatLines(this.session)
    const replyIndex = new Map<number, number>()
    for (const [index, line] of lines.entries()) if (!line.isUser) replyIndex.set(line.turn, index)

    for (const turn of new Set(lines.map(line => line.turn))) {
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
    return layers
  }

  prune(options: PruneOptions = DEFAULT_PRUNE, onReport?: (message: string) => void): number {
    const layers = this.#pruneLayers()
    const newestIndex = chatLines(this.session).length - 1
    const plan = planPrune(layers, newestIndex, options)
    // Row-level tables in the same window, by the same rules. Upstream trims
    // both in one walk; we hold them in two places, so it is two calls.
    const rowsTrimmed = this.#pruneRows(periodicWindow(newestIndex, options), options)

    // **One line per run, not one per layer.** A run trims a whole window, and
    // twenty identical sentences are how a log stops being read — but the run
    // itself must speak every time, because it deletes something nothing restores.
    const taken = plan.filter(decision => decision.removed !== undefined)
    if (taken.length > 0 || rowsTrimmed > 0) {
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
      // The total, for the same reason as the sweep above.
      const rows = rowsTrimmed > 0 ? ` and ${String(rowsTrimmed)} user row(s)` : ""
      onReport?.(
        `variables: trimmed ${String(taken.length)} floor(s)${rows} at message ${listed}${more};`
        + ` removed ${PRUNED_KEYS.join(", ")} from each.`
        + (nearest === undefined
          ? " No intact floor remains below them."
          : ` The nearest intact floor below them is message ${String(nearest)}.`)
        + " This is not reversible.",
      )
    }
    return applyPrune(this.session, plan, layers) + rowsTrimmed
  }

  /**
   * Per-candidate costs, keyed by the chat-file line they belong to.
   *
   * The same projection {@link #snapshotVariables} makes, over the other
   * per-candidate record: line index to one entry per swipe, in swipe order,
   * `undefined` where that swipe reported nothing. Lines where no swipe
   * reported anything are absent from the map entirely, so a chat that has
   * never generated through a usage-reporting provider writes no new key into
   * its file at all.
   * The **fingerprint travels with the cost** rather than in a second
   * projection: they are one record per generation (`iris/usage`), one entry
   * per swipe in the file, and separating them here would let a rebuild carry
   * one across and drop the other — which reads as "this turn's prompt was
   * different" on a turn whose prompt nobody recorded.
   * @returns costs by line index, only for lines that have any.
   */
  #snapshotUsage(): Map<number, (StoredGeneration | undefined)[]> {
    const byCandidate = usageBySeq(this.session)
    const printByCandidate = fingerprintBySeq(this.session)
    const snapshot = new Map<number, (StoredGeneration | undefined)[]>()
    const turns = lineTurns(this.session)
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]
      if (turn === undefined) continue
      const candidates = listCandidates(this.session, turn)
      if (candidates.length === 0) continue
      const saved = candidates.map((candidate) => {
        const usage = byCandidate.get(candidate.seq)
        if (usage === undefined) return undefined
        const fingerprint = printByCandidate.get(candidate.seq)
        return { usage, ...fingerprint === undefined ? {} : { fingerprint } }
      })
      if (saved.some(entry => entry !== undefined)) snapshot.set(index, saved)
    }
    return snapshot
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
