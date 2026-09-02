/**
 * The key–value store a card's scripts use as their browser storage.
 *
 * **Shared across the whole profile, deliberately.** Upstream's cards write to
 * one `localStorage` per origin, so two cards choosing the same key see each
 * other's values — measured on the corpus as four shared keys between two cards
 * (`UPSTREAM-FRAME-ORIGIN.md §四`). That collision is upstream's behaviour and
 * is reproduced rather than partitioned away: a card that reads a key another
 * card wrote is doing what it does in SillyTavern.
 *
 * What is *not* reproduced is the silence. Every key records who wrote it last,
 * so a `clear()` or a cross-card `remove()` can say **which keys went and whose
 * they were** — upstream wipes the lot with no way to attribute the loss.
 *
 * @module @iris/app-service/card-storage
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * How much the whole store may hold, in bytes of keys and values.
 *
 * **Built to the mechanism a card already lives under.** A browser gives one
 * origin roughly 5–10 MiB of `localStorage` and throws `QuotaExceededError`
 * from `setItem` when it is full, so every card that stores anything is already
 * written against a quota. This is the upper end of that range: below it,
 * behaviour matches what the card met in SillyTavern; above it, no browser would
 * have accepted the write either.
 *
 * **There is deliberately no per-value limit.** Browsers do not impose one — a
 * 2 MB wallpaper stores fine in SillyTavern, so it must store fine here. An
 * earlier draft capped a single value at 1 MiB on fairness grounds; that is a
 * rule upstream does not have, and fairness is carried instead by the total
 * quota plus the attribution in the report, which together say *who* filled the
 * store rather than forbidding anyone from trying.
 *
 * Counted over keys and values, which is what a browser counts and what a card
 * can control. The file on disk is slightly larger, because it also carries the
 * writer of each key.
 */
export const MAX_STORE_BYTES = 10 * 1_048_576

/**
 * How long writes are coalesced before touching the disk.
 *
 * Every write re-serialises the whole store, so the cost scales with the
 * store's size times the write rate rather than with any one value — measured
 * at 2.53 ms per write against a 4 MiB store. A card updating a key each turn
 * pays that every time. Upstream has the same shape and the same answer:
 * `saveSettingsDebounced`.
 *
 * Reads are **not** delayed: a card that writes and immediately reads must see
 * its own write, so the in-memory table is updated synchronously and only the
 * disk write waits.
 */
export const WRITE_DEBOUNCE_MS = 400

/**
 * The store is full, in the shape a card already understands.
 *
 * Carries what a browser cannot: how large the store is and which card's keys
 * make it up. A quota refusal that only says "full" leaves the user with no way
 * to act; naming the writers is the part upstream has no answer for.
 */
export class QuotaExceeded extends Error {
  readonly size: number
  readonly byWriter: Record<string, number>

  /**
   * @param size - what the store would have become, in bytes.
   * @param byWriter - bytes per character id.
   */
  constructor(size: number, byWriter: Record<string, number>) {
    super(
      `card storage is full: the write would take it to ${String(size)} bytes,`
      + ` over the ${String(MAX_STORE_BYTES)} limit`,
    )
    this.name = 'QuotaExceeded'
    this.size = size
    this.byWriter = byWriter
  }
}

/** One key's value and the last card to write it. */
export interface StoredValue {
  /** Values are strings because `localStorage` values are strings. */
  value: string
  /** Which card wrote it last. */
  characterId?: string
  /** Which of that card's scripts, when the caller named one. */
  scriptId?: string
  /** Unix epoch milliseconds of that write. */
  at: number
}

/** Who last wrote a key, for a report about removing it. */
export interface LastWriter {
  characterId?: string
  scriptId?: string
  at: number
}

/** What a removal did, so the caller can report it. */
export interface RemovalReport {
  key: string
  /** Absent when the key had no recorded writer. */
  lastWriter?: LastWriter
  /** Whether the key belonged to a card other than the one removing it. */
  foreign: boolean
}

