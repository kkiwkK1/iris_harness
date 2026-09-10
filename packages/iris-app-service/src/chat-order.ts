/**
 * The order the reader put their conversations in.
 *
 * **Upstream has no such thing.** SillyTavern's chat list is sorted by a picker
 * — name or date, ascending or descending — and there is no manual arrangement,
 * no file for one and no key in its settings to keep one under. So this is an
 * Iris feature rather than a compatibility layer, and it is built so a profile
 * that has never used it is byte-identical to one from before it existed: the
 * file is not created until something is arranged, and an absent file means
 * "newest first", which is what the list has always answered.
 *
 * Its own file rather than a section of `settings.json`, on the separation the
 * connections, the personas and the stars already chose: settings are what a
 * chat is *using*, and this is what the reader decided about their own shelf.
 *
 * @module @iris/app-service/chat-order
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ChatSummary } from '@iris/protocol'

/**
 * The arranged sequence of chat ids, or nothing arranged yet.
 *
 * The store holds ids and knows nothing about chats: whether an id still names
 * a conversation is the caller's question, and one answered against the chat
 * directory rather than against this file. That split is deliberate — a store
 * that pruned itself on load would delete the place a chat came back to after
 * a restore.
 */
export class ChatOrderStore {
  readonly #path: string
  #order: string[] = []
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   */
  constructor(path: string) {
    this.#path = path
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        && Array.isArray((parsed as { order?: unknown }).order)) {
        this.#order = dedupe(((parsed as { order: unknown }).order as unknown[])
          .filter((id): id is string => typeof id === 'string'))
      }
    } catch {
      // Absent or unreadable: nothing is arranged, which is the state every
      // profile starts in and a valid state to stay in.
    }
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify({ order: this.#order }, null, 2)}\n`, 'utf8')
  }

  /**
   * The arranged sequence.
   * @returns the ids, in the order they should be listed. Empty means nothing
   *   has been arranged.
   */
  async list(): Promise<string[]> {
    await this.#load()
    return [...this.#order]
  }

  /**
   * Replace the arrangement.
   *
   * Duplicates are collapsed to their first appearance rather than refused: a
   * request the caller assembled by concatenating a list and its branches can
   * repeat an id without meaning two positions for it, and there is exactly one
   * sensible reading of "this id, twice".
   * @param order - every conversation, in the order it should be listed. Empty
   *   clears the arrangement and returns the list to newest-first.
   * @returns the stored sequence.
   */
  async set(order: readonly string[]): Promise<string[]> {
    await this.#load()
    const next = dedupe(order)
    // A write only when something changes: the panel re-sends the order on
    // every drop, including drops that land a row back where it started.
    if (next.length === this.#order.length && next.every((id, at) => id === this.#order[at])) {
      return [...this.#order]
    }
    this.#order = next
    await this.#save()
    return [...this.#order]
  }

  /**
   * Drop one conversation from the arrangement.
   *
   * The `chat.delete` counterpart, and it matters more here than it looks:
   * chat ids are minted against the files that exist, so a deleted chat's id
   * can be handed to the next conversation of that name — and a position left
   * behind would then place a stranger where the deleted one used to sit.
   * @param chatId - the conversation that went away.
   */
  async forget(chatId: string): Promise<void> {
    await this.#load()
    const at = this.#order.indexOf(chatId)
    if (at < 0) return
    this.#order.splice(at, 1)
    await this.#save()
  }
}

/**
 * Read the sidebar list in the arranged order.
 *
 * Two groups, and the rule between them is the whole design:
 *
 *  1. **What the arrangement has never heard of, newest first.** A conversation
 *     created after the last drag is at the top, which is where a conversation
 *     someone just started belongs — and it is also the answer that makes an
 *     empty arrangement a no-op, so a profile that has never dragged anything
 *     reads exactly as it did before this file existed.
 *  2. **What the arrangement names, in its order.** Ids the arrangement names
 *     and the profile no longer has are skipped rather than reported.
 *
 * The other way round — arranged rows on top, new ones beneath — was the first
 * shape and it is wrong: it buries every new conversation under however many
 * rows the reader has ever touched, and the panel writes the *whole* visible
 * order on each drop, so after one drag that would be every row in the profile.
 * @param rows - the summaries, in the order the chat store answered (newest
 *   activity first).
 * @param order - the arranged sequence.
 * @returns the same summaries, reordered. Nothing is added and nothing is lost.
 */
export function applyChatOrder(
  rows: readonly ChatSummary[],
  order: readonly string[],
): ChatSummary[] {
  if (order.length === 0) return [...rows]
  const placed = new Set(order)
  const byId = new Map(rows.map(row => [row.chatId, row]))
  const fresh = rows.filter(row => !placed.has(row.chatId))
  const arranged = order
    .map(id => byId.get(id))
    .filter((row): row is ChatSummary => row !== undefined)
  return [...fresh, ...arranged]
}

/**
 * The ids of an order, first appearance only.
 * @param ids - the sequence to clean.
 * @returns the same sequence with later repeats removed.
 */
function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
