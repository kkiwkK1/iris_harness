/**
 * The character library on disk.
 *
 * Cards are stored as the files they arrived as — a PNG stays a PNG — rather
 * than unpacked into a normalized record. That is what makes the library
 * interoperable: the folder can be copied straight into a SillyTavern install
 * and back, and no field is lost to a schema Iris happens to model today.
 *
 * @module @iris/app-service/library
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

import { CharacterCardError, decodeCardPng, mutateCardPng, normalizeCard, readCardChunks, type CharacterCard } from '@iris/character'
import type { CharacterSummary } from '@iris/protocol'
import { extractScripts } from '@iris/script'
import type { RegexScript } from '@iris/regex'

import { AppError, invalid, notFound } from './errors.ts'
import { fileFor, toId, uniqueId } from './paths.ts'

/** Card file extensions the library stores. */
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.json'] as const

/**
 * The extensions that carry a picture the avatar route can serve.
 *
 * A `.json` card has no image of its own; everything else in {@link EXTENSIONS}
 * does. See DEVIATIONS §18 for where the JPEG half comes from.
 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

/**
 * How much of a card's description a summary carries, in code points.
 *
 * The protocol's field documents the choice; this is where it is enforced. It
 * is a clip on the normal case rather than a safety valve: of the 19 local
 * cards, 15 have no description at all, and all four that do are longer than
 * this — 730, 779, 1744 and 2851 code points.
 */
const DESCRIPTION_POINTS = 200

/** One card file. */
export interface CardFileRef {
  characterId: string
  path: string
  extension: string
  /** The file's last modification, Unix epoch milliseconds, when it could be read. */
  updatedAt?: number
  /**
   * The file's length in bytes, when it could be read.
   *
   * Beside the mtime because the two together are what {@link
   * CharacterLibrary.list} recognises an unchanged file by — see the summary
   * cache for why one of them alone is not enough.
   */
  size?: number
}

/** One card file's summary, held against the stamp it was decoded from. */
interface HeldSummary {
  mtimeMs: number
  size: number
  summary: CharacterSummary
}

/** Reads and writes the character folder. */
export class CharacterLibrary {
  readonly #dir: string
  readonly #avatarBase: string

  /**
   * One summary per card file, keyed by path, held against its file stamp.
   *
   * **This exists because `list()` is on the hot path of every card script.**
   * `script.context` carries `characters` — upstream's `getContext().characters`
   * — so a listing happens on every snapshot, and a snapshot happens once per
   * script frame per turn. Measured on the operator's own profile (13 cards,
   * 50 MB of card PNGs): a listing costs **1737 ms**, of which 28 ms is reading
   * the files and the rest is decoding them — PNG chunk walk, base64, JSON
   * parse, V1 lift — to produce **3.2 KiB** of summaries. A page that showed 22
   * message rows paid that 22 times over, and the host is single-threaded, so
   * the 22nd row waited for all of them.
   *
   * **What a hit is checked against.** The path plus mtime plus size, and both
   * halves of the stamp are load-bearing: Windows stamps a write with the system
   * clock, whose granularity is ~15.6 ms, so two writes inside one tick can
   * share an mtime — and a rename from one 4-character name to another leaves
   * the size unchanged. Neither alone is a safe identity, which is also why the
   * library **forgets a path it writes to itself** ({@link
   * CharacterLibrary.#forget}) rather than trusting the stamp to notice.
   *
   * A file edited by something other than this process is caught by the stamp.
   * A file rewritten by another process to the same length inside the same
   * clock tick is not, and that is the one case this cache can be wrong about;
   * it is the same window `refs()`'s own mtime already has.
   */
  readonly #summaries = new Map<string, HeldSummary>()

  /**
   * @param dir - the folder holding card files.
   * @param avatarBase - pathname prefix the avatar route is served at.
   */
  constructor(dir: string, avatarBase: string) {
    this.#dir = dir
    this.#avatarBase = avatarBase
  }

