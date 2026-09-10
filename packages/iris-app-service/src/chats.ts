/**
 * Conversations on disk.
 *
 * The store's format is SillyTavern's own chat JSONL, one file per
 * conversation, because that is the ecosystem's interchange format and a
 * private one would strand every chat inside Iris. What Iris adds — the chat's
 * id, its title, which card it belongs to — goes in the header's own object, a
 * place the format already carries through untouched.
 *
 * @module @iris/app-service/chats
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { CharacterCard } from '@iris/character'
import { appendCandidate, selectCandidate } from '@iris/chat'
import { createMacroContext, expandMacros } from '@iris/macro'
import {
  formatChatFile,
  parseChatFile,
  importChat,
  type SillyTavernChat,
  type SillyTavernChatHeader,
  type SillyTavernMessage,
} from '@iris/persistence'
import type { ChatSearchHit, ChatSearchMatch, ChatSummary, UsageSummary } from '@iris/protocol'
import type { RegexScript } from '@iris/regex'
import type { PresetRegexTier, ScopedRegexPolicy } from './regex.ts'
import type { ScopeBackend, Variables } from '@iris/variables'

import { BackupStore } from './backups.ts'
import { ChatEntry, createSession, readMeta } from './entry.ts'
import { invalid, notFound } from './errors.ts'
import type { CharacterLibrary } from './library.ts'
import { fileFor, isSafeId, toId, uniqueId } from './paths.ts'
import {
  readChatUsage, summariseUsage, type ChatUsage, type UsageSummaryOptions,
} from './usage-summary.ts'
import { resolveCardWorldbook, WorldbookStore } from './worldbooks.ts'
import type { ScriptVariableStore } from './script-variables.ts'

/** Provenance stamped on a greeting, which no model produced. */
const GREETING_SOURCE = { provider: 'iris', model: 'greeting' } as const

/**
 * SillyTavern's `create_date` spelling.
 *
 * Local time, not UTC: the field is shown to the user in the chat list, and a
 * conversation started at 9pm should not be listed as tomorrow.
 * @param when - the moment to format.
 * @returns e.g. `2026-08-31 @21h04m17s`.
 */
export function formatCreateDate(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  return `${date} @${pad(when.getHours())}h${pad(when.getMinutes())}m${pad(when.getSeconds())}s`
}

/** A short, sortable stamp, so a character's chats list in the order they began. */
function stamp(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    String(when.getFullYear()),
    pad(when.getMonth() + 1),
    pad(when.getDate()),
    '-',
    pad(when.getHours()),
    pad(when.getMinutes()),
    pad(when.getSeconds()),
  ].join('')
}

/** Reads, caches and writes conversations. */
export class ChatStore {
  readonly #dir: string
  readonly #library: CharacterLibrary
  readonly #scriptVariables: ScriptVariableStore | undefined
  /**
   * Storage for the `global` scope, shared by every chat in this profile.
   *
   * One backend for the whole store rather than one per chat: the scope is
   * installation-wide by upstream's definition, so two chats reading it must see
   * the same tree — a per-chat copy would let one chat's write vanish when
   * another wrote next.
   */
  readonly #globalScope: ScopeBackend | undefined
  /** Named books, for choosing which one a card's world info comes from. */
  readonly #worldbooks: WorldbookStore | undefined
  /**
   * The globally selected book names, read fresh each time a chat opens.
   *
   * A function rather than a value because the selection is a setting the user
   * can change while the host is running, and a snapshot taken at construction
   * would leave every chat opened afterwards using the old one.
   */
  readonly #globalSelect: (() => readonly string[]) | undefined
  readonly #entries = new Map<string, ChatEntry>()
  /**
   * Materialise a card's embedded book and say which named book it became.
   *
   * Injected rather than built here so this store stays unaware of bindings and
   * hashes; the same function runs on the import path, so a card materialises
   * once however it first arrives.
   */
  readonly #bookFor:
    | ((characterId: string | undefined, card: CharacterCard | undefined) => Promise<string | undefined>)
    | undefined
  /**
   * The active persona description, read when a chat's macros expand.
   *
   * The same function is shared by every entry this store builds, so a persona
   * switch reaches every conversation at its next expansion without any of
   * them being reopened.
   */
  readonly #persona: (() => string) | undefined
  /**
   * The additional books bound to a character through the host, read when a
   * chat opens.
   *
   * Upstream's `world_info.charLore[<file name>].extraBooks`. The same shape as
   * `#globalSelect` for the same reason: the bindings are something the user
   * edits while the host runs, and a snapshot taken at construction would leave
   * every chat opened afterwards resolving against the old ones. A re-open is
   * the moment the new list reaches a conversation, exactly as a changed
   * global selection is.
   */
  readonly #charBooks: ((characterId: string) => readonly string[]) | undefined
  /**
   * The profile's global regex scripts, read fresh each time a chat opens.
   *
   * The same shape as `#globalSelect`: the list is something the user edits
   * while the host runs, and a snapshot taken here would outlive the edit. Read
   * once per open rather than per message because the scripts getter is
   * synchronous and feeds three directions; `refreshGlobalRegex` is the path a
   * `regex.set` takes to reach chats that are already open.
   */
  readonly #globalRegex: (() => Promise<readonly RegexScript[]>) | undefined
  /**
   * The user's decisions about the *card's* regex tier, read fresh each open.
   *
   * The second half of what {@link ChatEntry.scripts} composes, and it is read
   * here for `#globalRegex`'s reason: the allow switch and the per-rule switches
   * are edited while the host runs, and a snapshot taken at construction would
   * outlive the edit. `refreshRegex` is the path a change takes to a chat that
   * is already open.
   */
  readonly #scopedRegex: ((characterId: string) => Promise<ScopedRegexPolicy>) | undefined
  /**
   * The active preset's own regex tier, read fresh each open.
   *
   * The third of the three tiers {@link ChatEntry.scripts} composes, and a
   * closure for the two reasons above plus one of its own: **which preset is
   * active is itself runtime state.** A snapshot taken at construction would
   * keep running the rules of whatever preset the host started on, so a switch
   * would change every prompt in the assembly and none of the rewrites over it.
   *
   * Absent — a host that passes none — means the tier does not run, the same
   * reading a refused allow-list gets; see `scriptsOf`.
   */
  readonly #presetRegex: (() => Promise<PresetRegexTier | undefined>) | undefined
  /**
   * Where the pre-change copies live.
   *
   * Always present: a store without a snapshot directory would make the
   * dangerous-operation protections a matter of which caller remembered to
   * pass one. The parameter stays so a composition can share one store — and
   * its retention setting — between this store and the service's handlers.
   */
  readonly #backups: BackupStore

