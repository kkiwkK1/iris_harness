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

import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'

import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { CharacterCard } from '@iris/character'
import { appendCandidate, selectCandidate } from '@iris/chat'
import { createMacroContext, expandMacros } from '@iris/macro'
import {
  formatChatFile,
  parseChatFile,
  importChat,
  type SillyTavernChatHeader,
} from '@iris/persistence'
import type { ChatSummary } from '@iris/protocol'
import type { ScopeBackend, Variables } from '@iris/variables'

import { ChatEntry, createSession, readMeta } from './entry.ts'
import { invalid, notFound } from './errors.ts'
import type { CharacterLibrary } from './library.ts'
import { backupsDir, fileFor, toId, uniqueId } from './paths.ts'
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
   * @param dir - the folder holding chat files.
   * @param library - where the cards live, for reopening a chat's character.
   * @param scriptVariables - where the `script` scope persists. Absent keeps it
   *   in memory, which is what a host with nowhere to store it should do.
   */
  constructor(
    dir: string,
    library: CharacterLibrary,
    scriptVariables?: ScriptVariableStore,
    globalScope?: ScopeBackend,
    worldbooks?: WorldbookStore,
    globalSelect?: () => readonly string[],
    bookFor?: (characterId: string | undefined, card: CharacterCard | undefined) => Promise<string | undefined>,
  ) {
    this.#dir = dir
    this.#library = library
    this.#scriptVariables = scriptVariables
    this.#globalScope = globalScope
    this.#worldbooks = worldbooks
    this.#bookFor = bookFor
    this.#globalSelect = globalSelect
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
    const entry = new ChatEntry({
      chatId, header: file.header, session, card,
      worldbook: await resolveCardWorldbook(
        card, this.#worldbooks, this.#globalSelect?.() ?? [],
        await this.#bookFor?.(meta.characterId, card),
      ),
      ...scriptScope === undefined ? {} : { scriptScope },
      ...this.#globalScope === undefined ? {} : { globalScope: this.#globalScope },
    })
    // The log carries the conversation; the variables ride alongside it and
    // have to be put back explicitly.
    entry.hydrateVariables(file.messages)
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
    const entry = new ChatEntry({
      chatId, header, session, card,
      worldbook: await resolveCardWorldbook(
        card, this.#worldbooks, this.#globalSelect?.() ?? [],
        await this.#bookFor?.(characterId, card),
      ),
      ...scriptScope === undefined ? {} : { scriptScope },
      ...this.#globalScope === undefined ? {} : { globalScope: this.#globalScope },
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
    const child = new ChatEntry({
      chatId: childId, header, session, card: parent.card,
      // Reused rather than re-resolved: a branch plays the same character from
      // the same books, and a second resolution could disagree with its parent
      // if a book changed on disk in between.
      ...parent.worldbook === undefined ? {} : { worldbook: parent.worldbook },
      ...scriptScope === undefined ? {} : { scriptScope },
      ...this.#globalScope === undefined ? {} : { globalScope: this.#globalScope },
    })
    child.hydrateVariables(lines)

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
   * @param chatId - the conversation to copy.
   * @returns the path written.
   * @throws {AppError} `not-found` when no such chat is stored.
   */
  async backup(chatId: string): Promise<string> {
    const source = fileFor(this.#dir, chatId, '.jsonl')
    const dir = backupsDir(this.#dir)
    await mkdir(dir, { recursive: true })
    // The instant is in the name: a second backup must not overwrite the first,
    // and the one being replaced is exactly the one worth keeping.
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
    const target = fileFor(dir, `${chatId}-${stamp}`, '.jsonl')
    try {
      await copyFile(source, target)
    } catch (cause: unknown) {
      throw notFound(`no chat "${chatId}" to back up: ${String(cause)}`)
    }
    return target
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