  /**
   * Drop what is held about one card file.
   *
   * Called from every path in this class that writes or removes a file, because
   * the file stamp cannot be relied on to notice a write this process just made
   * — see {@link CharacterLibrary.#summaries} for the two ways it misses one.
   * @param path - the file that was written.
   */
  #forget(path: string): void {
    this.#summaries.delete(resolve(path))
  }

  /** Create the folder if this is a first run. */
  async ensure(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
  }

  /**
   * Every card file in the folder.
   *
   * Each file's mtime rides along: the recency a "sort by updated" needs is a
   * property of the file, and the listing is the one place every row's file is
   * already being touched.
   * @returns one entry per card, sorted by id.
   */
  async refs(): Promise<CardFileRef[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      return []
    }
    const rows = await Promise.all(names
      .filter(name => (EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase()))
      .map(async name => {
        const ref: CardFileRef = {
          characterId: name.slice(0, name.length - extname(name).length),
          path: `${this.#dir}/${name}`,
          extension: extname(name).toLowerCase(),
        }
        try {
          const stamp = await stat(ref.path)
          ref.updatedAt = stamp.mtimeMs
          ref.size = stamp.size
        } catch {
          // The listing tolerates a file vanishing mid-walk; the timestamp is
          // optional and a sort can fall back for the row that lost the race.
          // The size goes with it: a ref with half a stamp is not one the
          // summary cache will answer from.
        }
        return ref
      }))
    return rows.sort((a, b) => a.characterId.localeCompare(b.characterId))
  }

  /**
   * Which ids a new card may not take, compared without regard to case.
   *
   * An id is a filename, and two of the three desktop filesystems fold case:
   * on Windows and macOS `Aria.json` and `aria.json` are **one file**, so an id
   * that differs from an existing one only by case would overwrite that card
   * on those systems and sit beside it on Linux. `toId` keeps the name's case
   * (a card called "Aria" is `Aria`, as upstream keeps the avatar filename), so
   * the uniqueness check is where the folding has to happen. The first test
   * that caught this passed on every Windows machine and failed on every Linux
   * runner: it deleted `aria`, imported "Aria", and asked for `aria` again.
   * @returns a predicate for {@link uniqueId}.
   */
  async #takenIds(): Promise<(id: string) => boolean> {
    const lowered = new Set((await this.refs()).map(ref => ref.characterId.toLowerCase()))
    return id => lowered.has(id.toLowerCase())
  }

  /**
   * Locate one card file.
   * @param characterId - the id from the request.
   * @returns the file reference.
   * @throws {AppError} `not-found` when no card has that id.
   */
  async ref(characterId: string): Promise<CardFileRef> {
    for (const extension of EXTENSIONS) {
      const path = fileFor(this.#dir, characterId, extension)
      try {
        await readFile(path)
        const ref: CardFileRef = { characterId, path, extension }
        try {
          ref.updatedAt = (await stat(path)).mtimeMs
        } catch {
          // The read above proved the file exists; a stat failing in the same
          // window is the vanishing-mid-walk case, and the field is optional.
        }
        return ref
      } catch {
        continue
      }
    }
    throw notFound(`no character "${characterId}"`)
  }

  /**
   * Read one card.
   * @param characterId - the id from the request.
   * @returns the normalized card.
   * @throws {AppError} `not-found` when it is missing, `internal` when unreadable.
   */
  async load(characterId: string): Promise<CharacterCard> {
    const ref = await this.ref(characterId)
    const bytes = await readFile(ref.path)
    return decode(bytes, ref.extension)
  }

  /**
   * The raw bytes of a card file, for the avatar route.
   * @param characterId - the id from the request.
   * @returns the file's bytes and the extension they came from.
   * @throws {AppError} `not-found` when it is missing.
   */
  async bytes(characterId: string): Promise<{ data: Buffer, extension: string }> {
    const ref = await this.ref(characterId)
    return { data: await readFile(ref.path), extension: ref.extension }
  }

  /**
   * The whole library as the browser sees it.
   *
   * A card that fails to parse is skipped rather than failing the listing: one
   * corrupt file in the folder must not make the library unopenable.
   * @returns one summary per readable card.
   */
  async list(): Promise<CharacterSummary[]> {
    const summaries: CharacterSummary[] = []
    for (const ref of await this.refs()) {
      const summary = await this.#summaryOf(ref)
      if (summary !== undefined) summaries.push(summary)
    }
    return summaries
  }

  /**
   * One card's summary, decoded only if the file has moved since last time.
   *
   * The whole cost of a listing is here — see {@link
   * CharacterLibrary.#summaries} for the measurement and for what a hit is
   * checked against.
   *
   * A card that fails to decode is **not** held: the skip is the listing's
   * decision, not a fact about the file, and a corrupt file is cheap to refuse
   * again (the PNG signature check throws on the first bytes). Holding the
   * failure would also mean holding a decision that a later reader of this
   * cache would have to know to interpret.
   *
   * **The key is `resolve`d, and that is not decoration.** This class spells the
   * same file two ways — `refs()` builds `${dir}/${name}`, while `fileFor` (and
   * therefore `ref()`, and therefore every write path) returns a `resolve`d
   * path, which on Windows means backslashes. Keyed on the raw string, a hit was
   * simply never found from the listing side and `#forget` never deleted
   * anything: the first cut of this cache served a renamed card's *old* name for
   * the life of the process, and `library-cache.test.ts` is the test that caught
   * it.
   * @param ref - the card file, with the stamp `refs()` read.
   * @returns the summary, or `undefined` when the file is not a readable card.
   */
  async #summaryOf(ref: CardFileRef): Promise<CharacterSummary | undefined> {
    const { updatedAt, size } = ref
    const key = resolve(ref.path)
    const stamped = updatedAt !== undefined && size !== undefined
    if (stamped) {
      const held = this.#summaries.get(key)
      if (held !== undefined && held.mtimeMs === updatedAt && held.size === size) return held.summary
    }
    let card: CharacterCard
    try {
      card = decode(await readFile(ref.path), ref.extension)
    } catch {
      return undefined
    }
    const summary = this.summarize(ref, card)
    // Only a fully stamped ref is held. A file that lost the `stat` race has no
    // identity to check a later hit against, and a cache entry with a made-up
    // stamp would answer for a file it cannot recognise.
    if (stamped) this.#summaries.set(key, { mtimeMs: updatedAt, size, summary })
    return summary
  }

  /**
   * Project one card onto its library entry.
   *
   * The three optional facts about a card's *contents* — a clipped description,
   * the embedded book's entry count, the script count — are filled here rather
   * than in a second pass, because this is already the one place holding a
   * decoded card, and every one of them is derived from what is in hand. See
   * `CharacterSummary` for why they are a string and two integers and not the
   * things they count.
   * @param ref - where the card lives.
   * @param card - the parsed card.
   * @returns the wire summary.
   */
  summarize(ref: CardFileRef, card: CharacterCard): CharacterSummary {
    const creator = card.data.creator
    const description = clipDescription(card.data.description)
    const book = card.data.character_book
    /*
     * Through the real extractor, never a walk of `extensions.tavern_helper`.
     * Scripts live under two keys in three shapes, and the count a page shows
     * has to be the count the script panel lists — one derivation, one number.
     *
     * Cheap where it is called from: `extractScripts` reads the card object it
     * is handed and opens no file, so the whole cost is walking the script
     * array. Measured on the 19-card corpus through `list()`, which decodes
     * every card: 2102 ms median before this field existed, 2122 and 2121 ms
     * over two runs after (5 rounds each, same process shape) — a 1.01x ratio,
     * inside the run-to-run spread of the decode it rides on.
     */
    const scripts = extractScripts(card).scripts.length
    return {
      characterId: ref.characterId,
      name: card.data.name.length > 0 ? card.data.name : ref.characterId,
      // Only an image carries a picture; a `.json` card has none to serve.
      ...(IMAGE_EXTENSIONS as readonly string[]).includes(ref.extension)
        ? { avatarUrl: `${this.#avatarBase}/${encodeURIComponent(ref.characterId)}` }
        : {},
      tags: card.data.tags,
      ...creator.length > 0 ? { creator } : {},
      ...ref.updatedAt === undefined ? {} : { updatedAt: ref.updatedAt },
      ...description.length > 0 ? { description } : {},
      // Present for an empty book, absent for no book: the protocol keeps those
      // two apart on purpose, and `normalizeBook` guarantees `entries` is an
      // array whenever the card carried a book object at all.
      ...book === undefined ? {} : { bookEntryCount: book.entries.length },
      // Absent for none, matching every other optional field on the summary.
      ...scripts > 0 ? { scriptCount: scripts } : {},
    }
  }

  /**
   * Store an uploaded card.
   *
   * The bytes are parsed before anything is written: a file that is neither a
   * card nor a card-less image should be refused, not left in the folder to
   * fail every later listing. A card-less image imports as an empty character
   * whose id — and therefore whose display name — comes from the filename.
   * @param filename - the name the browser uploaded it under.
   * @param base64 - the file's contents.
   * @returns the stored card's summary.
   * @throws {AppError} `invalid-request` for an unreadable file, `unsupported`
   *   for a format this build cannot open.
   */
  async import(filename: string, base64: string): Promise<CharacterSummary> {
    const extension = extname(filename).toLowerCase()
    if (extension === '.charx') {
      // A V3 `.charx` is a zip, and no zip reader is bundled yet.
      throw new AppError('unsupported', '.charx cards are not supported yet')
    }
    if (!(EXTENSIONS as readonly string[]).includes(extension)) {
      throw invalid(`"${filename}" is not a .png, .jpg or .json character card`)
    }

    let bytes: Buffer
    try {
      bytes = Buffer.from(base64, 'base64')
    } catch {
      throw invalid('the uploaded card is not valid base64')
    }
    const card = decode(bytes, extension)

    await this.ensure()
    const taken = await this.#takenIds()
    const characterId = uniqueId(toId(card.data.name.length > 0 ? card.data.name : filename), taken)
    const path = fileFor(this.#dir, characterId, extension)
    await writeFile(path, bytes)
    // The id is unique against the cards that exist, so there should be nothing
    // held under this path — but the rule is "a write forgets its path", and a
    // rule with an exception for the case that looks safe is how a stale entry
    // gets in.
    this.#forget(path)

    return this.summarize(await this.#refOf(characterId, extension, path), card)
  }

  /**
   * Remove a card.
   * @param characterId - the id from the request.
   * @throws {AppError} `not-found` when no card has that id.
   */
  async delete(characterId: string): Promise<void> {
    const ref = await this.ref(characterId)
    await unlink(ref.path)
    // The same rule, and it earns its keep here: an id freed by a delete is
    // handed to the next card of that name, so the path comes back — with a
    // different card behind it.
    this.#forget(ref.path)
  }

  /**
   * Rename a card, in place.
   *
   * **The id does not move, and that is the whole design.** Upstream's rename
   * (`characters.js` `/rename`) writes the new name into the card *and* renames
   * the avatar file, then moves the chats folder — because upstream's id is the
   * avatar filename and its chats live in per-character folders. Iris's id is
   * load-bearing far beyond the filename: the worldbook binding table, every
   * chat header, the script policy and card storage attribution are keyed by
   * it, and moving it would mean rewriting each of those in one
   * not-atomic-enough pass. So the display name changes and the id stays, which
   * is also what makes the acceptance property trivially hold: a worldbook
   * binding (`data.extensions.world`) is a book *name* used verbatim and is
   * never derived from the character's name — upstream does not touch it on
   * rename either, and neither does the mutation here.
   *
   * The write is **surgical**: the card JSON is mutated in place — `data.name`
   * and, upstream-style, the V1 mirror — and everything else, including fields
   * this build does not model, comes through byte-for-key. A rename that
   * reformatted a card would be a rename with opinions.
   * @param characterId - the card to rename.
   * @param name - the new display name, verbatim.
   * @returns the card's summary under the (unchanged) id.
   * @throws {AppError} `invalid-request` for a blank name, `unsupported` when
   *   the file is a plain image with no card to edit, `not-found` when absent.
   */
  async rename(characterId: string, name: string): Promise<CharacterSummary> {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw invalid('a character needs a name')
    const ref = await this.ref(characterId)
    await this.#mutateCard(ref, raw => {
      if (isRecord(raw.data)) raw.data.name = trimmed
      // Upstream sets both spellings (`_.set(oldData, 'data.name', …)` and
      // `_.set(oldData, 'name', …)`); the V1 mirror is what V1-era readers see.
      raw['name'] = trimmed
      return raw
    })
    return this.summarize(await this.#refOf(ref.characterId, ref.extension, ref.path), await this.load(characterId))
  }

  /**
   * Copy a card file byte-for-byte under a fresh id.
   *
   * Upstream's `/duplicate` is exactly `copyFileSync` under a unique name —
   * no field rewrite, no re-encode — and that is reproduced: the copy carries
   * the same embedded book and the same binding name its source does, which is
   * what makes the two resolve to the *same* named world book, upstream's
   * shared-`extensions.world` semantics. (The binding *table* row is copied by
   * the service, which is the only side that knows about it; the library deals
   * in files.) Chats are not copied — a conversation belongs to the character
   * that played it, not to the file.
   *
   * The fresh id is the source id, re-run through the same normaliser an
   * import uses (`toId`, which also caps the length) and made unique against
   * the cards that exist — the source is taken by definition, so the first
   * candidate carries the `-2` suffix this library already mints. Deriving
   * from the *file* rather than the card's display name also keeps the copy's
   * id stable when a rename later changes what the card is called.
   * @param characterId - the card to copy.
   * @returns the copy's summary, under its new id.
   * @throws {AppError} `not-found` when absent.
   */
  async duplicate(characterId: string): Promise<CharacterSummary> {
    const ref = await this.ref(characterId)
    const card = await this.load(characterId)
    const freshId = uniqueId(toId(characterId), await this.#takenIds())
    const path = fileFor(this.#dir, freshId, ref.extension)
    // Verbatim bytes: the copy is the source card, not a re-encoding of what
    // this build happens to model about it.
    await writeFile(path, await readFile(ref.path))
    this.#forget(path)
    return this.summarize(await this.#refOf(freshId, ref.extension, path), card)
  }

  /**
   * Replace a card's whole tag list.
   *
   * Tags live on the card (`data.tags`), so an edit writes the card — the same
   * surgical mutation a rename uses, with the V1 mirror refreshed only where
   * the file already carries one. The list is replaced whole rather than
   * diffed: add, remove and edit are one writer's three views of the same
   * operation, and a card is too small a document to deserve three code paths.
   * @param characterId - the card to edit.
   * @param tags - the complete new list, in order.
   * @returns the card's summary.
   * @throws {AppError} `unsupported` when the file is a plain image.
   */
  async setTags(characterId: string, tags: readonly string[]): Promise<CharacterSummary> {
    const ref = await this.ref(characterId)
    const fresh = [...tags]
    await this.#mutateCard(ref, raw => {
      if (isRecord(raw.data)) raw.data.tags = [...fresh]
      // The top-level mirror is refreshed only when the file carries one:
      // inventing a V1 mirror on a V2 card writes a field nobody's reader
      // needs, while leaving a stale one would leave two disagreeing lists.
      if (Array.isArray(raw['tags'])) raw['tags'] = [...fresh]
      return raw
    })
    return this.summarize(await this.#refOf(ref.characterId, ref.extension, ref.path), await this.load(characterId))
  }

  // —— family②: regex ——
  /**
   * Replace a card's own regex tier, in the card.
   *
   * This tier lives in the document (`data.extensions.regex_scripts`), so a
   * write is a write to the card file — the same surgical mutation a rename and
   * a tag edit use. Upstream does exactly this and by the same route:
   * `replaceTavernRegexes` ends in `writeExtensionField(id, 'regex_scripts',
   * converted)` (`src/function/tavern_regex.ts:288`/`:324`), which rewrites the
   * character.
   *
   * **Wholesale**, as upstream is: the array replaces the stored list, so a
   * rule absent from it is gone. No V1 mirror is touched, because the field has
   * never had one — `extensions` is a V2 concept.
   *
   * **No `regex_scripts` key is created for an empty list on a card that had
   * none.** Absent and empty read the same to every reader of this field
   * (`scriptsOf` tests `Array.isArray`), and writing `[]` into a card that
   * carried nothing would change the document's bytes — and therefore its
   * export — to say the same thing it already said.
   * @param characterId - the card to edit.
   * @param scripts - the complete new tier, in run order.
   * @throws {AppError} `unsupported` when the file is a plain image.
   */
  async setScopedRegex(characterId: string, scripts: readonly RegexScript[]): Promise<void> {
    const ref = await this.ref(characterId)
    const fresh = scripts.map(script => ({ ...script }))
    await this.#mutateCard(ref, raw => {
      if (!isRecord(raw.data)) return raw
      if (!isRecord(raw.data.extensions)) {
        if (fresh.length === 0) return raw
        raw.data.extensions = {}
      }
      const extensions = raw.data.extensions
      if (!isRecord(extensions)) return raw
      if (fresh.length === 0 && extensions['regex_scripts'] === undefined) return raw
      extensions['regex_scripts'] = fresh
      return raw
    })
  }

  /**
   * Take a card out of the library, as a file another front-end can read.
   *
   * A PNG goes out as the stored PNG with its card chunks rewritten in place;
   * a `.json` card as pretty-printed JSON. Either way the card is **the card as
   * stored**, with one exception copied from upstream's export endpoint
   * (`characters.js` `/export`, `unsetPrivateFields`): the favourite flag is
   * cleared in both spellings and the last-open-chat pointer `chat` is removed,
   * because both are runtime state that has no business travelling with a card
   * another person imports. Iris never writes those fields itself, but a card
   * imported from a SillyTavern install may arrive carrying them.
   *
   * Unlike upstream's JSON arm, the card is **not** lifted through a V2
   * conversion first: the stored shape goes out as it is, so a V3 card stays
   * V3 and an unknown field survives the trip. Everything that reaches this
   * function was read through the same parser the import path uses, so what
   * goes out re-imports to the same card — the acceptance that matters.
   * @param characterId - the card to export.
   * @param format - `png` for the image with its card chunks, `json` for the
   *   card body alone.
   * @returns the filename to save under and the file's bytes, base64.
   * @throws {AppError} `unsupported` when the format and the file disagree —
   *   a `.json` card has no pixels to stamp a chunk into, and a plain image
   *   has no card to export.
   */
  async exportCard(characterId: string, format: 'png' | 'json'): Promise<{ filename: string, content: string }> {
    const ref = await this.ref(characterId)
    if (ref.extension === '.jpg' || ref.extension === '.jpeg') {
      // An image without a card is an empty character only inside this
      // library's own convention; exported, it would be a picture pretending
      // to be a character. Refusing names the situation instead.
      throw new AppError('unsupported', `"${characterId}" is a plain image and carries no card to export`)
    }
    if (format === 'png') {
      if (ref.extension !== '.png') {
        throw new AppError('unsupported', `"${characterId}" is a .json card; it has no image to export as PNG`)
      }
      const bytes = await readFile(ref.path)
      const exported = mutateCardPng(bytes, raw => (unsetPrivateFields(raw), raw))
      return { filename: `${ref.characterId}.png`, content: Buffer.from(exported).toString('base64') }
    }
    const raw = await this.#rawCardJson(ref)
    unsetPrivateFields(raw)
    return { filename: `${ref.characterId}.json`, content: JSON.stringify(raw, null, 4) }
  }

  /**
   * One card file, freshly described.
   * @param characterId - the id just minted or found.
   * @param extension - the file's extension, dot included.
   * @param path - the file's path.
   * @returns the reference, with the mtime the write just set.
   */
  async #refOf(characterId: string, extension: string, path: string): Promise<CardFileRef> {
    const ref: CardFileRef = { characterId, path, extension }
    try {
      ref.updatedAt = (await stat(path)).mtimeMs
    } catch {
      // The write above just created it; a stat failing here is the same
      // tolerate-and-move-on case the listing handles.
    }
    return ref
  }

  /**
   * Mutate one card file's card JSON, touching nothing else.
   *
   * The one write path for manager operations, so their shape stays uniform:
   * the PNG's card chunks are rewritten in place by `mutateCardPng`, a `.json`
   * card is rewritten compact the way upstream writes cards, and a plain image
   * is refused — there is nothing in it to edit, and a silent no-op would let
   * a rename report success while the list kept showing the old name.
   * @param ref - which file to rewrite.
   * @param mutate - applied to the parsed card JSON; the record is mutated in
   *   place and returned.
   */
  async #mutateCard(
    ref: CardFileRef,
    mutate: (raw: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    /*
     * Forgotten **after** the write, whatever the write did, which is why this
     * is a `finally` and not a line at the top. Dropping the entry first would
     * leave a window: a listing that ran between the drop and the write would
     * decode the old card and hold it under the old stamp, and if the rewrite
     * left the file the same length inside one clock tick — a rename between
     * two equally long names — nothing afterwards would ever look again.
     */
    try {
      if (ref.extension === '.png') {
        const bytes = await readFile(ref.path)
        await writeFile(ref.path, mutateCardPng(bytes, mutate))
        return
      }
      if (ref.extension === '.json') {
        let raw: unknown
        try {
          raw = JSON.parse(await readFile(ref.path, 'utf8'))
        } catch {
          throw invalid('could not read the character card: the file is not valid JSON')
        }
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw invalid('could not read the character card: the file is not a JSON object')
        }
        await writeFile(ref.path, JSON.stringify(mutate(raw as Record<string, unknown>)))
        return
      }
      throw new AppError('unsupported', `"${ref.characterId}" is a plain image and carries no card to edit`)
    } finally {
      this.#forget(ref.path)
    }
  }

  /**
   * One card's raw JSON, as stored.
   *
   * For a PNG that is the authoritative chunk's payload (`ccv3` first, the
   * same precedence the reader uses); for a `.json` card, the file itself.
   * @param ref - which file to read.
   */
  async #rawCardJson(ref: CardFileRef): Promise<Record<string, unknown>> {
    if (ref.extension === '.json') {
      const raw: unknown = JSON.parse(await readFile(ref.path, 'utf8'))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw invalid('could not read the character card: the file is not a JSON object')
      }
      return raw as Record<string, unknown>
    }
    const chunks = readCardChunks(await readFile(ref.path))
    const payload = chunks.ccv3 ?? chunks.chara
    if (payload === undefined) {
      throw new AppError('unsupported', `"${ref.characterId}" carries no character card chunk`)
    }
    const raw: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw invalid('the character card chunk does not contain a JSON object')
    }
    return raw as Record<string, unknown>
  }
}

