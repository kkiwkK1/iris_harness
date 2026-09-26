/**
 * The model-written summaries of a lineage's **branch segments**, kept beside
 * the chat files and never in them.
 *
 * A segment is a run of floors between fork points on the lane that draws it
 * (`segmentsOf` in `@iris/protocol`). The tree map shows its summary on hover;
 * the summary itself is made only on request (`chat.summarizeSegment`), because
 * every one is a billed model call.
 *
 * **Why a sidecar.** The SillyTavern file is the compatibility floor: a summary
 * in it would travel to SillyTavern as a key it does not know, and every
 * header-level home the chat file offers is already rewritten by something
 * (`side-usage.ts` lists them). So one JSON file per conversation, under
 * `segment-summaries/<chatId>.json`, named by the conversation that **owns**
 * the segment's floors — the root for the common prefix, a branch for its own.
 *
 * **Keyed by content, not by floor number.** A record carries the segment's
 * first and last line key and a hash of every floor's role and shown text:
 *
 * - the line key is the durable `iris_id` (owner ruling 6), so the record finds
 *   the same floors after a line above them is deleted; an imported line that
 *   was never touched carries no id, and its key falls back to
 *   `@<chatId>#<floor>` — positional, which is the honest limit of a line with
 *   no identity of its own;
 * - the hash moves when a floor is edited or another swipe is shown, and that
 *   is what `stale` means.
 *
 * **The match policy**, named because it decides what the reader is shown
 * (`matchSegmentSummary`): among the family's records with the segment's first
 * key, one whose last key and hash both match is **fresh**; otherwise the most
 * recent record with that first key is shown **stale** — the run grew (the tail
 * segment of a live conversation grows every turn), was cut by a new branch, or
 * had a floor edited. A segment whose first floor is not any record's first
 * floor has no summary.
 *
 * **One summary for a shared prefix.** The prefix every branch shares is owned
 * by one lane, so it is one segment and one record however many branches read
 * it; and the lookup reads every family member's file, so a record stays found
 * whichever conversation of the family asks.
 *
 * @module @iris/app-service/segment-summaries
 */

import { createHash } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { lineIdOf, type SillyTavernMessage } from '@iris/persistence'

import { atomicWriteFile, readJsonStore } from './atomic.ts'
import { fileFor } from './paths.ts'

/** The file's schema version; a file with any other is ignored rather than guessed at. */
export const SEGMENT_SUMMARY_VERSION = 1

/** A segment's content identity. */
export interface SegmentIdentity {
  /** The first floor's line key: its `iris_id`, else `@<chatId>#<floor>`. */
  first: string
  /** The last floor's line key. */
  last: string
  /** Every floor's role and shown text, hashed in order. */
  hash: string
}

/** One stored summary. */
export interface StoredSegmentSummary extends SegmentIdentity {
  /** The floors it was made from, in the owner's numbers at the time; for display, never for matching. */
  from: number
  to: number
  summary: string
  at: number
  model?: string
}

/** The on-disk shape. */
interface SegmentSummaryFile {
  version: number
  chatId: string
  summaries: StoredSegmentSummary[]
}

/**
 * One floor's line key.
 * @param chatId - the conversation that owns the floor.
 * @param line - the line.
 * @param floor - its index.
 * @returns the durable id, or the positional fallback.
 */
function lineKey(chatId: string, line: SillyTavernMessage | undefined, floor: number): string {
  const id = line === undefined ? undefined : lineIdOf(line)
  return id ?? `@${chatId}#${String(floor)}`
}

/** The role a line speaks in, as the tree's prefix rule reads it (`chat-tree.ts`). */
function roleOf(line: SillyTavernMessage): 'user' | 'system' | 'assistant' {
  return line.is_user ? 'user' : line.is_system === true ? 'system' : 'assistant'
}

/**
 * A segment's identity, read off the owner's file.
 * @param chatId - the conversation that owns the segment.
 * @param messages - that conversation's message lines.
 * @param from - the first floor.
 * @param to - the last floor, inclusive.
 * @returns the identity.
 */
export function segmentIdentity(
  chatId: string,
  messages: readonly SillyTavernMessage[],
  from: number,
  to: number,
): SegmentIdentity {
  const hash = createHash('sha1')
  for (let floor = from; floor <= to; floor += 1) {
    const line = messages[floor]
    const text = line === undefined ? '' : typeof line.mes === 'string' ? line.mes : ''
    hash.update(JSON.stringify([line === undefined ? '' : roleOf(line), text]))
    hash.update('\n')
  }
  return {
    first: lineKey(chatId, messages[from], from),
    last: lineKey(chatId, messages[to], to),
    hash: hash.digest('hex').slice(0, 24),
  }
}

