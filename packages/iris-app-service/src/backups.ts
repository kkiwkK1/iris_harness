/**
 * Conversation snapshots: the copies the host takes in front of the irreversible.
 *
 * Iris's chat file is already the backup unit — SillyTavern JSONL, one file per
 * conversation. What this module adds is the thing upstream's
 * `src/endpoints/backups.js` gives its install: copies the host itself takes and
 * can itself find again. A copy the host can find is what makes a sweep
 * survivable; a download that went to a folder nobody remembers is a backup
 * only in the moment it was offered.
 *
 * **Snapshots are taken *before* a dangerous operation, never after.** Every
 * call site names the operation it is about to perform, and the copy lands
 * under the profile — `backups/<character>/<chat>/<stamp>-<reason>.jsonl` — so
 * it travels with the profile it protects, groups under the conversation it
 * copied, and says in its own name why it exists. The reason is recorded in
 * the file name rather than a sidecar index, because a sidecar is one more
 * file that can disagree with the folder it describes.
 *
 * Retention is upstream's answer, kept: keep the newest N per conversation and
 * delete the rest, oldest first (`removeOldBackups` in `src/util.js`, measured
 * against the file names' sort order here and mtime there). `rotateBackups`
 * is the pure half and is tested apart from the disk.
 *
 * @module @iris/app-service/backups
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { BackupPreview, BackupPreviewFloor, BackupReason, BackupSummary } from '@iris/protocol'

import { invalid, notFound } from './errors.ts'
import { backupsDir, fileFor, isSafeId } from './paths.ts'

/** Snapshots kept per conversation, upstream's own default (`backups.common.numberOfBackups`). */
export const DEFAULT_BACKUP_KEEP = 50

/** The directory a conversation without a card files its snapshots under. */
export const NO_CHARACTER = '-'

/** Floors a preview shows when the caller did not ask for a number. */
export const DEFAULT_PREVIEW_FLOORS = 5

/** Characters of floor text a preview keeps — a look, not a re-render. */
const PREVIEW_TEXT_CHARS = 200

/**
 * One snapshot's file name, and what each part of it says.
 *
 * `20260906-123456-789-f42-save-chat.jsonl` — UTC stamp (fixed width, so the
 * names sort in time order as plain strings), floor count, reason. The
 * trailing `-2` is a same-millisecond collision suffix, which is why the
 * reason is matched lazily and digits are refused inside it.
 */
const NAME_RE =
  /^(\d{8}-\d{6}-\d{3})-f(\d+)-([a-z][a-z-]*?)(?:-([2-9]\d*))?\.jsonl$/u

/**
 * A snapshot name that matches {@link NAME_RE}, taken apart.
 * @param name - the file name, extension included.
 * @returns the parts, or undefined when the name is not one of ours.
 */
function parseName(name: string): {
  stamp: string
  floors: number
  reason?: BackupReason
  collision?: number
} | undefined {
  const match = NAME_RE.exec(name)
  if (match === null) return undefined
  const [, stamp, floors, reason, collision] = match
  const known: BackupReason[] = ['cleanup', 'delete-message', 'delete-messages', 'import-overwrite', 'pre-restore', 'rewrite-messages']
  return {
    stamp: stamp ?? '',
    floors: Number(floors),
    // A reason this host does not know (an older build's, a hand-edit's) is
    // still listed — it is a snapshot either way — it just reads as unnamed.
    ...known.includes(reason as BackupReason) ? { reason: reason as BackupReason } : {},
    ...collision === undefined ? {} : { collision: Number(collision) },
  }
}

/**
 * The UTC stamp a snapshot's name opens with.
 *
 * Fixed-width and digit-only, so a directory listing sorts chronologically as
 * plain strings — a rotation that needs `stat` to know which copy is oldest
 * has already made its file names mean less than its file system.
 * @param when - the moment of the snapshot.
 * @returns e.g. `20260906-123456-789`.
 */
