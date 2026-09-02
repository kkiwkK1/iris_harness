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
 * The largest value one key may hold.
 *
 * **A placeholder, and labelled as one.** The number that belongs here is what
 * one value costs to clone into the script snapshot every turn, which the
 * sandbox domain is measuring in a real frame; bytes are the wrong unit for it,
 * because structured-clone cost tracks object count rather than size and the
 * snapshot already pays 85 ms for the variable tables alone. Until that
 * measurement lands this bounds the obvious runaway and nothing finer.
 */
export const MAX_VALUE_BYTES = 1_048_576

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

  /**
   * Write one key.
   * @param key - the key.
   * @param value - the value; strings only, as `localStorage` stores.
   * @param by - which card and script is writing.
   * @throws {Error} when the value exceeds {@link MAX_VALUE_BYTES}.
   */
  async set(key: string, value: string, by: { characterId?: string, scriptId?: string }): Promise<void> {
    await this.#load()
    const size = Buffer.byteLength(value, 'utf8')
    if (size > MAX_VALUE_BYTES) {
      throw new Error(
        `value for "${key}" is ${String(size)} bytes, over the ${String(MAX_VALUE_BYTES)} limit`,
      )
    }
    this.#entries[key] = {
      value,
      ...by.characterId === undefined ? {} : { characterId: by.characterId },
      ...by.scriptId === undefined ? {} : { scriptId: by.scriptId },
      at: Date.now(),
    }
    await this.#save()
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
    await this.#save()
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
    await this.#save()
    return reports
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
