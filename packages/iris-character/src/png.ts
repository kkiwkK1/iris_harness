/**
 * The PNG `tEXt` codec character cards travel in.
 *
 * A character card PNG is an ordinary image with the card's JSON base64-encoded
 * into a `tEXt` chunk — `chara` for V2, `ccv3` for V3. Everything in this module
 * works on `Uint8Array` and uses only globals that exist in both Node and the
 * browser, so the same code can run in the import dialog later.
 *
 * Chunk framing is implemented here rather than pulled from `png-chunks-extract`
 * / `png-chunk-text`: the format is four fields and a CRC, and a dependency for
 * that would be more surface than substance.
 *
 * Two behaviours are inherited from SillyTavern deliberately:
 *
 *  - **`ccv3` wins over `chara`.** Both are present in every card ST exports and
 *    they carry the same body; the V3 chunk is the authoritative one.
 *  - **Export writes both chunks.** Note that ST's own doc comment on `write()`
 *    claims "'ccv3' is not supported and removed" — that comment is stale, the
 *    code beneath it writes `ccv3`. The code is the spec.
 *
 * @module @iris/character/png
 */

import { normalizeCard, toV2, toV3 } from './card.ts'
import type { CharacterCard } from './types.ts'

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/** Raised when a byte stream is not a PNG we can read or write. */
export class PngError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PngError'
  }
}

/** One PNG chunk, without its length prefix or trailing CRC. */
export interface PngChunk {
  /** The four-character chunk type, e.g. `IHDR`, `tEXt`, `IEND`. */
  readonly type: string
  /** The chunk payload. Empty for `IEND`. */
  readonly data: Uint8Array
}

/** The card-bearing `tEXt` chunks found in a PNG, still base64. */
export interface CardChunks {
  /** Payload of the `chara` chunk — the V2 card. */
  chara?: string
  /** Payload of the `ccv3` chunk — the V3 card. */
  ccv3?: string
}

/**
 * CRC-32/ISO-HDLC lookup table, built once.
 *
 * `Int32Array` rather than `Uint32Array` because the reflected algorithm below
 * works in signed 32-bit space anyway; the single unsigned conversion happens
 * where the value leaves {@link crc32}.
 */
const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

/**
 * The CRC-32 a PNG chunk's trailer carries.
 * @param bytes - the bytes to checksum: chunk type followed by chunk data.
 * @returns the checksum as an unsigned 32-bit integer.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = -1
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

/** Read a big-endian uint32, the only integer encoding PNG uses. */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) << 24 |
      (bytes[offset + 1] as number) << 16 |
      (bytes[offset + 2] as number) << 8 |
      (bytes[offset + 3] as number)) >>> 0
  )
}

/** Write a big-endian uint32 at `offset`. */
function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

/**
 * Decode bytes as Latin-1.
 *
 * `tEXt` is a Latin-1 format, so every byte maps to the code point of the same
 * value. Chunked to keep `String.fromCharCode` off the argument-count limit,
 * which a card's base64 payload would otherwise blow past.
 * @param bytes - the bytes to decode.
 * @returns the decoded string.
 */
function latin1Decode(bytes: Uint8Array): string {
  const pieces: string[] = []
  for (let start = 0; start < bytes.length; start += 8192) {
    pieces.push(String.fromCharCode(...bytes.subarray(start, start + 8192)))
  }
  return pieces.join('')
}

/**
 * Encode a string as Latin-1.
 * @param text - the string to encode; every code point must fit in one byte.
 * @returns the encoded bytes.
 * @throws {PngError} when a code point exceeds U+00FF.
 */
function latin1Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code > 0xff) {
      throw new PngError(`a tEXt chunk cannot carry U+${code.toString(16).toUpperCase()}; it is a Latin-1 format`)
    }
    bytes[index] = code
  }
  return bytes
}

/** Base64 to raw bytes, via the Latin-1 string `atob` returns. */
function base64Decode(text: string): Uint8Array {
  return latin1Encode(atob(text))
}

