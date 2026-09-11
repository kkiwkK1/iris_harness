/**
 * Turning a card's embedded world book into a named book on disk.
 *
 * **Why this exists at all.** SillyTavern's assembly layer reads exactly one
 * character-book channel: the bound name in `extensions.world`
 * (`world-info.js:4363-4380`). The embedded `character_book` never reaches it —
 * it is materialised into a named book first, by an explicit user action
 * (`importEmbeddedWorldInfo`, whose only two call sites are UI clicks). Iris had
 * a second channel that read the embedded book directly at assembly time, and
 * the "choose one, never both" rule existed to patch a duplication that
 * upstream structurally cannot produce.
 *
 * So the fix is not a better choice between two sources; it is doing what
 * upstream does — materialise, then read one channel. Measured before the
 * change: **7 of 8 cards in the dev profile relied on the embedded channel**
 * (407 entries), against 2 of 19 in the SillyTavern install, whose 18 named
 * books are exactly the materialised end state being reproduced here.
 *
 * **What is deliberately not copied.** Upstream writes the chosen name back
 * into the card file's `extensions.world`. This host records it in its own
 * binding table instead, so a card exported back to SillyTavern is unchanged
 * and still carries its embedded book. The assembly layer is still
 * single-channel; only the bookkeeping of "which book" lives elsewhere.
 *
 * @module @iris/app-service/materialise
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { atomicWriteFile, readJsonStore } from './atomic.ts'

import type { CharacterCard } from '@iris/character'
import { fromCharacterBook, parseLorebook } from '@iris/lorebook'

import type { WorldbookEntry } from '@iris/protocol'

import type { FetchFailure, StInstall } from './st-install.ts'
import { charWorldbookNames, toWorldbookEntry, type WorldbookStore } from './worldbooks.ts'

/** How a binding's name was arrived at. */
export type BindingOrigin =
  /** The card's own `extensions.world`, and no book of that name existed. */
  | 'card-name'
  /** The card named a book that never travelled with it; seeded from the embedded copy. */
  | 'seeded-from-embedded'
  /** The wanted name was taken by a book this card does not own. */
  | 'minted'
  /** Fetched from the user's SillyTavern install, which outranks a seed. */
  | 'imported-from-st'

/** What was materialised for one character, and from what. */
export interface MaterialisedBinding {
  /** The book this card's world info now comes from. */
  name: string
  /**
   * Hash of the embedded book **after normalisation**, answering "has the card
   * changed?".
   *
   * Normalised rather than raw so that reordering entries — which a card author
   * does without changing meaning — is not read as new content.
   */
  sourceHash: string
  /**
   * Hash of the **bytes written**, answering "has the user changed the book?".
   *
   * Bytes rather than a normalised form, because the question on this side is
   * "is this still the file I wrote", and byte equality is both the strongest
   * available answer and the cheapest.
   */
  materialisedHash: string
  origin: BindingOrigin
  at: number
}

/** Every character's binding, by character id. */
type Bindings = Record<string, MaterialisedBinding>

/**
 * Which named book each card's embedded book became.
 *
 * The link between a card and its book is **this table**, not the filename —
 * which is what allows a name to be given up when it collides without anything
 * being lost or overwritten.
 */
export class WorldbookBindingStore {
  readonly #path: string
  readonly #onError: (error: Error) => void
  readonly #onProblem: ((message: string) => void) | undefined
  #bindings: Bindings = {}
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   * @param onError - told when a write fails; absent means silence.
   * @param onProblem - told when the file was there and could not be read or
   *   parsed; see `atomic.ts`'s `readJsonStore`. Absent means silence.
   */
  constructor(
    path: string,
    onError: (error: Error) => void = () => {},
    onProblem?: (message: string) => void,
  ) {
    this.#path = path
    this.#onError = onError
    this.#onProblem = onProblem
  }