/**
 * Upstream's `unsetPrivateFields` (`characters.js:498`), spelled out.
 *
 * `fav` is cleared in both spellings because upstream's own writer has carried
 * it at the top level, under `data`, and — from the edit form — as the string
 * `"true"`; `chat` is the install's last-open pointer for this character and
 * means nothing anywhere else.
 * @param raw - the card JSON, mutated in place.
 */
function unsetPrivateFields(raw: Record<string, unknown>): void {
  raw['fav'] = false
  if (isRecord(raw.data)) {
    if (isRecord(raw.data.extensions)) raw.data.extensions['fav'] = false
    // `_.set` creates the path upstream; an extensions bag holding only this
    // is what its absence-plus-clearing produces there too.
    else raw.data.extensions = { fav: false }
  }
  delete raw['chat']
}

/**
 * Clip a card's description to what a summary carries.
 *
 * Iterated as code points (`[...text]` walks the string's iterator, not its
 * UTF-16 units), so a clip landing in the middle of an astral character —
 * emoji, and the rarer CJK ideographs that live above the BMP — never emits a
 * lone surrogate. A lone surrogate is not an error anywhere downstream: it
 * clones, it serialises, and it renders as `�` — for whichever card happens to
 * put an astral character on the boundary. No local card does, which is why the
 * discriminating case in `tests/library-summary.test.ts` is synthetic: the
 * corpus test passes against a UTF-16 clip and cannot see this.
 *
 * A string short enough is returned unchanged rather than round-tripped through
 * the array, which is also the common case: most cards carry no description at
 * all.
 * @param description - the card's `data.description`, already normalised to a string.
 * @returns at most {@link DESCRIPTION_POINTS} code points of it.
 */