/** Raw bytes to base64. */
function base64Encode(bytes: Uint8Array): string {
  return btoa(latin1Decode(bytes))
}

/**
 * Split a PNG into its chunks.
 *
 * CRCs are verified, matching SillyTavern's reader: a chunk whose checksum does
 * not match has been corrupted in transit, and a card decoded out of it would
 * be silently wrong rather than loudly absent.
 * @param png - the whole PNG file.
 * @returns the chunks in file order, ending at `IEND`. Bytes after `IEND` are
 *   not chunks and are dropped.
 * @throws {PngError} on a bad signature, a truncated chunk, or a CRC mismatch.
 */
export function parsePngChunks(png: Uint8Array): PngChunk[] {
  if (png.length < PNG_SIGNATURE.length) throw new PngError('not a PNG: too short to hold a signature')
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (png[index] !== PNG_SIGNATURE[index]) throw new PngError('not a PNG: bad file signature')
  }

  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length

  while (offset + 8 <= png.length) {
    const length = readUint32(png, offset)
    const end = offset + 12 + length
    if (end > png.length) throw new PngError(`truncated PNG chunk at byte ${offset}`)

    const type = latin1Decode(png.subarray(offset + 4, offset + 8))
    // The CRC covers the type field as well as the payload, so checksum the
    // two together rather than copying the payload out first.
    const expected = readUint32(png, end - 4)
    const actual = crc32(png.subarray(offset + 4, end - 4))
    if (expected !== actual) throw new PngError(`CRC mismatch in ${type} chunk at byte ${offset}`)

    chunks.push({ type, data: png.slice(offset + 8, offset + 8 + length) })
    if (type === 'IEND') return chunks
    offset = end
  }

  throw new PngError('malformed PNG: no IEND chunk')
}

/**
 * Reassemble chunks into a PNG file.
 * @param chunks - the chunks in file order; the caller owns their ordering,
 *   including that `IHDR` comes first and `IEND` last.
 * @returns the complete PNG bytes.
 */
export function serializePngChunks(chunks: readonly PngChunk[]): Uint8Array {
  let total = PNG_SIGNATURE.length
  for (const chunk of chunks) total += chunk.data.length + 12

  const png = new Uint8Array(total)
  png.set(PNG_SIGNATURE, 0)
  let offset = PNG_SIGNATURE.length

  for (const chunk of chunks) {
    const typeBytes = latin1Encode(chunk.type)
    if (typeBytes.length !== 4) throw new PngError(`chunk type "${chunk.type}" must be exactly four characters`)

    writeUint32(png, offset, chunk.data.length)
    png.set(typeBytes, offset + 4)
    png.set(chunk.data, offset + 8)

    // Checksum the freshly written type+data rather than the sources, so the
    // CRC can only ever describe the bytes that actually landed.
    const end = offset + 8 + chunk.data.length
    writeUint32(png, end, crc32(png.subarray(offset + 4, end)))
    offset = end + 4
  }

  return png
}

/**
 * Build a `tEXt` chunk.
 * @param keyword - the keyword, 1–79 Latin-1 bytes and no NUL.
 * @param text - the value.
 * @returns the chunk, ready for {@link serializePngChunks}.
 * @throws {PngError} when the keyword breaks the PNG specification's limits.
 */
export function encodeTextChunk(keyword: string, text: string): PngChunk {
  if (keyword.length === 0 || keyword.length > 79) {
    throw new PngError(`tEXt keyword "${keyword}" must be 1 to 79 characters`)
  }
  const keywordBytes = latin1Encode(keyword)
  if (keywordBytes.includes(0)) throw new PngError('a tEXt keyword cannot contain a NUL byte')
  const textBytes = latin1Encode(text)

  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length)
  data.set(keywordBytes, 0)
  data[keywordBytes.length] = 0
  data.set(textBytes, keywordBytes.length + 1)
  return { type: 'tEXt', data }
}