  /**
   * Load on first use.
   *
   * Absent: no card has been materialised yet, which is the correct first-run
   * state and the state every existing profile is in. Unparsable is a different
   * matter and now says so — this table is the only record of which named book
   * a card's embedded one became, and reading it as empty makes the next open
   * materialise a second copy under a fresh name.
   */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    const parsed = await readJsonStore(this.#path, this.#onProblem)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      this.#bindings = parsed as Bindings
    }
  }

  /**
   * One character's binding.
   * @param characterId - whose card.
   * @returns the binding, or undefined when the card was never materialised.
   */
  async get(characterId: string): Promise<MaterialisedBinding | undefined> {
    await this.#load()
    const stored = this.#bindings[characterId]
    return stored === undefined ? undefined : { ...stored }
  }

  /**
   * Every binding, for collision checks.
   * @returns a copy of the whole table.
   */
  async all(): Promise<Bindings> {
    await this.#load()
    return Object.fromEntries(Object.entries(this.#bindings).map(([id, row]) => [id, { ...row }]))
  }

  /**
   * Record what was materialised.
   * @param characterId - whose card.
   * @param binding - the new record.
   */
  async set(characterId: string, binding: MaterialisedBinding): Promise<void> {
    await this.#load()
    this.#bindings[characterId] = { ...binding }
    await this.#save()
  }

  /**
   * Drop a character's binding.
   *
   * The book itself is left alone: the user may have edited it, and a card
   * being removed is not a statement about their world info.
   * @param characterId - whose card.
   */
  async forget(characterId: string): Promise<void> {
    await this.#load()
    if (this.#bindings[characterId] === undefined) return
    delete this.#bindings[characterId]
    await this.#save()
  }

  async #save(): Promise<void> {
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await atomicWriteFile(this.#path, `${JSON.stringify(this.#bindings, null, 2)}\n`)
    } catch (error: unknown) {
      this.#onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/** Stable text for a value, key order and array order preserved but keys sorted. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}

/** Sha-256 of a string, hex. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The hash that answers "has the card's embedded book changed?".
 *
 * **Two fields are excluded, and both for one reason: the parser assigns them
 * from array position, not from anything the author wrote.** `uid` differs
 * between two copies of identical content, and `displayIndex` follows whatever
 * order the entries happen to sit in. Including either would make moving an
 * entry — which changes nothing about assembly — read as new content, and a
 * false "the card changed" is not harmless: it is what decides whether a book
 * is rewritten, and a rewrite is what a user's own edits stand in front of.
 *
 * `order` is **not** excluded. It looks like the same kind of field and is not:
 * it decides where an entry lands in the prompt, so changing it is a real
 * change and has to be seen as one.
 * @param book - the card's `character_book`.
 * @returns a stable hash of its meaning.
 */
export function embeddedHash(book: unknown): string {
  const parsed = fromCharacterBook(book)
  const entries = Object.values(parsed.entries)
    .map(entry => {
      const { uid: _uid, displayIndex: _displayIndex, ...rest } = entry as Record<string, unknown>
      return canonical(rest)
    })
    .sort()
  return sha256(entries.join('\n'))
}

/** What a materialisation did, for the caller to report and record. */
export interface MaterialiseResult {
  /** The book the card's world info now comes from. */
  name: string
  /** Sentences worth telling a human; empty on the ordinary path. */
  reports: string[]
}

/**
 * Give one card's embedded book a home, without ever overwriting another's.
 *
 * The four states this has to tell apart, and why the last one speaks:
 *
 * | card changed | user edited | what happens |
 * | --- | --- | --- |
 * | no | no | nothing |
 * | no | yes | nothing — **the user's book is authoritative**, the embedded one was a seed |
 * | yes | no | re-materialise silently; no one's work is lost |
 * | yes | **yes** | keep the user's book, **and say so** |
 *
 * The last row is the whole point: the card's author changed the book and so did
 * the user, both legitimately, and merging automatically would betray both. The
 * report matters because the symptom of silently keeping the user's version —
 * "I updated the card and the new content never appeared" — is indistinguishable
 * from an update that failed.
 * @param characterId - whose card.
 * @param card - the card, for its embedded book and bound name.
 * @param worldbooks - where named books live.
 * @param bindings - what has been materialised before.
 * @returns the bound name and anything worth reporting, or undefined when the
 * card has no embedded book to materialise.
 */
export async function materialiseEmbeddedBook(
  characterId: string,
  card: CharacterCard | undefined,
  worldbooks: WorldbookStore,
  bindings: WorldbookBindingStore,
  stInstall?: StInstall,
): Promise<MaterialiseResult | undefined> {
  const embedded = card?.data.character_book
  if (embedded === undefined) return undefined

  let entries
  try {
    entries = Object.values(fromCharacterBook(embedded).entries).map(toWorldbookEntry)
  } catch {
    // A book this build cannot read is a reason to play the character without
    // it, not a reason to refuse the card.
    return undefined
  }
  if (entries.length === 0) return undefined

  const reports: string[] = []
  const sourceHash = embeddedHash(embedded)
  const existing = await bindings.get(characterId)

  if (existing !== undefined) {
    // A seed can be replaced by the real book the moment it becomes reachable —
    // the user's own copy outranks the one the card carried. Only a seed: a
    // book already imported from SillyTavern, or one the user made, is not
    // re-fetched behind their back.
    if (existing.origin === 'seeded-from-embedded' && stInstall?.configured === true) {
      const upgraded = await upgradeFromSt(characterId, existing, worldbooks, bindings, stInstall)
      if (upgraded !== undefined) return upgraded
    }
    if (existing.sourceHash === sourceHash) return { name: existing.name, reports }

    // The card changed. Whether we may rewrite the book depends on one
    // question only: is the file still byte-for-byte what we wrote?
    const current = await worldbooks.readRaw(existing.name)
    const untouched = current !== undefined
      && sha256(JSON.stringify(current, null, 2)) === existing.materialisedHash

    if (!untouched) {
      reports.push(
        `the embedded world book of "${card?.data.name ?? characterId}" has been updated, but you have`
        + ` edited the book "${existing.name}" it was materialised into, so it was left as it is`,
      )
      return { name: existing.name, reports }
    }

    const text = await rewrite(worldbooks, existing.name, entries)
    await bindings.set(characterId, {
      name: existing.name,
      sourceHash,
      materialisedHash: sha256(text),
      origin: existing.origin,
      at: Date.now(),
    })
    return { name: existing.name, reports }
  }

  // First materialisation. The wanted name is the card's own, so that this host
  // and SillyTavern end up pointing at a book of the same name for the same
  // card — most cards already carry the name their embedded book *should* have,
  // which is SillyTavern's post-materialisation state recorded in the card.
  const wanted = charWorldbookNames(card).primary
    ?? (isRecord(embedded) && typeof embedded['name'] === 'string' && embedded['name'] !== ''
      ? embedded['name']
      : `${card?.data.name ?? characterId}'s Lorebook`)

  const taken = new Set(await worldbooks.names())
  const ownedByOthers = new Set(
    Object.entries(await bindings.all())
      .filter(([id]) => id !== characterId)
      .map(([, row]) => row.name),
  )

  let name = wanted
  if (taken.has(wanted) || ownedByOthers.has(wanted)) {
    // **Never overwrite a book this card did not materialise.** The link between
    // card and book is the binding table, not the filename, so the name is the
    // thing that can give way — a collision costs a suffix, not a book.
    name = uniqueName(wanted, taken, ownedByOthers)
    reports.push(
      `"${wanted}" is already the name of another world book, so the embedded book of`
      + ` "${card?.data.name ?? characterId}" was materialised as "${name}" instead`,
    )
  } else if (charWorldbookNames(card).primary !== null && stInstall?.configured !== true) {
    // The card names a book that did not travel with it. Seeding from the
    // embedded copy is the best available guess — it is what SillyTavern would
    // have materialised too — but the user may hold the real one.
    //
    // **Only when no install is configured.** With one configured, the fetch
    // below reports the same situation with more in it — it can say the book
    // is not in the install *either*. Emitting both was measured on a real
    // import: two sentences about one fact, the second strictly better. A
    // diagnostic channel that repeats itself trains its reader to skim.
    reports.push(
      `"${wanted}" is named by the card but was not imported with it, so Iris seeded that book from`
      + ' the card\'s embedded copy; importing the original book will take precedence',
    )
  }

  // The real book first, the seed only if it cannot be had. A card's embedded
  // copy is what the card's author shipped; the book in the user's install is
  // what the user has been playing with.
  const fetched = stInstall === undefined ? undefined : await stInstall.book(wanted)
  if (fetched?.found === true && name === wanted) {
    const real = entriesOf(fetched.book)
    if (real !== undefined) {
      const written = await worldbooks.create(name, real)
      await bindings.set(characterId, {
        name,
        sourceHash,
        materialisedHash: sha256(written),
        origin: 'imported-from-st',
        at: Date.now(),
      })
      return {
        name,
        reports: [`"${name}" was taken from your SillyTavern installation rather than from the card's embedded copy`],
      }
    }
  }
  if (fetched !== undefined && !fetched.found) reports.push(fetchNote(wanted, fetched.why))

  const text = await worldbooks.create(name, entries)
  await bindings.set(characterId, {
    name,
    sourceHash,
    materialisedHash: sha256(text),
    origin: name !== wanted
      ? 'minted'
      : charWorldbookNames(card).primary !== null ? 'seeded-from-embedded' : 'card-name',
    at: Date.now(),
  })
  return { name, reports }
}

/**
 * Read a SillyTavern book file into entries this host can write.
 * @param book - the raw saved object.
 * @returns the entries, or undefined when the file is not a book.
 */
function entriesOf(book: unknown): WorldbookEntry[] | undefined {
  try {
    return Object.values(parseLorebook(book).entries).map(toWorldbookEntry)
  } catch {
    return undefined
  }
}

/**
 * What to tell a user when the named book could not be fetched.
 *
 * **Three kinds of "not there", kept apart because only one has an action and
 * one of them may succeed next time.** Collapsing them would send someone
 * hunting for a book they actually have.
 * @param name - the book the card named.
 * @param why - which kind of nothing this was.
 * @returns the sentence to report.
 */
function fetchNote(name: string, why: FetchFailure): string {
  if (why === 'not-configured') {
    return `"${name}" is named by the card but was not imported with it; if you have a SillyTavern`
      + ' installation, point Iris at it and reopen this chat to use the real book'
  }
  if (why === 'unreadable') {
    return `"${name}" exists in your SillyTavern installation but could not be read this time`
      + ' (SillyTavern may be writing it); the card is using its embedded copy for now'
  }
  return `"${name}" is named by the card and is not in your SillyTavern installation either;`
    + ' the card is using its embedded copy'
}

/**
 * Replace a seed with the real book, when the user has not edited the seed.
 * @param characterId - whose card.
 * @param existing - the binding recording the seed.
 * @param worldbooks - where named books live.
 * @param bindings - the binding table.
 * @param stInstall - the user's installation.
 * @returns the result when something was done, undefined to fall through.
 */
async function upgradeFromSt(
  characterId: string,
  existing: MaterialisedBinding,
  worldbooks: WorldbookStore,
  bindings: WorldbookBindingStore,
  stInstall: StInstall,
): Promise<MaterialiseResult | undefined> {
  const fetched = await stInstall.book(existing.name)
  if (!fetched.found) return undefined

  const current = await worldbooks.readRaw(existing.name)
  const untouched = current !== undefined
    && sha256(JSON.stringify(current, null, 2)) === existing.materialisedHash
  if (!untouched) {
    // The same two-legitimate-claims case as a card update: the user has worked
    // on the copy we seeded, so the install's version is not more authoritative
    // than theirs — it is merely different. Keep theirs, and say so.
    return {
      name: existing.name,
      reports: [
        `"${existing.name}" is now available from your SillyTavern installation, but you have edited`
        + ' the copy Iris seeded from the card, so it was left as it is',
      ],
    }
  }

  const real = entriesOf(fetched.book)
  if (real === undefined) return undefined

  await worldbooks.replace(existing.name, real)
  const written = await worldbooks.readRaw(existing.name)
  await bindings.set(characterId, {
    ...existing,
    materialisedHash: sha256(JSON.stringify(written, null, 2)),
    origin: 'imported-from-st',
    at: Date.now(),
  })
  return {
    name: existing.name,
    reports: [
      `"${existing.name}" was replaced with the copy from your SillyTavern installation;`
      + ' Iris had seeded it from the embedded copy the card carried',
    ],
  }
}

/** Replace a book's contents, returning exactly the bytes written. */
async function rewrite(
  worldbooks: WorldbookStore,
  name: string,
  entries: readonly WorldbookEntry[],
): Promise<string> {
  await worldbooks.replace(name, entries)
  const written = await worldbooks.readRaw(name)
  return JSON.stringify(written, null, 2)
}

/** `name (2)`, `name (3)`, … until one is free. */
function uniqueName(wanted: string, taken: Set<string>, owned: Set<string>): string {
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${wanted} (${String(suffix)})`
    if (!taken.has(candidate) && !owned.has(candidate)) return candidate
  }
  // A thousand books of one name is not a case worth a cleverer scheme; a
  // timestamp is unique enough and still readable.
  return `${wanted} (${String(Date.now())})`
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