function clipDescription(description: string): string {
  // Cheap pre-check: a code point is at least one UTF-16 unit, so a string with
  // no more units than the limit cannot have more points than the limit.
  if (description.length <= DESCRIPTION_POINTS) return description
  const points = [...description]
  return points.length <= DESCRIPTION_POINTS ? description : points.slice(0, DESCRIPTION_POINTS).join('')
}

/** Whether a value is a plain keyed object rather than an array or primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read card bytes according to the file they came in.
 *
 * An image that parses but carries no card — an SD generation with only a
 * `parameters` tEXt chunk, a plain JPEG — is an **empty character**, not a
 * rejection: the picture is the whole card, the fields start out blank, and the
 * name comes from the file (see {@link CharacterLibrary.import}). Upstream's
 * *import endpoint* refuses both shapes (`No PNG metadata.` / the client's
 * extension gate drops `.jpg` before a request is even made), so this is a
 * recorded divergence, driven by the acceptance corpus: the two card-less PNGs
 * and the JPEG in `测试用卡/` are files the user opens as characters. DEVIATIONS
 * §18 carries the evidence and the boundary.
 *
 * @param bytes - the file contents.
 * @param extension - the file extension, lowercase and dot-included.
 * @returns the normalized card.
 * @throws {AppError} `invalid-request` when the bytes are not the kind of file
 *   the extension claims, or a card chunk that is not base64 JSON.
 */