/**
 * Split a `tEXt` payload into its keyword and value.
 *
 * The PNG specification forbids NUL inside the value and `png-chunk-text`
 * throws on one. We take everything after the first separator instead: a
 * stray byte in a trailing comment chunk is no reason to fail an import.
 * @param data - the chunk payload.
 * @returns the keyword and value, or `undefined` when there is no separator.
 */
export function decodeTextChunk(data: Uint8Array): { keyword: string, text: string } | undefined {
  const separator = data.indexOf(0)
  if (separator < 0) return undefined
  return {
    keyword: latin1Decode(data.subarray(0, separator)),
    text: latin1Decode(data.subarray(separator + 1)),
  }
}

/**
 * Collect the card-bearing `tEXt` chunks from a PNG.
 *
 * Keyword matching is case-insensitive because that is how SillyTavern matches;
 * cards written by other tools do turn up with `Chara`.
 * @param png - the whole PNG file.
 * @returns the base64 payloads found. Later chunks do not overwrite earlier
 *   ones, so the first of a duplicated keyword wins — matching upstream's
 *   `findIndex`.
 * @throws {PngError} when the file is not a readable PNG.
 */
export function readCardChunks(png: Uint8Array): CardChunks {
  const found: CardChunks = {}

  for (const chunk of parsePngChunks(png)) {
    if (chunk.type !== 'tEXt') continue
    const text = decodeTextChunk(chunk.data)
    if (text === undefined) continue

    const keyword = text.keyword.toLowerCase()
    if (keyword === 'ccv3' && found.ccv3 === undefined) found.ccv3 = text.text
    else if (keyword === 'chara' && found.chara === undefined) found.chara = text.text
  }

  return found
}

/**
 * Read the character card out of a PNG.
 * @param png - the whole PNG file.
 * @returns the normalised card.
 * @throws {PngError} when the PNG carries no card chunk, or one that is not
 *   base64-encoded JSON.
 */
export function decodeCardPng(png: Uint8Array): CharacterCard {
  const chunks = readCardChunks(png)
  // `ccv3` first: SillyTavern writes both chunks on every export, and only the
  // V3 one can carry V3-only fields.
  const payload = chunks.ccv3 ?? chunks.chara
  if (payload === undefined) {
    throw new PngError('this PNG carries no character card: no "ccv3" or "chara" tEXt chunk')
  }

  let json: string
  try {
    json = new TextDecoder().decode(base64Decode(payload))
  } catch (cause) {
    throw new PngError('the character card chunk is not valid base64', { cause })
  }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (cause) {
    throw new PngError('the character card chunk does not contain valid JSON', { cause })
  }

  return normalizeCard(raw)
}

/**
 * Write a character card into a PNG, replacing any card already in it.
 *
 * Both chunks are written: `chara` holds the V2 body for readers that predate
 * V3, `ccv3` the same body restamped as V3. They are inserted immediately
 * before `IEND`, which is where every other tool looks for them.
 * @param png - the image to stamp; its pixels and other chunks are untouched.
 * @param card - the card to embed.
 * @returns a new PNG. The input is not modified.
 * @throws {PngError} when the input is not a readable PNG.
 */
export function encodeCardPng(png: Uint8Array, card: CharacterCard): Uint8Array {
  const chunks = parsePngChunks(png).filter(chunk => {
    if (chunk.type !== 'tEXt') return true
    const keyword = decodeTextChunk(chunk.data)?.keyword.toLowerCase()
    return keyword !== 'chara' && keyword !== 'ccv3'
  })

  const iend = chunks.findIndex(chunk => chunk.type === 'IEND')
  if (iend < 0) throw new PngError('malformed PNG: no IEND chunk')

  const encoder = new TextEncoder()
  chunks.splice(
    iend,
    0,
    encodeTextChunk('chara', base64Encode(encoder.encode(JSON.stringify(toV2(card))))),
    encodeTextChunk('ccv3', base64Encode(encoder.encode(JSON.stringify(toV3(card))))),
  )

  return serializePngChunks(chunks)
}