  /**
   * @param dir - the folder holding chat files.
   * @param library - where the cards live, for reopening a chat's character.
   * @param scriptVariables - where the `script` scope persists. Absent keeps it
   *   in memory, which is what a host with nowhere to store it should do.
   * @param backups - the snapshot store. Absent builds one on this store's own
   *   directory with the default retention.
   */
  constructor(
    dir: string,
    library: CharacterLibrary,
    scriptVariables?: ScriptVariableStore,
    globalScope?: ScopeBackend,
    worldbooks?: WorldbookStore,
    globalSelect?: () => readonly string[],
    bookFor?: (characterId: string | undefined, card: CharacterCard | undefined) => Promise<string | undefined>,
    persona?: () => string,
    globalRegex?: () => Promise<readonly RegexScript[]>,
    charBooks?: (characterId: string) => readonly string[],
    backups?: BackupStore,
    scopedRegex?: (characterId: string) => Promise<ScopedRegexPolicy>,
    presetRegex?: () => Promise<PresetRegexTier | undefined>,
  ) {
    this.#dir = dir
    this.#library = library
    this.#scriptVariables = scriptVariables
    this.#globalScope = globalScope
    this.#worldbooks = worldbooks
    this.#bookFor = bookFor
    this.#globalSelect = globalSelect
    this.#persona = persona
    this.#globalRegex = globalRegex
    this.#charBooks = charBooks
    this.#backups = backups ?? new BackupStore(dir)
    this.#scopedRegex = scopedRegex
    this.#presetRegex = presetRegex
  }