/**
 * The record to show for a segment, and whether it is still current.
 *
 * The policy is the module's: an exact match (first key, last key and hash) is
 * fresh; otherwise the newest record with the same first key is stale.
 * @param records - every record of the family.
 * @param identity - the segment as it reads now.
 * @returns the record and its standing, or undefined when the segment has none.
 */
export function matchSegmentSummary(
  records: readonly StoredSegmentSummary[],
  identity: SegmentIdentity,
): { record: StoredSegmentSummary, stale: boolean } | undefined {
  const exact = records.find(record =>
    record.first === identity.first && record.last === identity.last && record.hash === identity.hash)
  if (exact !== undefined) return { record: exact, stale: false }
  const same = records.filter(record => record.first === identity.first).sort((a, b) => b.at - a.at)[0]
  return same === undefined ? undefined : { record: same, stale: true }
}

/** Read one stored row, or nothing when it is not one. */
function readRow(value: unknown): StoredSegmentSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const { first, last, hash, from, to, summary, at, model } = row
  if (typeof first !== 'string' || typeof last !== 'string' || typeof hash !== 'string') return undefined
  if (typeof summary !== 'string' || typeof at !== 'number') return undefined
  if (typeof from !== 'number' || typeof to !== 'number') return undefined
  return { first, last, hash, from, to, summary, at, ...typeof model === 'string' ? { model } : {} }
}

/** Reads and writes the per-conversation summary files. */
export class SegmentSummaryStore {
  readonly #root: string
  readonly #onProblem: ((message: string) => void) | undefined
  /** One read-modify-write chain per conversation, as `SandboxPluginStore` runs them. */
  readonly #chains = new Map<string, Promise<void>>()

  /**
   * @param root - the profile's `segment-summaries` directory. It need not exist.
   * @param onProblem - told when a file was there and could not be parsed.
   */
  constructor(root: string, onProblem?: (message: string) => void) {
    this.#root = root
    this.#onProblem = onProblem
  }

  async #enqueue<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const link = (this.#chains.get(chatId) ?? Promise.resolve()).then(work)
    this.#chains.set(chatId, link.then(() => {}, () => {}))
    return link
  }

  /**
   * One conversation's records.
   * @param chatId - the conversation that owns the segments.
   * @returns the records, empty when there are none or the file is unreadable.
   */
  async list(chatId: string): Promise<StoredSegmentSummary[]> {
    let path: string
    try {
      path = fileFor(this.#root, chatId, '.json')
    } catch {
      return []
    }
    const parsed = await readJsonStore(path, this.#onProblem)
    if (parsed === null || typeof parsed !== 'object') return []
    const file = parsed as Partial<SegmentSummaryFile>
    if (file.version !== SEGMENT_SUMMARY_VERSION || !Array.isArray(file.summaries)) return []
    return file.summaries.map(readRow).filter((row): row is StoredSegmentSummary => row !== undefined)
  }

  /**
   * Store a summary, replacing any record of the same first and last key.
   *
   * A record of the same first key and a *different* last key is kept: it is
   * what a segment shows while stale after a new branch cut its run in two,
   * until the reader summarizes it again, and then the exact record wins.
   * @param chatId - the conversation that owns the segment.
   * @param record - the summary and its identity.
   */
  async put(chatId: string, record: StoredSegmentSummary): Promise<void> {
    await this.#enqueue(chatId, async () => {
      const kept = (await this.list(chatId))
        .filter(row => !(row.first === record.first && row.last === record.last))
      const file: SegmentSummaryFile = { version: SEGMENT_SUMMARY_VERSION, chatId, summaries: [...kept, record] }
      const path = fileFor(this.#root, chatId, '.json')
      await mkdir(dirname(path), { recursive: true })
      await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`)
    })
  }

  /**
   * Drop a conversation's summaries, because the conversation is gone.
   *
   * Called from `chat.delete` (owner ruling 5): chat ids are minted against the
   * files that exist, so the next conversation of this name would otherwise be
   * shown a stranger's summaries wherever its positional keys line up. Backups
   * are not touched.
   * @param chatId - the conversation that was deleted.
   */
  async forget(chatId: string): Promise<void> {
    await this.#enqueue(chatId, async () => {
      let path: string
      try {
        path = fileFor(this.#root, chatId, '.json')
      } catch {
        return
      }
      await unlink(path).catch(() => undefined)
    })
  }
}
