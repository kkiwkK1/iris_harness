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

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { CharacterCardError, decodeCardPng, normalizeCard, readCardChunks, type CharacterCard } from '@iris/character'
import type { CharacterSummary } from '@iris/protocol'

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

/** One card file. */
export interface CardFileRef {
  characterId: string
  path: string
  extension: string
}

/** Reads and writes the character folder. */
export class CharacterLibrary {
  readonly #dir: string
  readonly #avatarBase: string

  /**
   * @param dir - the folder holding card files.
   * @param avatarBase - pathname prefix the avatar route is served at.
   */
  constructor(dir: string, avatarBase: string) {
    this.#dir = dir
    this.#avatarBase = avatarBase
  }

  /** Create the folder if this is a first run. */
  async ensure(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
  }

  /**
   * Every card file in the folder.
   * @returns one entry per card, sorted by id.
   */
  async refs(): Promise<CardFileRef[]> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      return []
    }
    return names
      .filter(name => (EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase()))
      .map(name => ({
        characterId: name.slice(0, name.length - extname(name).length),
        path: `${this.#dir}/${name}`,
        extension: extname(name).toLowerCase(),
      }))
      .sort((a, b) => a.characterId.localeCompare(b.characterId))
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
        return { characterId, path, extension }
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
      let card: CharacterCard
      try {
        card = decode(await readFile(ref.path), ref.extension)
      } catch {
        continue
      }
      summaries.push(this.summarize(ref, card))
    }
    return summaries
  }

  /**
   * Project one card onto its library entry.
   * @param ref - where the card lives.
   * @param card - the parsed card.
   * @returns the wire summary.
   */
  summarize(ref: CardFileRef, card: CharacterCard): CharacterSummary {
    const creator = card.data.creator
    return {
      characterId: ref.characterId,
      name: card.data.name.length > 0 ? card.data.name : ref.characterId,
      // Only an image carries a picture; a `.json` card has none to serve.
      ...(IMAGE_EXTENSIONS as readonly string[]).includes(ref.extension)
        ? { avatarUrl: `${this.#avatarBase}/${encodeURIComponent(ref.characterId)}` }
        : {},
      tags: card.data.tags,
      ...creator.length > 0 ? { creator } : {},
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
    const existing = new Set((await this.refs()).map(ref => ref.characterId))
    const characterId = uniqueId(toId(card.data.name.length > 0 ? card.data.name : filename), id => existing.has(id))
    const path = fileFor(this.#dir, characterId, extension)
    await writeFile(path, bytes)

    return this.summarize({ characterId, path, extension }, card)
  }

  /**
   * Remove a card.
   * @param characterId - the id from the request.
   * @throws {AppError} `not-found` when no card has that id.
   */
  async delete(characterId: string): Promise<void> {
    const ref = await this.ref(characterId)
    await unlink(ref.path)
  }
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