  /**
   * The `script` scope backend for one card.
   *
   * Keyed by the character rather than by the chat: two conversations with the
   * same card share one script table, because upstream keeps it on the card and
   * a script that forgot its state on every new chat would be a different thing.
   * @param characterId - whose partition, absent for a chat with no card.
   * @param card - the card, for the defaults its author shipped.
   * @returns the backend, or undefined to leave it in memory.
   */
  async #scriptScope(characterId: string | undefined, card: CharacterCard | undefined): Promise<ScopeBackend | undefined> {
    const store = this.#scriptVariables
    if (store === undefined || characterId === undefined) return undefined
    return store.backendFor(await store.open(characterId, card))
  }

  /** The global regex tier as it stands right now; absent when there is no store. */
  async #globals(): Promise<readonly RegexScript[]> {
    return await this.#globalRegex?.() ?? []
  }

  /**
   * The user's decisions about one card's regex tier, right now.
   *
   * A chat with no card has no scoped tier to decide about, and a host with no
   * policy store has recorded no decision — both answer "allowed, nothing
   * overridden", which is what {@link scriptsOf} does with an absent policy and
   * is the behaviour this host had before the switch existed.
   * @param characterId - the chat's character, if it has one.
   * @returns the policy to compose under.
   */
  async #scoped(characterId: string | undefined): Promise<ScopedRegexPolicy> {
    if (characterId === undefined || this.#scopedRegex === undefined) {
      return { allowed: true, enabled: {} }
    }
    return this.#scopedRegex(characterId)
  }

  /**
   * The active preset's own regex tier, right now.
   *
   * A host that wired no source has no preset tier to run, which composes
   * exactly as a refused one does — the *opposite* default from `#scoped`
   * above, and the asymmetry is the ruling in §53, not an oversight: a card's
   * rules run until refused, a preset's wait to be allowed.
   * @returns the tier, or undefined when none runs.
   */
  async #preset(): Promise<PresetRegexTier | undefined> {
    return this.#presetRegex?.()
  }

  /** Create the folder if this is a first run. */
  async ensure(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
  }

  /** The ids of every stored conversation. */
  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.#dir))
        .filter(name => name.endsWith('.jsonl'))
        .map(name => name.slice(0, -'.jsonl'.length))
    } catch {
      return []
    }
  }

  /**
   * The sidebar list.
   *
   * A file that cannot be parsed is skipped rather than failing the listing: one
   * corrupt chat must not make every other conversation unreachable.
   * @returns summaries, newest activity first.
   */
  async list(): Promise<ChatSummary[]> {
    const rows: ImportedRow[] = []
    for (const chatId of await this.ids()) {
      const live = this.#entries.get(chatId)
      if (live !== undefined) {
        rows.push({ summary: live.toSummary(), mainChat: mainChatOf(live.header) })
        continue
      }
      const row = await this.#summarize(chatId)
      if (row !== undefined) rows.push(row)
    }
    return linkImportedParents(rows).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** A cached conversation, without touching the disk. */
  cached(chatId: string): ChatEntry | undefined {
    return this.#entries.get(chatId)
  }

  /**
   * Search every stored conversation's floor text.
   *
   * **A linear scan of the chat files, no index.** The files are the truth —
   * every write goes through `save` — so the answer they give directly is the
   * answer an index would need invalidation on every write to maintain, and
   * the corpus's largest conversation (677 floors, 19 MiB) reads and searches
   * in a fraction of the one-second line this has to meet. Each line is
   * case-folded and substring-checked **before** it is parsed; only a line the
   * cheap check flagged pays for a `JSON.parse`, and only a hit that survives
   * into a floor's `mes` is reported — a match against the line's other keys
   * (a speaker's name, a date, a variable table) is not a hit.
   *
   * Open conversations are read from disk like the rest, not from their live
   * entries: the two can differ only inside a card's uncommitted replay batch,
   * and a search that sees the committed conversation is the honest answer.
   * @param query - the fragment to find. Blank after trimming is refused.
   * @param options - case sensitivity (default false) and the per-chat cap on
   *   reported matches (default {@link DEFAULT_SEARCH_MATCH_LIMIT}).
   * @returns chats with at least one matching floor, newest activity first.
   *   A file that cannot be read or parsed is skipped, exactly as `list` does.
   * @throws {AppError} `invalid-request` when the query is empty.
   */
  async search(
    query: string,
    options?: { caseSensitive?: boolean, limit?: number },
  ): Promise<ChatSearchHit[]> {
    const needle = query.trim()
    if (needle.length === 0) throw invalid('the search query is empty')
    const caseSensitive = options?.caseSensitive ?? false
    const limit = options?.limit ?? DEFAULT_SEARCH_MATCH_LIMIT
    // One fold of the needle, not one per line.
    const folded = caseSensitive ? needle : needle.toLowerCase()

    const hits: ChatSearchHit[] = []
    for (const chatId of await this.ids()) {
      let text: string
      try {
        text = await readFile(fileFor(this.#dir, chatId, '.jsonl'), 'utf8')
      } catch {
        continue
      }
      const hit = searchChatText(chatId, text, folded, { caseSensitive, limit })
      if (hit !== undefined) hits.push(hit)
    }
    // The sidebar list's order, so a search reads as the list, filtered.
    return hits.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * What every conversation in the profile has cost, cut by time and by model.
   *
   * {@link search}'s scan, with {@link search}'s reasoning: the files are the
   * truth, one linear pass answers directly what an index would need
   * invalidation on every write to maintain, and each line is substring-checked
   * before it is parsed so a 19 MiB conversation with a handful of billed
   * floors pays for a handful of `JSON.parse` calls. Read from disk rather than
   * from the live entries for the same reason too — the committed conversation
   * is the honest answer, and a card's uncommitted replay batch is not a bill.
   *
   * **The one place it differs from `search`: an unreadable file is counted.**
   * `list` and `search` skip a corrupt chat silently, which is right for them —
   * one broken file must not make every other conversation unreachable, and a
   * search that misses it is missing one result. A *summary* is a claim about a
   * total, so a total computed over an unknown fraction of the corpus is not
   * one; the count of skipped files rides in the reply and the interface says so.
   * @param options - range and granularity.
   * @returns the aggregate, and nothing else.
   */
  async usageSummary(options: UsageSummaryOptions = {}): Promise<UsageSummary> {
    const chats: ChatUsage[] = []
    let scanned = 0
    let skipped = 0
    for (const chatId of await this.ids()) {
      let text: string
      try {
        text = await readFile(fileFor(this.#dir, chatId, '.jsonl'), 'utf8')
      } catch {
        skipped += 1
        continue
      }
      const usage = readChatUsage(chatId, text)
      if (usage === undefined) {
        skipped += 1
        continue
      }
      scanned += 1
      // A conversation that never reported a cost is scanned and then dropped:
      // it is a real part of the denominator `scannedChats` reports, and a row
      // of zeros on the subtotal list beside it would read as "this chat cost
      // nothing" rather than "nothing was ever recorded for this chat".
      if (usage.records.length > 0) chats.push(usage)
    }
    return summariseUsage(chats, options, scanned, skipped)
  }

  /**
   * Re-read all three regex tiers and hand them to every live conversation.
   *
   * Called after any regex edit **and after a preset switch**: the stores'
   * state is what the next open would compose from, but a chat left open across
   * the change is still running on the snapshot it took, and SillyTavern's
   * answer to that is `reloadCurrentChat()` — the reader sees the new text, not
   * the text the old rules produced.
   *
   * **Every tier, one method.** It refreshed only the global list until the
   * card's tier gained a switch, and only those two until the preset's arrived;
   * a method named for one tier that a caller reached for after editing another
   * is the shape where the second edit silently does not land until the chat is
   * reopened. There is no `#globalRegex === undefined` short circuit for the
   * same reason: a host with no global store can still have scoped decisions,
   * or a preset switch, to apply.
   * @returns the ids of the live conversations that were refreshed.
   */
  async refreshRegex(): Promise<string[]> {
    const scripts = await this.#globals()
    const preset = await this.#preset()
    const ids: string[] = []
    for (const [chatId, entry] of this.#entries) {
      entry.setRegex(scripts, await this.#scoped(entry.meta.characterId), preset)
      ids.push(chatId)
    }
    return ids
  }

  // —— family②: regex ——
  /**
   * Re-read one character's card into every conversation already open on it.
   *
   * **Not folded into {@link refreshRegex}, deliberately.** Two of the three
   * tiers' inputs are host records and cheap to re-read; the card tier's input
   * is the card *file*, and `CharacterLibrary.load` decodes it whole (a median
   * of 494 KiB across the local corpus, up to 2.8 MiB, and nothing caches it).
   * Re-reading it on every global-regex toggle would make a settings switch pay
   * for every open conversation's card, so the reload stays on the one path
   * that changes a card: `regex.tavernReplace`'s character tier.
   *
   * A card that has since been deleted leaves the entry's copy alone rather
   * than clearing it — the conversation is still playing whatever it opened
   * with, which is the honest state, and clearing it would take the greetings
   * and the prompt fields with it.
   * @param characterId - whose card was rewritten.
   */
  async refreshCard(characterId: string): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.meta.characterId !== characterId) continue
      try {
        entry.card = await this.#library.load(characterId)
      } catch {
        continue
      }
    }
  }

  /**
   * Open a conversation, loading it if it is not already live.
   * @param chatId - the id from the request.
   * @returns the live entry.
   * @throws {AppError} `not-found` when no such chat is stored.
   */
  async open(chatId: string): Promise<ChatEntry> {
    const cached = this.#entries.get(chatId)
    if (cached !== undefined) return cached

    const path = fileFor(this.#dir, chatId, '.jsonl')
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw notFound(`no chat "${chatId}"`)
    }

    const file = parseChatFile(text)
    const meta = readMeta(file.header)
    const card = meta.characterId === undefined
      ? undefined
      : await this.#library.load(meta.characterId).catch(() => undefined)

    const session = importChat(file, chatId)
    const scriptScope = await this.#scriptScope(meta.characterId, card)
    // Absent stays absent rather than being passed as an explicit `undefined`:
    // `exactOptionalPropertyTypes` is on, and the entry's own default for the
    // preset tier is "nothing runs", so the two spellings would have to agree
    // anyway.
    const presetRegex = await this.#preset()
    const entry = new ChatEntry({
      chatId, header: file.header, session, card,
      globalScripts: await this.#globals(),
      scopedRegex: await this.#scoped(meta.characterId),
      ...presetRegex === undefined ? {} : { presetRegex },
      worldbook: await resolveCardWorldbook(
        card, this.#worldbooks, this.#globalSelect?.() ?? [],
        await this.#bookFor?.(meta.characterId, card),
        meta.characterId === undefined ? [] : this.#charBooks?.(meta.characterId) ?? [],
      ),
      ...scriptScope === undefined ? {} : { scriptScope },
      ...this.#globalScope === undefined ? {} : { globalScope: this.#globalScope },
      ...this.#persona === undefined ? {} : { persona: this.#persona },
    })
    // The log carries the conversation; the variables ride alongside it and
    // have to be put back explicitly. So does what each generation cost — the
    // provider said it once and the file is the only place it survives.
    entry.hydrateVariables(file.messages)
    entry.hydrateUsage(file.messages)
    // And how long each one took, which unlike the cost is something upstream
    // records too — in `gen_started` / `gen_finished` — so this one reads a
    // SillyTavern chat as well as an Iris one (`./timing.ts`).
    entry.hydrateTiming(file.messages)
    this.#entries.set(chatId, entry)
    return entry
  }

  /**
   * Start a conversation with a character.
   *
   * The greeting becomes turn 0 with the alternate greetings as its swipes,
   * which is exactly SillyTavern's arrangement — so a user can swipe the
   * opening line before saying anything, and an exported chat looks native.
   * @param characterId - the card to play.
   * @param userName - the name to record for the user.
   * @returns the new conversation.
   * @throws {AppError} `not-found` when there is no such character.
   */
  async create(characterId: string, userName: string): Promise<ChatEntry> {
    const card = await this.#library.load(characterId)
    const name = card.data.name.length > 0 ? card.data.name : characterId

    await this.ensure()
    const taken = new Set(await this.ids())
    const now = new Date()
    const chatId = uniqueId(`${toId(name)}-${stamp(now)}`, id => taken.has(id))

    const header: SillyTavernChatHeader = {
      user_name: userName,
      character_name: name,
      create_date: formatCreateDate(now),
      chat_metadata: {},
      iris: { chatId, characterId, title: name, updatedAt: now.getTime() },
    }

    const session = createSession(chatId)
    const scriptScope = await this.#scriptScope(characterId, card)
    const presetRegex = await this.#preset()
    const entry = new ChatEntry({
      chatId, header, session, card,
      globalScripts: await this.#globals(),
      scopedRegex: await this.#scoped(characterId),
      ...presetRegex === undefined ? {} : { presetRegex },
      worldbook: await resolveCardWorldbook(
        card, this.#worldbooks, this.#globalSelect?.() ?? [],
        await this.#bookFor?.(characterId, card),
        this.#charBooks?.(characterId) ?? [],
      ),
      ...scriptScope === undefined ? {} : { scriptScope },
      ...this.#globalScope === undefined ? {} : { globalScope: this.#globalScope },
      ...this.#persona === undefined ? {} : { persona: this.#persona },
    })
    seedGreeting(entry, card, { user: userName, char: name })
    seedInitialVariables(entry)

    this.#entries.set(chatId, entry)
    await this.save(entry)
    return entry
  }

  /**
   * Branch a conversation at a message, into a new one.
   *
   * The cut is INCLUSIVE and made on the chat-file projection, which is both
   * what upstream does (`chat.slice(0, mesId + 1)` in `bookmarks.js`) and what
   * this codebase already does for editing and deleting. It is deliberately NOT
   * `dsh-session`'s `fork()`: that lives on `SessionStore` and rejects anything
   * but a live store session, while these are detached — and its lineage is
   * carried in a `SessionHeader` this project never persists, since the durable
   * form here is SillyTavern's chat file.
   * @param chatId - the conversation to branch.
   * @param id - the last message the branch keeps.
   * @param swipeId - branch from this alternate generation instead of the shown one.
   * @returns the new conversation, already open.
   * @throws {AppError} `not-found` for an unknown chat, `invalid-request` for a
   *   message or swipe index that is not there.
   */
  async branch(chatId: string, id: number, swipeId?: number): Promise<ChatEntry> {
    const parent = await this.open(chatId)
    const { messages } = parent.toFile()
    const at = messages[id]
    if (at === undefined) throw invalid(`this chat has no message ${String(id)}`)

    // Cloned before anything is changed, exactly as upstream does
    // (`structuredClone(chat.slice(...))`). Selecting a swipe edits the branch
    // point, and doing that on the shared array would move the PARENT onto the
    // generation the user chose for the branch — the branch would work and the
    // conversation it came from would silently change underneath.
    const lines = structuredClone(messages.slice(0, id + 1))

    if (swipeId !== undefined) {
      const swipes = at.swipes ?? []
      const chosen = swipes[swipeId]
      if (chosen === undefined) {
        throw invalid(`message ${String(id)} has ${String(swipes.length)} swipes; no index ${String(swipeId)}`)
      }
      // Upstream syncs the chosen swipe into `mes` before slicing, so the branch
      // opens on the generation the user picked rather than the one on screen.
      const branchPoint = lines[id]
      if (branchPoint !== undefined) {
        branchPoint.mes = chosen
        branchPoint.swipe_id = swipeId
      }
    }

    const parentMeta = parent.meta
    await this.ensure()
    const taken = new Set(await this.ids())
    const titles = new Set((await this.list()).map(summary => summary.title))
    const title = branchTitle(parentMeta.title, existing => titles.has(existing))
    const now = new Date()
    const childId = uniqueId(`${toId(title)}-${stamp(now)}`, candidate => taken.has(candidate))

    const header: SillyTavernChatHeader = {
      ...parent.header,
      create_date: formatCreateDate(now),
      chat_metadata: {
        ...structuredClone(parent.header.chat_metadata),
        // Upstream's own lineage field, kept for interoperability: a branch
        // exported to SillyTavern still knows where it came from.
        main_chat: parentMeta.title,
      },
      iris: {
        chatId: childId,
        ...parentMeta.characterId === undefined ? {} : { characterId: parentMeta.characterId },
        title,
        updatedAt: now.getTime(),
        parentChatId: chatId,
      },
    }

    const session = importChat({ header, messages: lines }, childId)
    // The branch shares its parent's card, so it shares the parent's script
    // tables too — branching a conversation does not fork a script's state, any
    // more than starting a second chat with the same character does.
    const scriptScope = await this.#scriptScope(parentMeta.characterId, parent.card)
    // Re-read rather than inherited from the parent, unlike the world book one
    // line down: the book is a property of the character and a second
    // resolution could disagree with the parent's, while the preset tier is a
    // property of *now* — the branch runs whatever preset is active, which is
    // also what the parent would compose on its next refresh.
    const presetRegex = await this.#preset()
    const child = new ChatEntry({
      chatId: childId, header, session, card: parent.card,
      globalScripts: await this.#globals(),
      scopedRegex: await this.#scoped(parentMeta.characterId),
      ...presetRegex === undefined ? {} : { presetRegex },
      // Reused rather than re-resolved: a branch plays the same character from
      // the same books, and a second resolution could disagree with its parent
      // if a book changed on disk in between.
      ...parent.worldbook === undefined ? {} : { worldbook: parent.worldbook },
      ...scriptScope === undefined ? {} : { scriptScope },
      ...this.#globalScope === undefined ? {} : { globalScope: this.#globalScope },
      ...this.#persona === undefined ? {} : { persona: this.#persona },
    })
    child.hydrateVariables(lines)
    // A branch inherits the history it was cut from, and that history was paid
    // for once. The parent keeps its own copy; the two are separate
    // conversations from here, so the same figures appear in both totals — the
    // alternative is a branch whose early turns look free.
    child.hydrateUsage(lines)
    // The same argument, one measurement over: the inherited history was
    // generated once and took the time it took, and a branch whose early turns
    // showed no speed would look like a chat played on a different host.
    child.hydrateTiming(lines)

    this.#entries.set(childId, child)
    await this.save(child)

    // Upstream records the child on the message it was branched from, so the
    // parent can show where its branches leave. Same field, same shape.
    const branches = Array.isArray(at.extra?.['branches']) ? at.extra['branches'] as unknown[] : []
    at.extra = { ...at.extra, branches: [...branches, title] }
    parent.rebuild(messages, index => index)
    parent.touch()
    await this.save(parent)

    return child
  }

  /**
   * Copy a SillyTavern chat file into this profile, as `/api/chats/import` does.
   *
   * The whole file is read and checked **before anything is written**, so a
   * refusal never leaves a half-imported conversation behind: the parse and the
   * shape check both name what they found instead of what they expected. The
   * original filename survives as the chat's id whenever it can — a branch's
   * `chat_metadata.main_chat` names the parent's file stem, so keeping stems is
   * what keeps imported families linked once they are here (and `list` does
   * that linking from the field itself, so import order never matters).
   *
   * What Iris adds goes in the header's own `iris` block, exactly as `create`
   * does; every SillyTavern field, `main_chat` included, is kept verbatim so an
   * export can put the file back.
   * @param filename - the file's name, whose stem becomes the chat id when safe.
   * @param base64 - the file's bytes.
   * @param characterId - the character this conversation is played with.
   * @returns the new conversation's summary.
   * @throws {AppError} `not-found` for an unknown character, `invalid-request`
   *   with a named reason for anything that is not a SillyTavern chat file.
   */
  async importFile(filename: string, base64: string, characterId: string): Promise<ChatSummary> {
    // The owner is resolved first: a chat recorded against a card that is not
    // in the library would open with the wrong books or none, and the user
    // asked for this one by name.
    await this.#library.ref(characterId)

    const chat = parseImportedChat(filename, base64)
    await this.ensure()

    const stem = filename.replace(/\.jsonl$/iu, '')
    // A stem the filesystem cannot hold (a `:` in it, say) still imports under
    // a flattened id: the conversation matters more than its name, and the
    // branch links survive because titles match on the stem either way.
    const base = isSafeId(stem) ? stem : toId(stem)
    const taken = new Set(await this.ids())
    const chatId = uniqueId(base, candidate => taken.has(candidate))

    // A file this host exported comes back carrying its own `iris` block. The
    // conversation's identity is re-minted here — chat ids belong to this
    // store — and a carried `parentChatId` is deliberately dropped, because a
    // stale id from another store must never link a chat it does not name:
    // lineage re-derives from `chat_metadata.main_chat`, which is always
    // verbatim. But the title the user saw and when the conversation was last
    // active are facts about the conversation, so they survive the round trip
    // instead of resetting to the file stem and the arrival time.
    const carried = chat.header['iris'] !== undefined
    const prior = readMeta(chat.header)
    const updatedAt = carried && prior.updatedAt !== 0
      ? prior.updatedAt
      : parseCreateDate(typeof chat.header.create_date === 'string' ? chat.header.create_date : '') ?? Date.now()
    const title = carried && prior.title.length > 0 ? prior.title : stem

    chat.header['iris'] = {
      chatId,
      characterId,
      title,
      updatedAt,
    }

    const target = fileFor(this.#dir, chatId, '.jsonl')
    // **Import overwrite is the one dangerous operation that cannot happen
    // today** — `uniqueId` above mints a fresh id whenever the stem is taken —
    // and the guard is here anyway, because the mechanism's promise is about
    // the operation, not about today's id arithmetic: if minting ever changes,
    // the conversation that was there is copied aside first, not lost.
    if (existsSync(target)) {
      await this.#backups.snapshot(chatId, 'import-overwrite', characterId)
    }
    await writeFile(target, formatChatFile(chat), 'utf8')
    return {
      chatId,
      title,
      characterId,
      updatedAt,
      messageCount: chat.messages.length,
    }
  }

  /**
   * One conversation as SillyTavern's own JSONL, for `/api/chats/export`'s half
   * of the migration.
   *
   * Through `toFile`, not a second writer: the projection every save already
   * uses, with the carried-through fields and the original key order that the
   * round-trip tests hold. The header keeps its `iris` block — SillyTavern
   * ignores unknown header keys, and stripping it here would be a third answer
   * to "what does this chat look like on disk".
   * @param chatId - the conversation to take out.
   * @returns the text and the file name to save it as — the chat's id, which is
   *   the name a branch's `main_chat` addresses its parent by.
   * @throws {AppError} `not-found` when no such chat is stored.
   */
  async exportFile(chatId: string): Promise<{ filename: string, content: string }> {
    const entry = await this.open(chatId)
    return {
      filename: `${chatId}.jsonl`,
      content: formatChatFile(entry.toFile()),
    }
  }

  // —— family①: identity & messages ——
  /**
   * One conversation's floors, read from its file and nothing else.
   *
   * **Not `open`, deliberately.** `open` is a stateful call — it materialises
   * the entry, composes the card's regex scopes and can raise a cleanup
   * offer — and this is a *read of somebody else's* conversation on behalf of a
   * card asking `getChatHistoryDetail`. Opening forty files to answer one
   * question would put forty entries in the cache and forty cleanup decisions
   * in front of the reader. {@link search} and {@link usageSummary} read the
   * files for the same reason, and this is their scan with their reasoning.
   *
   * The header line is dropped, which is also what upstream's own reader does
   * (`RawCharacter.getChatsFromFiles` calls `currentChat.shift()` for every
   * non-group chat, `function/raw_character.ts:120-122`) — the first line of a
   * SillyTavern chat file is metadata, not a floor.
   *
   * The **file**, so the open conversation's unsaved edits are not in the
   * answer. Upstream has the same split — its detail fetch goes to
   * `/api/chats/get` while the page holds a live `chat` array — and a card
   * reading its *own* conversation has `getChatMessages` for the live one.
   * @param chatId - the conversation to read.
   * @returns its floors, or undefined when the file cannot be read or parsed.
   */
  async floorsOf(chatId: string): Promise<SillyTavernMessage[] | undefined> {
    let text: string
    try {
      text = await readFile(fileFor(this.#dir, chatId, '.jsonl'), 'utf8')
    } catch {
      return undefined
    }
    try {
      return parseChatFile(text).messages
    } catch {
      return undefined
    }
  }

  /**
   * Write a conversation to disk.
   * @param entry - the live conversation.
   */
  async save(entry: ChatEntry, onReport?: (message: string) => void): Promise<void> {
    await this.ensure()
    const path = fileFor(this.#dir, entry.chatId, '.jsonl')
    await writeFile(path, formatChatFile(entry.toFile(onReport)), 'utf8')
  }

  /**
   * Copy a conversation aside before something irreversible happens to it.
   *
   * **A file under the profile, not a download.** Upstream offers its backup
   * through `/api/chats/export`, which hands the user a file and then forgets
   * it; the point here is that the sweep is survivable, and a copy the host can
   * still find is what makes it so. A download that the browser refused, or that
   * went to a folder nobody remembers, is a backup only in the moment it was
   * offered.
   *
   * Through the snapshot store, so the copy lands where every other pre-change
   * copy lands — `backups/<character>/<chat>/`, named with when and why — and
   * the backup card lists it beside the rest instead of the store growing a
   * second, invisible layout. Retention applies to it like to the rest.
   * @param chatId - the conversation to copy.
   * @returns the path written.
   * @throws {AppError} `not-found` when no such chat is stored.
   */
  async backup(chatId: string): Promise<string> {
    const entry = await this.open(chatId)
    const saved = await this.#backups.snapshot(chatId, 'cleanup', entry.meta.characterId)
    return this.#backups.locate(saved.backupId)
  }

  /**
   * Write an exact stored text back as a conversation's file.
   *
   * The restore arm's write half, and deliberately the only way in: the bytes
   * go back **verbatim** — the whole point of a snapshot is that the
   * conversation comes back as it went into the copy, floor for floor, not
   * re-projected through today's writer. A live entry is dropped first, so the
   * next open re-reads the disk instead of answering from the version the
   * restore just replaced.
   * @param chatId - the conversation to write.
   * @param text - the snapshot's whole text.
   */
  async restoreFile(chatId: string, text: string): Promise<void> {
    this.#entries.delete(chatId)
    await this.ensure()
    await writeFile(fileFor(this.#dir, chatId, '.jsonl'), text, 'utf8')
  }

  /**
   * Delete a conversation.
   * @param chatId - the id from the request.
   * @throws {AppError} `not-found` when no such chat is stored.
   */
  async delete(chatId: string): Promise<void> {
    const path = fileFor(this.#dir, chatId, '.jsonl')
    try {
      await unlink(path)
    } catch {
      throw notFound(`no chat "${chatId}"`)
    }
    this.#entries.delete(chatId)
  }

  /** Read one chat's header without materializing its log. */
  async #summarize(chatId: string): Promise<ImportedRow | undefined> {
    let text: string
    try {
      text = await readFile(fileFor(this.#dir, chatId, '.jsonl'), 'utf8')
    } catch {
      return undefined
    }
    try {
      const lines = text.split('\n').filter(line => line.trim().length > 0)
      const header = JSON.parse(lines[0] ?? '{}') as SillyTavernChatHeader
      const meta = readMeta(header)
      return {
        summary: {
          chatId,
          title: meta.title,
          ...meta.characterId === undefined ? {} : { characterId: meta.characterId },
          ...meta.parentChatId === undefined ? {} : { parentChatId: meta.parentChatId },
          updatedAt: meta.updatedAt,
          messageCount: Math.max(0, lines.length - 1),
        },
        mainChat: mainChatOf(header),
      }
    } catch {
      return undefined
    }
  }
}

/**
 * Put the card's greeting on the log as turn 0.
 * @param entry - the new conversation.
 * @param card - the character being played.
 * @param names - what `{{char}}` and `{{user}}` expand to.
 */
/**
 * Write the card's declared starting state onto the greeting.
 *
 * A new chat's message 0 carries the `[InitVar]` tree, because that is what
 * SillyTavern's own files do: measured over the 31 real chats on this machine,
 * **21 carry `stat_data` on message 0**, and Tavern Helper's
 * `waitGlobalInitialized('Mvu')` polls for exactly that
 * (`JS-Slash-Runner/src/function/global.ts:35` — `_.has(getVariables({type:
 * 'message', message_id: 0}), 'stat_data')`). Without it a card's scripts stall
 * for the full wait window on every fresh chat.
 *
 * **New chats only.** Existing files keep whatever they hold; back-filling would
 * be editing the user's data to satisfy a format nobody asked us to change, and
 * `baselineFor` already falls back to `initVars()`, so an unseeded file behaves
 * exactly as it does today. The two generations of file coexist.
 *
 * Nothing is written when the card declares no starting state: a chat with an
 * empty tree would gain a `variables` array saying nothing, and the one corpus
 * file whose card has no MVU has no `variables` key at all.
 * @param entry - the new conversation, with its greeting already seeded.
 */
export function seedInitialVariables(entry: ChatEntry): void {
  const initial = entry.initVars()
  if (Object.keys(initial.stat_data).length === 0) return
  try {
    entry.variables.replaceVariables(initial as unknown as Variables, { type: 'message', message_id: 0 })
  } catch {
    // A card with no greeting has no turn 0 to attach state to. That is a card
    // with nothing to show before the first reply, and the fallback in
    // `baselineFor` covers it.
  }
}

export function seedGreeting(
  entry: ChatEntry,
  card: CharacterCard,
  names: { user: string, char: string },
): void {
  const macros = createMacroContext({ char: names.char, user: names.user })
  const greetings = [card.data.first_mes, ...card.data.alternate_greetings]
    .map(text => expandMacros(text, macros))
    .filter(text => text.trim().length > 0)
  if (greetings.length === 0) return

  const session = entry.session
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  for (const text of greetings) {
    appendCandidate(session, {
      turn: 0,
      step: 0,
      message: createAssistantMessage({ content: [{ type: 'text', text }], source: GREETING_SOURCE }),
    })
  }
  // `appendCandidate` leaves the last one showing; upstream shows `first_mes`.
  if (greetings.length > 1) selectCandidate(session, 0, 0)
  session.append('step/end', { turn: 0, step: 0 })
  session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
}

/**
 * SillyTavern's own lineage field, when the file carries one.
 * @param header - the chat header.
 * @returns the parent's chat name, or undefined.
 */
export function mainChatOf(header: SillyTavernChatHeader): string | undefined {
  const value = header.chat_metadata['main_chat']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Resolve the parent of a branch that came from SillyTavern rather than Iris.
 *
 * A chat Iris created records `iris.parentChatId` — an id, so renaming the
 * parent cannot break the link. A chat imported from SillyTavern has no `iris`
 * block at all; its only lineage is `chat_metadata.main_chat`, which is the
 * parent's chat *name*. Without this the imported branch reports no parent, and
 * the relationship the user actually has on disk is invisible.
 *
 * Matched against the chat id first (the file stem, which is what a SillyTavern
 * chat name becomes when the file is dropped in) and then the title. An
 * unresolvable name is left alone rather than guessed at: a wrong parent is
 * worse than none.
 * @param summaries - every conversation, with whatever lineage it declared.
 * @returns the same list, with imported branches linked where they resolve.
 */
export function linkImportedParents(rows: readonly ImportedRow[]): ChatSummary[] {
  const byId = new Set(rows.map(row => row.summary.chatId))
  const byTitle = new Map(rows.map(row => [row.summary.title, row.summary.chatId]))

  return rows.map(({ summary, mainChat }) => {
    if (summary.parentChatId !== undefined) return summary
    if (mainChat === undefined) return summary
    const resolved = byId.has(mainChat) ? mainChat : byTitle.get(mainChat)
    if (resolved === undefined || resolved === summary.chatId) return summary
    return { ...summary, parentChatId: resolved }
  })
}

/** One conversation's summary plus the upstream lineage field it declared. */
export interface ImportedRow {
  summary: ChatSummary
  /** `chat_metadata.main_chat`, the parent's chat *name*, when the file has one. */
  mainChat?: string | undefined
}

/**
 * Strip any branch suffix a name already carries.
 *
 * Upstream removes both spellings before adding its own, so branching a branch
 * gives `Aria - Branch #2` rather than `Aria - Branch #1 - Branch #2`. Verified
 * against `bookmarks.js`, which strips the modern suffix and a legacy prefix.
 * @param name - the parent conversation's title.
 * @returns the title without a branch marker.
 */
export function stripBranchSuffix(name: string): string {
  return name.replace(/ - Branch #\d+$/u, '').replace(/^Branch #\d+ - /u, '')
}

/**
 * The next free branch title for a parent.
 * @param parentTitle - the conversation being branched.
 * @param taken - reports whether a title is already used.
 * @returns e.g. `Aria - Branch #1`.
 */
export function branchTitle(parentTitle: string, taken: (title: string) => boolean): string {
  const base = stripBranchSuffix(parentTitle)
  for (let index = 1; ; index += 1) {
    const candidate = `${base} - Branch #${String(index)}`
    if (!taken(candidate)) return candidate
  }
}

/** Matches reported per chat when the caller did not ask for a cap. */
export const DEFAULT_SEARCH_MATCH_LIMIT = 5

/** Snippet: floors of context shown before the match, and after its end. */
const SNIPPET_BEFORE = 48
const SNIPPET_AFTER = 96

/**
 * Scan one chat file's text for floors containing the needle.
 *
 * The needle arrives already case-folded when the search is insensitive, and
 * each line is folded with it, so a 19 MiB file costs one substring pass and
 * `JSON.parse` only on the handful of lines the pass flags. A flagged line
 * still has to prove the match lives in its floor text — `mes` — because the
 * line is JSON and everything it carries (the speaker's name, `send_date`, a
 * floor's variable table) otherwise counts as content, which it is not.
 * @param chatId - the file's stem, which is the conversation's id.
 * @param text - the whole file.
 * @param needle - the (already folded) fragment to find.
 * @param caseSensitive - whether the needle is literal.
 * @param limit - the most matches to report.
 * @returns the hit, or undefined when no floor matches.
 */
export function searchChatText(
  chatId: string,
  text: string,
  needle: string,
  options: { caseSensitive: boolean, limit: number },
): ChatSearchHit | undefined {
  const { caseSensitive, limit } = options
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length < 2) return undefined

  let header: SillyTavernChatHeader
  try {
    header = JSON.parse(lines[0] ?? '{}') as SillyTavernChatHeader
  } catch {
    return undefined
  }
  const meta = readMeta(header)

  const matches: ChatSearchMatch[] = []
  for (let index = 1; index < lines.length; index += 1) {
    if (matches.length >= limit) break
    const line = lines[index] ?? ''
    const folded = caseSensitive ? line : line.toLowerCase()
    if (folded.includes(needle) === false) continue

    let floor: SillyTavernMessage
    try {
      floor = JSON.parse(line) as SillyTavernMessage
    } catch {
      continue
    }
    // Upstream's own search skips system floors; so does this. A hidden
    // narrator line is storage, not something a reader is looking for.
    if (floor.is_system === true) continue
    const mes = typeof floor.mes === 'string' ? floor.mes : ''
    const at = caseSensitive ? mes.indexOf(needle) : mes.toLowerCase().indexOf(needle)
    if (at < 0) continue
    matches.push({
      messageId: index - 1,
      name: floor.name,
      isUser: floor.is_user === true,
      snippet: clipSnippet(mes, at),
    })
  }

  if (matches.length === 0) return undefined
  return {
    chatId,
    title: meta.title,
    ...meta.characterId === undefined ? {} : { characterId: meta.characterId },
    updatedAt: meta.updatedAt,
    messageCount: lines.length - 1,
    ...meta.parentChatId === undefined ? {} : { parentChatId: meta.parentChatId },
    matches,
  }
}

/**
 * Text around a match, for a row that shows why it hit.
 * @param text - the floor's whole text.
 * @param at - where the match starts.
 * @returns up to {@link SNIPPET_BEFORE} characters before the match and
 *   {@link SNIPPET_AFTER} from its start, ellipsised only where cut.
 */
export function clipSnippet(text: string, at: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(text.length, at + SNIPPET_AFTER)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/**
 * SillyTavern's `create_date` spelling, read back as a moment.
 *
 * The field is user-facing text upstream, not a timestamp, so this is a parse
 * of the one format every real file carries — measured over the 31 chats on
 * this machine — and not a general date reader. An unparseable or absent value
 * returns `undefined`, which the caller replaces with the arrival time: a chat
 * with no date still has to sort somewhere.
 * @param when - e.g. `2026-01-18 @05h53m21s771ms`.
 * @returns Unix epoch milliseconds, or undefined.
 */
export function parseCreateDate(when: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) @(\d{2})h(\d{2})m(\d{2})s(\d{3})?ms$/u.exec(when.trim())
  if (match === null) return undefined
  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(part => Number(part))
  // Local time, because that is how `formatCreateDate` wrote it: the same field
  // read and written in the same zone, or every round trip would shift it.
  const moment = new Date(
    year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0, ms ?? 0,
  )
  return Number.isNaN(moment.getTime()) ? undefined : moment.getTime()
}

/**
 * Decode an uploaded chat file to text, refusing what is not base64.
 * @param base64 - the payload, as a browser file read produces it.
 * @param filename - the file's name, for the refusal to name.
 * @returns the file's text, byte-order mark stripped.
 * @throws {AppError} `invalid-request` when the payload is not base64.
 */
function decodeChatFile(base64: string, filename: string): string {
  // `Buffer.from` ignores what it cannot read, so the alphabet is checked
  // first: without this, a truncated or mis-encoded upload decodes to silence
  // and then fails as a JSON error pointing somewhere else entirely.
  if (!/^[A-Za-z0-9+/=\s]*$/u.test(base64)) {
    throw invalid(`"${filename}" is not a base64-encoded file`)
  }
  let text: string
  try {
    text = Buffer.from(base64, 'base64').toString('utf8')
  } catch {
    throw invalid(`"${filename}" is not a base64-encoded file`)
  }
  // A mark is metadata a text editor added, not content; JSON.parse would read
  // it as a syntax error on the header's first byte.
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/**
 * Read and check an uploaded chat file, **before anything is written**.
 *
 * Upstream's import ([ST 1.18.0] `src/endpoints/chats.js:696`; `:604` is
 * `/export`) accepts several chat dialects and renames
 * what it takes in; this is deliberately the stricter single-format arm the
 * migration path needs. Every rule below was measured against the 31 real
 * chats on this machine — all of which pass — so what it refuses is a file
 * that is not a SillyTavern chat, never one that is. The refusal names the
 * finding, because "import failed" is how a user ends up debugging the wrong
 * end of the pipe.
 * @param filename - the file's name, for the refusals to name.
 * @param base64 - the file's bytes.
 * @returns the parsed file.
 * @throws {AppError} `invalid-request` naming what the file is missing.
 */
export function parseImportedChat(filename: string, base64: string): SillyTavernChat {
  const text = decodeChatFile(base64, filename)
  let chat: SillyTavernChat
  try {
    chat = parseChatFile(text)
  } catch (cause: unknown) {
    throw invalid(`"${filename}" is not a SillyTavern chat file: ${
      cause instanceof Error ? cause.message : String(cause)}`)
  }

  const header = chat.header as Record<string, unknown>
  for (const key of ['user_name', 'character_name'] as const) {
    if (typeof header[key] !== 'string') {
      throw invalid(`"${filename}" is not a SillyTavern chat file: the header has no "${key}" string`)
    }
  }
  if (typeof header['chat_metadata'] !== 'object' || header['chat_metadata'] === null) {
    throw invalid(`"${filename}" is not a SillyTavern chat file: the header has no "chat_metadata" object`)
  }
  if (header['create_date'] !== undefined && typeof header['create_date'] !== 'string') {
    throw invalid(`"${filename}" is not a SillyTavern chat file: the header's "create_date" is not a string`)
  }

  for (const [index, line] of chat.messages.entries()) {
    const row = line as unknown
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw invalid(`"${filename}" is not a SillyTavern chat file: message ${String(index + 1)} is not an object`)
    }
    const message = row as Record<string, unknown>
    if (typeof message['mes'] !== 'string') {
      throw invalid(`"${filename}" is not a SillyTavern chat file: message ${String(index + 1)} has no "mes" text`)
    }
    if (typeof message['is_user'] !== 'boolean') {
      throw invalid(`"${filename}" is not a SillyTavern chat file: message ${String(index + 1)} has no "is_user" flag`)
    }
  }
  return chat
}
