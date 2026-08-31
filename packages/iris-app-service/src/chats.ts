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

import { ChatEntry, createSession, readMeta } from './entry.ts'
import { notFound } from './errors.ts'
import type { CharacterLibrary } from './library.ts'
import { fileFor, toId, uniqueId } from './paths.ts'

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
  readonly #entries = new Map<string, ChatEntry>()

  /**
   * @param dir - the folder holding chat files.
   * @param library - where the cards live, for reopening a chat's character.
   */
  constructor(dir: string, library: CharacterLibrary) {
    this.#dir = dir
    this.#library = library
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
    const summaries: ChatSummary[] = []
    for (const chatId of await this.ids()) {
      const live = this.#entries.get(chatId)
      if (live !== undefined) {
        summaries.push(live.toSummary())
        continue
      }
      const summary = await this.#summarize(chatId)
      if (summary !== undefined) summaries.push(summary)
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
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
    const entry = new ChatEntry({ chatId, header: file.header, session, card })
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
    const entry = new ChatEntry({ chatId, header, session, card })
    seedGreeting(entry, card, { user: userName, char: name })

    this.#entries.set(chatId, entry)
    await this.save(entry)
    return entry
  }

  /**
   * Write a conversation to disk.
   * @param entry - the live conversation.
   */
  async save(entry: ChatEntry): Promise<void> {
    await this.ensure()
    const path = fileFor(this.#dir, entry.chatId, '.jsonl')
    await writeFile(path, formatChatFile(entry.toFile()), 'utf8')
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
  async #summarize(chatId: string): Promise<ChatSummary | undefined> {
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
        chatId,
        title: meta.title,
        ...meta.characterId === undefined ? {} : { characterId: meta.characterId },
        updatedAt: meta.updatedAt,
        messageCount: Math.max(0, lines.length - 1),
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