export function backupStamp(when: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}`
    + `-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`
    + `-${pad(when.getUTCMilliseconds(), 3)}`
}

/**
 * Read a stamp back as a moment.
 * @param stamp - what {@link backupStamp} wrote.
 * @returns Unix epoch milliseconds, or undefined when it does not parse.
 */
export function parseBackupStamp(stamp: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/u.exec(stamp)
  if (match === null) return undefined
  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(part => Number(part))
  const moment = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0, ms ?? 0)
  return Number.isNaN(moment) ? undefined : moment
}

/**
 * Which snapshots go, given the ones there are.
 *
 * The pure half of retention, so the rule is testable without a disk: sort the
 * names, keep the newest `keep`, return the rest. Sorting is lexicographic on
 * purpose — our stamps are fixed-width UTC, so name order **is** time order.
 *
 * `keep` below 1 is read as 1: a retention setting that deleted everything
 * would turn every write into the deletion it was meant to protect against,
 * and no honest reading of "keep N" asks for that.
 * @param names - snapshot file names, in any order.
 * @param keep - how many newest survive.
 * @returns the names to delete, oldest first.
 */
export function rotateBackups(names: readonly string[], keep: number): string[] {
  const retention = Math.max(1, Math.floor(keep))
  const ordered = [...names].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  return ordered.slice(0, Math.max(0, ordered.length - retention))
}

/** What a restore needs to know before it is allowed to run. */
export interface BackupIntent {
  /** The conversation the snapshot would be written back as. */
  chatId: string
  /** The card it was played with, when the header records one. */
  characterId?: string
  /**
   * The conversation's title, as the header spells it — the word the caller
   * has to type to prove the overwrite was meant.
   */
  title: string
  /** The snapshot's whole text, ready to write back verbatim. */
  text: string
}

/** Tuning for one store. */
export interface BackupStoreOptions {
  /** Snapshots kept per conversation. @default {@link DEFAULT_BACKUP_KEEP} */
  keep?: number
  /** Reports a snapshot that could not be removed during rotation. */
  onError?: (error: Error) => void
}

/**
 * The profile's snapshot store.
 *
 * Reads and writes under `backups/` beside the profile's `chats/`, one
 * directory per conversation, and never touches a live chat file itself —
 * writing a snapshot back is the caller's decision, taken through
 * `ChatStore.restoreFile`, so this store stays the one thing here that cannot
 * lose a conversation.
 */
export class BackupStore {
  /** The profile's chat directory; `backups/` is derived from it. */
  readonly #chatsDir: string
  readonly #keep: number
  readonly #onError: ((error: Error) => void) | undefined
  /**
   * The millisecond the last snapshot was stamped with, so the next one is
   * stamped at least one later. Two snapshots in one millisecond used to share
   * a `createdAt` - the list's newest-first order and the rotation's oldest-first
   * order both became insertion order - and the second one's `-2` suffix sorts
   * *before* the unsuffixed name as a plain string (`-` is 0x2d, `.` is 0x2e),
   * so rotation read the newer copy as the older. Seen only on a fast Linux
   * runner; a Windows clock ticks coarsely enough to hide it.
   */
  #lastStampMs = 0

  /**
   * @param chatsDir - the profile's chat directory.
   * @param options - retention and the rotation error sink.
   */
  constructor(chatsDir: string, options?: BackupStoreOptions) {
    this.#chatsDir = chatsDir
    this.#keep = options?.keep ?? DEFAULT_BACKUP_KEEP
    this.#onError = options?.onError
  }

  /** The backups root, beside the profile's chats. */
  get root(): string {
    return backupsDir(this.#chatsDir)
  }

  /**
   * Copy a conversation aside.
   *
   * The file is read whole rather than `copyFile`'d, because the read is what
   * pays for the summary: the floor count the name records and the byte size
   * the list shows come off these bytes, and the save-chat arm's dedup
   * compares against them. Identical cost, one honest listing.
   *
   * **The copy is of the file on disk.** A chat open in memory may hold
   * changes the dangerous operation has not written yet — those are exactly
   * the changes the caller is about to make permanent, and the snapshot's
   * whole purpose is to hold the state that predates them.
   * @param chatId - the conversation to copy.
   * @param reason - what is about to happen to it.
   * @param characterId - the card it is played with, for the first directory.
   * @param options - `dedup` skips the write when the newest snapshot already
   *   holds these exact bytes; the returned summary is that snapshot's, so the
   *   caller can still name where the pre-change state lives.
   * @returns the summary of the snapshot that now holds the pre-change state.
   * @throws {AppError} `not-found` when the chat file is not on disk.
   */
  async snapshot(
    chatId: string,
    reason: BackupReason,
    characterId?: string,
    options?: { dedup?: boolean },
  ): Promise<BackupSummary> {
    const source = fileFor(this.#chatsDir, chatId, '.jsonl')
    let text: string
    try {
      text = await readFile(source, 'utf8')
    } catch {
      throw notFound(`no chat "${chatId}" to back up`)
    }

    const chatDir = this.#chatDir(characterId ?? NO_CHARACTER, chatId)
    const existing = await this.#listDir(chatDir)
    const floors = countFloors(text)

    if (options?.dedup === true) {
      const newest = existing[existing.length - 1]
      if (newest !== undefined) {
        const previous = await readFile(join(chatDir, newest.name), 'utf8').catch(() => undefined)
        if (previous === text) {
          return this.#summaryOf(characterId ?? NO_CHARACTER, chatId, newest.name, newest.bytes, newest.floors)
        }
      }
    }

    await mkdir(chatDir, { recursive: true })
    // The stamp is monotonic per store: never earlier than the last one plus a
    // millisecond, so names sort in the order the snapshots were taken and no
    // two share a `createdAt`. The suffix loop below stays as the guard for the
    // case the monotonic clock cannot see - a second store, or a restart within
    // the same millisecond - because the one being replaced is exactly the copy
    // worth keeping.
    const stampedAt = Math.max(Date.now(), this.#lastStampMs + 1)
    this.#lastStampMs = stampedAt
    const stamp = backupStamp(new Date(stampedAt))
    const base = `${stamp}-f${String(floors)}-${reason}`
    let name = `${base}.jsonl`
    for (let suffix = 2; existsSync(join(chatDir, name)); suffix += 1) {
      name = `${base}-${String(suffix)}.jsonl`
    }
    await writeFile(join(chatDir, name), text, 'utf8')

    await this.#rotate(chatDir)

    return {
      backupId: this.#idOf(characterId ?? NO_CHARACTER, chatId, name),
      chatId,
      ...characterId === undefined ? {} : { characterId },
      createdAt: parseBackupStamp(stamp) ?? 0,
      messageCount: floors,
      bytes: Buffer.byteLength(text, 'utf8'),
      reason,
    }
  }

  /**
   * The snapshots this profile holds, newest first.
   * @param chatId - one conversation's snapshots, or absent for the profile.
   * @returns the summaries.
   */
  async list(chatId?: string): Promise<BackupSummary[]> {
    const summaries: BackupSummary[] = []
    let characters: string[]
    try {
      characters = await readdir(this.root)
    } catch {
      // No backups directory yet — a profile the host has never protected.
      return []
    }
    for (const character of characters) {
      let chats: string[]
      try {
        chats = await readdir(join(this.root, character))
      } catch {
        continue // A file, or something that is not ours to read.
      }
      for (const chat of chats) {
        if (chatId !== undefined && chat !== chatId) continue
        summaries.push(...(await this.#listDir(this.#chatDir(character, chat)))
          .map(row => this.#summaryOf(character, chat, row.name, row.bytes, row.floors)))
      }
    }
    return summaries.sort((left, right) => right.createdAt - left.createdAt)
  }

  /**
   * The head of one snapshot, read off its own bytes.
   * @param backupId - the handle, as `list` carried it.
   * @param floors - how many floors to show.
   * @returns the preview.
   * @throws {AppError} `not-found` when no snapshot answers to the handle.
   */
  async preview(backupId: string, floors: number = DEFAULT_PREVIEW_FLOORS): Promise<BackupPreview> {
    const { character, chat, name, path } = this.#locateParts(backupId)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw notFound(`no snapshot "${backupId}"`)
    }

    const lines = text.split('\n').filter(line => line.trim().length > 0)
    const head = readHeader(lines[0] ?? '')

    const shown: BackupPreviewFloor[] = []
    for (let index = 1; index < Math.min(lines.length, floors + 1); index += 1) {
      const row = parseFloor(lines[index] ?? '')
      if (row === undefined) continue
      shown.push({
        messageId: index - 1,
        name: row.name,
        isUser: row.isUser,
        text: row.text.length > PREVIEW_TEXT_CHARS ? `${row.text.slice(0, PREVIEW_TEXT_CHARS)}…` : row.text,
      })
    }

    // The count is read off these bytes, not off the name: what a reader sees
    // here is what a restore writes back, and if the name's recorded count
    // ever disagreed with the file, the file is the truth.
    return {
      backup: this.#summaryOf(character, chat, name, Buffer.byteLength(text, 'utf8'), Math.max(0, lines.length - 1)),
      title: head.title,
      ...head.userName === undefined ? {} : { userName: head.userName },
      ...head.characterName === undefined ? {} : { characterName: head.characterName },
      ...head.createDate === undefined ? {} : { createDate: head.createDate },
      floors: shown,
      totalFloors: Math.max(0, lines.length - 1),
    }
  }

  /**
   * Read a snapshot whole, as a restore would want it.
   * @param backupId - the handle, as `list` carried it.
   * @returns what the caller must confirm before writing, and the bytes.
   * @throws {AppError} `not-found` when no snapshot answers to the handle.
   */
  async read(backupId: string): Promise<BackupIntent> {
    const { character, chat, path } = this.#locateParts(backupId)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw notFound(`no snapshot "${backupId}"`)
    }
    const head = readHeader(text.split('\n').filter(line => line.trim().length > 0)[0] ?? '')
    // The header's own identity wins over the folder it sits in: a snapshot
    // moved by hand is still a copy of the conversation it was taken of.
    const chatId = head.iris?.chatId !== undefined && head.iris.chatId.length > 0 ? head.iris.chatId : chat
    const characterId = head.iris?.characterId ?? (character === NO_CHARACTER ? undefined : character)
    return {
      chatId,
      ...characterId === undefined ? {} : { characterId },
      title: head.title,
      text,
    }
  }

  /**
   * The absolute path of one snapshot, after the handle has been checked.
   *
   * For the one legacy caller that reports a path (`chat.answerCleanup`); the
   * wire methods answer with the relative handle.
   * @param backupId - the handle.
   * @returns the absolute path.
   * @throws {AppError} `invalid-request` when the handle is not one of ours.
   */
  locate(backupId: string): string {
    return this.#locateParts(backupId).path
  }

  /**
   * Whether the conversation's live file is on disk — the guard a restore
   * checks before it decides to snapshot the version it is about to replace.
   * @param chatId - the conversation.
   * @returns true when the file exists.
   */
  hasChatFile(chatId: string): boolean {
    return existsSync(fileFor(this.#chatsDir, chatId, '.jsonl'))
  }

  /**
   * Delete one snapshot.
   * @param backupId - the handle.
   * @throws {AppError} `not-found` when no snapshot answers to the handle.
   */
  async remove(backupId: string): Promise<void> {
    const { path } = this.#locateParts(backupId)
    try {
      await unlink(path)
    } catch {
      throw notFound(`no snapshot "${backupId}"`)
    }
  }

  // ----------------------------------------------------------------- internals

  /** One conversation's snapshot directory, ids checked before they become a path. */
  #chatDir(character: string, chat: string): string {
    const root = resolve(this.root)
    const dir = resolve(root, character, chat)
    if (!isSafeId(character) || !isSafeId(chat) || !dir.startsWith(root + sep) || dir === root) {
      throw invalid(`"${character}/${chat}" is not a valid snapshot location`)
    }
    return dir
  }

  /**
   * Resolve a handle to its file, refusing anything that leaves the store.
   *
   * Three segments, each held to the same id rule a chat file is — the handle
   * arrives from the browser, and a `..` in any of them is an escape attempt
   * before it is anything else.
   */
  #locateParts(backupId: string): { character: string, chat: string, name: string, path: string } {
    const segments = backupId.split('/')
    if (segments.length !== 3 || segments.some(segment => !isSafeId(segment))) {
      throw invalid(`"${backupId.slice(0, 120)}" is not a snapshot id`)
    }
    const [character, chat, name] = segments as [string, string, string]
    if (!name.endsWith('.jsonl')) throw invalid(`"${backupId.slice(0, 120)}" is not a snapshot id`)
    const root = resolve(this.root)
    const path = resolve(root, character, chat, name)
    if (!path.startsWith(root + sep)) throw invalid(`"${backupId.slice(0, 120)}" is not a snapshot id`)
    return { character, chat, name, path }
  }

  #idOf(character: string, chat: string, name: string): string {
    return `${character}/${chat}/${name}`
  }

  #summaryOf(character: string, chat: string, name: string, bytes: number, floors: number): BackupSummary {
    const parsed = parseName(name)
    const characterId = character === NO_CHARACTER ? undefined : character
    return {
      backupId: this.#idOf(character, chat, name),
      chatId: chat,
      ...characterId === undefined ? {} : { characterId },
      createdAt: parsed === undefined ? 0 : parseBackupStamp(parsed.stamp) ?? 0,
      messageCount: parsed === undefined ? floors : parsed.floors,
      bytes,
      ...parsed?.reason === undefined ? {} : { reason: parsed.reason },
    }
  }

  /** The snapshots in one conversation's directory, oldest first. */
  async #listDir(dir: string): Promise<{ name: string, bytes: number, floors: number }[]> {
    let names: string[]
    try {
      names = (await readdir(dir)).filter(name => NAME_RE.test(name)).sort()
    } catch {
      return []
    }
    const rows: { name: string, bytes: number, floors: number }[] = []
    for (const name of names) {
      try {
        rows.push({ name, bytes: (await stat(join(dir, name))).size, floors: parseName(name)?.floors ?? 0 })
      } catch {
        continue // Deleted between the listing and the stat; it is gone either way.
      }
    }
    return rows
  }

  /** Apply the retention cap to one conversation's directory. */
  async #rotate(chatDir: string): Promise<void> {
    const rows = await this.#listDir(chatDir)
    const stale = rotateBackups(rows.map(row => row.name), this.#keep)
    for (const name of stale) {
      try {
        await unlink(join(chatDir, name))
      } catch (cause: unknown) {
        // Reported, not raised: an old copy that would not leave must not
        // undo the fresh one that was just written.
        this.#onError?.(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
  }
}

/**
 * Floors in a chat file's text: non-empty lines, header excluded.
 */
function countFloors(text: string): number {
  return Math.max(0, text.split('\n').filter(line => line.trim().length > 0).length - 1)
}

/** What the preview and the restore both need off the header line. */
interface HeaderFacts {
  title: string
  userName?: string
  characterName?: string
  createDate?: string
  iris?: { chatId?: string, characterId?: string }
}

/**
 * Read a chat file's header line.
 *
 * Deliberately shallow: a snapshot is a copy of a file this host already
 * validated when it stored the conversation, so this reads the facts the
 * preview and the confirm step show, and nothing more. A header that does not
 * parse still previews — it just says nothing about itself.
 * @param line - the file's first non-empty line.
 * @returns the facts, with the title left empty when there is none.
 */
function readHeader(line: string): HeaderFacts {
  let header: Record<string, unknown>
  try {
    header = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { title: '' }
  }
  const rawIris = header['iris']
  const iris = typeof rawIris === 'object' && rawIris !== null ? rawIris as Record<string, unknown> : undefined
  const title = typeof header['character_name'] === 'string' ? header['character_name'] : ''
  const irisTitle = typeof iris?.['title'] === 'string' && iris['title'].length > 0 ? iris['title'] : undefined
  return {
    title: irisTitle ?? title,
    ...typeof header['user_name'] === 'string' ? { userName: header['user_name'] } : {},
    ...title.length > 0 ? { characterName: title } : {},
    ...typeof header['create_date'] === 'string' ? { createDate: header['create_date'] } : {},
    ...iris === undefined ? {} : {
      iris: {
        ...typeof iris['chatId'] === 'string' ? { chatId: iris['chatId'] } : {},
        ...typeof iris['characterId'] === 'string' ? { characterId: iris['characterId'] } : {},
      },
    },
  }
}

/** The fields a preview floor reads off one stored line. */
function parseFloor(line: string): { name: string, isUser: boolean, text: string } | undefined {
  try {
    const row = JSON.parse(line) as Record<string, unknown>
    if (typeof row['mes'] !== 'string') return undefined
    return {
      name: typeof row['name'] === 'string' ? row['name'] : '',
      isUser: row['is_user'] === true,
      text: row['mes'],
    }
  } catch {
    return undefined
  }
}
