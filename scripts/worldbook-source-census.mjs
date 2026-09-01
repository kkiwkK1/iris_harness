/**
 * Where each card's world info actually comes from.
 *
 * Written because a count answered the wrong question. "17 of 19 cards carry
 * both an embedded book and a named binding" is true, and the conclusion drawn
 * from it — that those cards were being assembled from half their world info —
 * was false. The two are the **same content**: SillyTavern's embedded
 * `character_book` is an import-time source, not a runtime one.
 *
 * Upstream, with line numbers so this can be rechecked:
 *
 * - `public/scripts/world-info.js:4363` `getCharacterLore()` reads
 *   `data.extensions.world` and `world_info.charLore[…].extraBooks` — **named
 *   books only**. It never touches `character_book`.
 * - `public/scripts/world-info.js:5618` is the only runtime path that does:
 *   it prompts the user, runs `convertCharacterBook`, saves the result as a
 *   named book, and binds it back onto the card. After that the embedded copy
 *   is dead weight.
 * - `public/scripts/world-info.js:4478` `getSortedEntries()` orders the four
 *   sources: chat lore, then persona lore, then character and global lore mixed
 *   by `world_info_character_strategy`.
 *
 * So a host that reads the embedded book and a host that reads the named book
 * mostly agree, and one that reads **both** duplicates every entry. That is the
 * failure this census exists to keep visible: it is invisible in a diff, costs
 * twice the world-info budget, and looks like a model that has started
 * repeating itself.
 *
 * Run it before and after any change to how books reach prompt assembly. The
 * bucket sizes predict the itemization delta per card; a card moving between
 * buckets is the thing to explain.
 *
 * Usage: `node scripts/worldbook-source-census.mjs [profile-root]`
 *
 * @module scripts/worldbook-source-census
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { decodeCardPng, normalizeCard } from '../packages/iris-character/src/index.ts'
import { fromCharacterBook, parseLorebook } from '../packages/iris-lorebook/src/index.ts'

const ROOT = process.argv[2]
  ?? `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user`
const CARDS = join(ROOT, 'characters')
const WORLDS = join(ROOT, 'worlds')

/**
 * An entry's identity for comparison purposes.
 *
 * Content, not uid: importing a book re-keys its entries, so comparing uids
 * would report two identical books as sharing nothing and confirm whatever the
 * reader already believed.
 * @param entry - a normalized entry.
 * @returns a string that is equal for entries that say the same thing.
 */
const fingerprint = entry => `${entry.comment}\u0000${entry.content}`

/**
 * Read one card, whatever container it is in.
 * @param file - the filename inside the characters directory.
 * @returns the normalized card, or undefined when it cannot be read.
 */
async function readCard(file) {
  try {
    if (file.endsWith('.png')) return normalizeCard(decodeCardPng(await readFile(join(CARDS, file))))
    if (file.endsWith('.json')) return normalizeCard(JSON.parse(await readFile(join(CARDS, file), 'utf8')))
  } catch {
    // A card this build cannot parse is a finding for the card reader, not for
    // this census; counting it here as "no world info" would be a lie.
    return undefined
  }
  return undefined
}

const available = new Set(
  (await readdir(WORLDS).catch(() => [])).filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length)),
)

/** Every book name some card binds, whether or not the file exists. */
const boundNames = new Set()

const buckets = {
  both: [],
  namedOnly: [],
  embeddedOnly: [],
  dangling: [],
  neither: [],
}
let sharedEntries = 0
let embeddedEntries = 0
let namedEntries = 0

for (const file of await readdir(CARDS)) {
  const card = await readCard(file)
  if (card === undefined) continue

  const world = card.data.extensions?.world
  const embedded = card.data.character_book
  const resolves = world !== undefined && available.has(String(world))
  if (world !== undefined) boundNames.add(String(world))

  const named = resolves
    ? Object.values(parseLorebook(JSON.parse(await readFile(join(WORLDS, `${world}.json`), 'utf8'))).entries)
    : []
  const inCard = embedded ? Object.values(fromCharacterBook(embedded).entries) : []

  if (embedded && resolves) {
    const cardSet = new Set(inCard.map(fingerprint))
    const shared = named.filter(entry => cardSet.has(fingerprint(entry))).length
    sharedEntries += shared
    embeddedEntries += inCard.length
    namedEntries += named.length
    buckets.both.push(`${file} — embedded ${inCard.length}, named ${named.length}, identical ${shared}`)
  } else if (resolves) {
    buckets.namedOnly.push(`${file} — ${named.length} entries reachable only through the binding`)
  } else if (embedded && world !== undefined) {
    buckets.dangling.push(`${file} — binds "${world}", no such file; ${inCard.length} embedded entries`)
  } else if (world !== undefined) {
    buckets.dangling.push(`${file} — binds "${world}", no such file, and no embedded book`)
  } else if (embedded) {
    buckets.embeddedOnly.push(`${file} — ${inCard.length} entries, no binding`)
  } else {
    buckets.neither.push(file)
  }
}

const report = (label, list, note) => {
  console.log(`\n${label}: ${list.length}${note ? `  — ${note}` : ''}`)
  for (const row of list) console.log(`    ${row}`)
}

report('both an embedded book and a resolvable binding', buckets.both,
  'the duplication risk: these are the same content')
report('a resolvable binding and NO embedded book', buckets.namedOnly,
  'unreachable to a host that reads only the embedded book')
report('an embedded book and no binding', buckets.embeddedOnly,
  'unreachable to upstream until the user accepts its import prompt')
report('a binding with no file behind it', buckets.dangling)
report('no world info at all', buckets.neither)

console.log(`\nacross the "both" bucket: embedded ${embeddedEntries}, named ${namedEntries}, identical ${sharedEntries}`)
console.log(`assembling both sources would produce ${embeddedEntries + namedEntries} entries, ${sharedEntries} of them duplicates`)

// Matched against the set of bound names, not against the report rows: the rows
// are keyed by card filename, so `row.includes(bookName)` found nothing and
// reported every bound book as an orphan — a bug that made this census's most
// alarming number its least trustworthy one.
const orphans = [...available].filter(name => !boundNames.has(name))
console.log(`\nbooks on disk reachable only through global selection: ${orphans.length}`)
for (const name of orphans) console.log(`    ${name}`)
