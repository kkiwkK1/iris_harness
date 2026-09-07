/**
 * Just enough character-card reading to make an import demo honest.
 *
 * This is NOT the card decoder — `@iris/character` is, and the host owns it.
 * What the fake needs is the one field the library row shows, pulled out of a
 * real file, so that dragging an actual card onto the page produces the actual
 * name. A fake that named every import after its filename would let a broken
 * base64 hand-off look like a success.
 *
 * @module @iris/client-fake/card
 */

/** PNG's fixed magic prefix. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/**
 * Decode base64 to bytes without Node or DOM specifics.
 *
 * `atob` rather than `Buffer`: this package is aliased straight into the
 * browser bundle, so anything Node-only here would build and then fail at run
 * time in the one place it matters.
 * @param base64 - the encoded payload.
 * @returns the bytes, or undefined when the input is not valid base64.
 */
function bytesOf(base64: string): Uint8Array | undefined {
  let binary: string
  try {
    binary = atob(base64.replace(/^data:[^,]*,/, ''))
  } catch {
    return undefined
  }
  const out = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at) & 0xff
  return out
}

/** Read a big-endian uint32. */
function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
  ) >>> 0
}

/**
 * Pull the card JSON out of a PNG's tEXt chunks.
 *
 * `ccv3` wins over `chara` when both are present, which is the same precedence
 * the real decoder uses: a V3 writer keeps the V2 block around for older
 * readers, so preferring `chara` would silently downgrade every V3 card.
 * @param bytes - the PNG file.
 * @returns the decoded JSON text, or undefined when the file carries no card.
 */
function cardTextFromPng(bytes: Uint8Array): string | undefined {
  if (PNG_MAGIC.some((byte, at) => bytes[at] !== byte)) return undefined
  const decoder = new TextDecoder()
  const found = new Map<string, string>()

  let at = 8
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at)
    const type = decoder.decode(bytes.subarray(at + 4, at + 8))
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'tEXt') {
      const split = body.indexOf(0)
      if (split > 0) {
        const keyword = decoder.decode(body.subarray(0, split))
        if (keyword === 'chara' || keyword === 'ccv3') {
          const payload = decoder.decode(body.subarray(split + 1))
          const inner = bytesOf(payload)
          if (inner !== undefined) found.set(keyword, new TextDecoder().decode(inner))
        }
      }
    }
    if (type === 'IEND') break
    at += 12 + length
  }
  return found.get('ccv3') ?? found.get('chara')
}

/** What the fake manages to learn about an imported file. */
export interface ReadCard {
  name: string
  tags: string[]
  creator?: string
  /** The card's description, clipped as the host clips it. Absent when empty. */
  description?: string
  /** Entries in the embedded book. Absent when the card embeds none. */
  bookEntryCount?: number
}

/**
 * The host's clip on a summary's description, in code points.
 *
 * A copy of `packages/iris-app-service/src/library.ts` `DESCRIPTION_POINTS`,
 * for the same reason {@link CARD_FILE_EXTENSIONS} is a copy of its `EXTENSIONS`
 * — the browser bundle cannot import the host — and honest for the same reason:
 * `tests/card-facts.test.ts` reads the host's source and holds this number to
 * it. Without the clip, dropping the corpus's longest card on the fake would
 * put 2851 code points of description on a page a host would have given 200.
 */
export const DESCRIPTION_POINTS = 200

/**
 * The card file extensions the host stores, lowercased, dot included.
 *
 * A copy of `packages/iris-app-service/src/library.ts` `EXTENSIONS`, which the
 * browser bundle cannot import; `apps/iris-web/tests/card-files.test.ts` reads
 * the host's source and holds this list to it. `.charx` is deliberately absent:
 * the host refuses it by name, and a fake that quietly named a `.charx` after
 * its filename would let the drop target look like it worked where the host
 * says no.
 */
export const CARD_FILE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.json']

/** The lowercased extension of a filename, dot included, or the empty string. */
export function cardFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

/**
 * Read the display fields of an imported card.
 *
 * Falls back to the filename rather than failing: the import path should still
 * be exercisable with a placeholder file, and a fake that refused everything
 * but a well-formed V2 card would make the drop target untestable.
 * @param filename - the dropped file's name, used as the fallback identity.
 * @param base64 - the file's bytes, base64-encoded, as `character.import` sends them.
 * @returns the fields the library row needs.
 */
export function readCard(filename: string, base64: string): ReadCard {
  const extension = cardFileExtension(filename)
  const stripped = CARD_FILE_EXTENSIONS.includes(extension)
    ? filename.slice(0, filename.length - extension.length)
    : filename
  const fallback = stripped.trim()
  const bytes = bytesOf(base64)
  if (bytes === undefined) return { name: fallback === '' ? filename : fallback, tags: [] }

  const json = /\.json$/i.test(filename) ? new TextDecoder().decode(bytes) : cardTextFromPng(bytes)
  if (json === undefined) return { name: fallback === '' ? filename : fallback, tags: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { name: fallback === '' ? filename : fallback, tags: [] }
  }

  // V2/V3 nest under `data`; V1 is flat. Reading both is two lines here and
  // saves the UI from having to care which era a card came from.
  const root = parsed as Record<string, unknown>
  const data = (root['data'] ?? root) as Record<string, unknown>
  const name = typeof data['name'] === 'string' && data['name'].trim() !== '' ? data['name'] : fallback
  const rawTags = data['tags']
  const tags = Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === 'string') : []
  const creator = typeof data['creator'] === 'string' && data['creator'].trim() !== '' ? data['creator'] : undefined

  /*
   * The two content facts a host would summarise. Read here rather than left to
   * the seed, because the interesting import is a real card: a fake that showed
   * a dropped card's name but never its description would leave the character
   * page's dense form reachable only through the three seeded rows.
   *
   * The third fact — `scriptCount` — is deliberately NOT read. Scripts live
   * under two extension keys in three shapes, and the only correct reading of
   * them is `@iris/script`'s `extractScripts`, which this package does not
   * depend on (it is aliased into the browser bundle and keeps its one
   * dependency). A hand-rolled walk here would be a second, wrong opinion about
   * the same question — reading only the obvious key once lost 7 of 15 cards — so
   * an imported card reports no scripts, and the fake's `script.list` agrees
   * with that by construction.
   */
  const rawDescription = typeof data['description'] === 'string' ? data['description'] : ''
  const points = [...rawDescription]
  const description = points.length === 0
    ? undefined
    : points.slice(0, DESCRIPTION_POINTS).join('')
  const book = data['character_book']
  // A book object with no `entries` array counts as an empty book, not as no
  // book: the host's `normalizeBook` defaults the array in, so reporting the
  // field absent here would disagree with a host over the same file.
  const entries = !isRecord(book)
    ? undefined
    : Array.isArray(book['entries']) ? book['entries'].length : 0

  return {
    name,
    tags,
    ...(creator === undefined ? {} : { creator }),
    ...(description === undefined ? {} : { description }),
    // Present for an empty embedded book, absent for no book — the distinction
    // `CharacterSummary.bookEntryCount` keeps, kept here too.
    ...(entries === undefined ? {} : { bookEntryCount: entries }),
  }
}

/** Whether a value is a plain keyed object rather than an array or primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