function decode(bytes: Uint8Array, extension: string): CharacterCard {
  try {
    if (extension === '.png') {
      // `readCardChunks` throws on a corrupt PNG (bad signature, truncated
      // chunk, CRC mismatch) and returns an empty bag when the file is a sound
      // image with no card inside — exactly the split this rule needs.
      const chunks = readCardChunks(bytes)
      return (chunks.ccv3 ?? chunks.chara) === undefined ? emptyCard() : decodeCardPng(bytes)
    }
    if (extension === '.jpg' || extension === '.jpeg') {
      // The one claim we make about a JPEG: that it is one. There is no card
      // payload to read — upstream reads none either, and the corpus JPEG
      // carries none (byte-verified: no COM, no EXIF, no card chunk).
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new Error('not a JPEG: missing the SOI marker')
      }
      return emptyCard()
    }
    return normalizeCard(JSON.parse(Buffer.from(bytes).toString('utf8')))
  } catch (cause: unknown) {
    if (cause instanceof CharacterCardError || cause instanceof Error) {
      throw invalid(`could not read the character card: ${cause.message}`)
    }
    throw invalid('could not read the character card')
  }
}

/**
 * The character an image with no card inside becomes.
 *
 * `normalizeCard({})` is the V1-lift of an empty body — the same shape
 * SillyTavern's character creator writes for a card whose fields were left
 * blank, ST's `charaFormatData` defaults included.
 * @returns a card with every text field empty.
 */
function emptyCard(): CharacterCard {
  return normalizeCard({})
}