/**
 * Card storage for one profile.
 *
 * The file carries the writer metadata; the snapshot handed to a frame carries
 * only key and value. Keeping the two shapes apart is deliberate — the frame
 * has no use for provenance, and putting it there would ship a per-key object
 * into a payload that is already the expensive part of every turn.
 */
export class CardStorageStore {
  readonly #path: string
  readonly #onError: (error: Error) => void
  #entries: Record<string, StoredValue> = {}
  #loaded = false
  #pending: ReturnType<typeof setTimeout> | undefined
  #writing: Promise<void> | undefined

  /**
   * @param path - the JSON file backing the store.
   * @param onError - told when a write fails; absent means silence.
   */
  constructor(path: string, onError: (error: Error) => void = () => {}) {
    this.#path = path
    this.#onError = onError
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        this.#entries = parsed as Record<string, StoredValue>
      }
    } catch {
      // Absent or unreadable is an empty store, which is the correct first-run
      // state and what every existing profile is in.
    }
  }

  /**
   * Every key and value, in the flat shape a frame reads.
   *
   * Provenance is dropped here on purpose: see the class comment.
   * @returns key to value, as a fresh object.
   */
  async snapshot(): Promise<Record<string, string>> {
    await this.#load()
    return Object.fromEntries(Object.entries(this.#entries).map(([key, held]) => [key, held.value]))
  }

  /**
   * Who last wrote a key.
   * @param key - the key.
   * @returns the writer, or undefined when the key is absent or unattributed.
   */
  async lastWriter(key: string): Promise<LastWriter | undefined> {
    await this.#load()
    const held = this.#entries[key]
    if (held === undefined) return undefined
    return {
      ...held.characterId === undefined ? {} : { characterId: held.characterId },
      ...held.scriptId === undefined ? {} : { scriptId: held.scriptId },
      at: held.at,
    }
  }

  /** Bytes of keys and values, which is what a browser's quota counts. */
  async size(): Promise<number> {
    await this.#load()
    return Object.entries(this.#entries).reduce(
      (total, [key, held]) => total + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(held.value, 'utf8'),
      0,
    )
  }

  /**
   * How the stored bytes divide between the cards that wrote them.
   *
   * The other half of the quota answer: a card told the store is full needs to
   * know *whose* it is, and upstream cannot say — a browser reports the quota
   * and nothing about who filled it.
   * @returns bytes per character id, with unattributed keys under `unknown`.
   */
  async bytesByWriter(): Promise<Record<string, number>> {
    await this.#load()
    const byWriter: Record<string, number> = {}
    for (const [key, held] of Object.entries(this.#entries)) {
      const who = held.characterId ?? 'unknown'
      byWriter[who] = (byWriter[who] ?? 0)
        + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(held.value, 'utf8')
    }
    return byWriter
  }

  /**
   * Write one key.
   *
   * The disk write is coalesced; the in-memory table is updated at once, so a
   * card that writes and reads back sees its own value.
   * @param key - the key.
   * @param value - the value; strings only, as `localStorage` stores.
   * @param by - which card and script is writing.
   * @throws {QuotaExceeded} when the store would pass {@link MAX_STORE_BYTES}.
   */
  async set(key: string, value: string, by: { characterId?: string, scriptId?: string }): Promise<void> {
    await this.#load()
    // The size *after* this write, counting the key only once whether it is new
    // or being replaced — a card overwriting its own value must not be refused
    // for the bytes it is about to release.
    const held = this.#entries[key]
    const heldBytes = held === undefined ? 0 : Buffer.byteLength(held.value, 'utf8')
    const after = await this.size()
      - heldBytes
      + Buffer.byteLength(value, 'utf8')
      + (held === undefined ? Buffer.byteLength(key, 'utf8') : 0)
    if (after > MAX_STORE_BYTES) {
      throw new QuotaExceeded(after, await this.bytesByWriter())
    }
    this.#entries[key] = {
      value,
      ...by.characterId === undefined ? {} : { characterId: by.characterId },
      ...by.scriptId === undefined ? {} : { scriptId: by.scriptId },
      at: Date.now(),
    }
    this.#schedule()
  }

  /**
   * Remove one key, reporting whose it was.
   * @param key - the key.
   * @param by - which card is removing it, for the foreign check.
   * @returns what was removed, or undefined when the key was not there.
   */
  async remove(key: string, by: { characterId?: string }): Promise<RemovalReport | undefined> {
    await this.#load()
    const held = this.#entries[key]
    if (held === undefined) return undefined

    const writer = await this.lastWriter(key)
    delete this.#entries[key]
    this.#schedule()
    return {
      key,
      ...writer === undefined ? {} : { lastWriter: writer },
      // Unattributed keys are not foreign: a key with no recorded writer
      // predates this bookkeeping, and calling it someone else's would report a
      // theft that cannot be substantiated.
      foreign: held.characterId !== undefined && held.characterId !== by.characterId,
    }
  }

  /**
   * Remove every key, reporting each one.
   *
   * Upstream's `clear()` empties the whole origin, so a card clearing "its"
   * storage takes every other card's keys with it. Reproduced — but each
   * removal is returned, so the caller can say what went and whose it was.
   * @param by - which card is clearing, for the foreign check.
   * @returns one report per key removed.
   */
  async clear(by: { characterId?: string }): Promise<RemovalReport[]> {
    await this.#load()
    const reports: RemovalReport[] = []
    for (const key of Object.keys(this.#entries)) {
      const held = this.#entries[key]
      if (held === undefined) continue
      const writer = await this.lastWriter(key)
      reports.push({
        key,
        ...writer === undefined ? {} : { lastWriter: writer },
        foreign: held.characterId !== undefined && held.characterId !== by.characterId,
      })
    }
    this.#entries = {}
    // Nothing went, so nothing is written. A clear() over an empty store
    // would otherwise create the file on a first run, and the file existing is
    // what says "a card stored something" — remove() of a missing key already
    // declines in the same way.
    if (reports.length > 0) this.#schedule()
    return reports
  }

  /**
   * Ask for a disk write soon, coalescing with any already pending.
   *
   * The timer is unref'd so a pending write cannot hold the process open; a
   * clean shutdown calls {@link flush}, and an unclean one loses at most the
   * last few hundred milliseconds — which is the same bargain upstream's
   * `saveSettingsDebounced` makes.
   */
  #schedule(): void {
    if (this.#pending !== undefined) return
    this.#pending = setTimeout(() => {
      this.#pending = undefined
      this.#writing = this.#save()
    }, WRITE_DEBOUNCE_MS)
    this.#pending.unref?.()
  }

  /**
   * Write anything still pending, now.
   *
   * Called on shutdown. Without it the debounce would turn "the host stopped"
   * into "the last write never happened", which is the failure the debounce is
   * supposed to be too small to cause.
   */
  async flush(): Promise<void> {
    if (this.#pending !== undefined) {
      clearTimeout(this.#pending)
      this.#pending = undefined
      this.#writing = this.#save()
    }
    await this.#writing
  }

  async #save(): Promise<void> {
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await writeFile(this.#path, `${JSON.stringify(this.#entries, null, 2)}\n`, 'utf8')
    } catch (error: unknown) {
      // Reported rather than thrown: a card's write failing to persist must not
      // fail the call that made it, but it must not be silent either — the
      // script would go on believing its state is saved.
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/**
 * The sentence a removal deserves when it took another card's key.
 * @param report - what was removed.
 * @param action - the member the card called.
 * @returns the message, or undefined when nothing is worth saying.
 */
export function removalNote(report: RemovalReport, action: 'remove' | 'clear'): string | undefined {
  if (!report.foreign) return undefined
  const owner = report.lastWriter?.characterId ?? 'another card'
  const script = report.lastWriter?.scriptId === undefined
    ? ''
    : ` (script "${report.lastWriter.scriptId}")`
  return `${action} removed "${report.key}", last written by ${owner}${script};`
    + ' card storage is shared across the profile, as it is in SillyTavern'
}
