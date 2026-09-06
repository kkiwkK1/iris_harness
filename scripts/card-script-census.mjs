/**
 * Re-derive the card script and button numbers, for when a corpus-snapshot test
 * goes red.
 *
 * `@iris/app-service`'s gate test pins measured values and tells the reader to
 * check whether the card library changed before suspecting the parser. This is
 * what they check it with: same corpus, same readers, printed rather than
 * asserted, so a diff against the pinned numbers is one command away.
 *
 *   node scripts/card-script-census.mjs
 *   node scripts/card-script-census.mjs --verbose    # per-card button names
 *
 * Skips when the corpus is absent, like every corpus-dependent script here, and
 * always exits 0: this is a caliper, not a test. It reports; it does not judge.
 *
 * ## 口径
 *
 * - **Distinct script** = grouped by the *author's* `id`. Scripts live under two
 *   extension keys and three serializations, and three cards carry the same
 *   scripts under both keys. Counting each list independently double-counts:
 *   that produced "61 scripts" on the first pass against a real 48, and it is
 *   the same mistake `docs/SANDBOX.md` warns about, facing the other way.
 * - **Extracted** = what `extractScripts` reports, which skips a script with no
 *   body. The corpus has exactly one such: an empty, disabled placeholder that
 *   appears under both keys and so is reported skipped twice.
 * - **Buttons** are read from both shapes: modern `button.buttons`, and the
 *   legacy top-level `buttons` array that upstream's `backward.ts` still
 *   migrates.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ST = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern'
const CARDS = `${ST}/data/default-user/characters`
const verbose = process.argv.includes('--verbose')

if (!existsSync(CARDS)) {
  console.log('card-script-census: skipped — no local card corpus at')
  console.log(`  ${CARDS}`)
  console.log('Expected on any machine but the operator\'s. Set IRIS_CORPUS to point elsewhere.')
  process.exit(0)
}

const { decodeCardPng } = await import('../packages/iris-character/src/index.ts')
const { extractScripts } = await import('../packages/iris-script/src/index.ts')

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Undo an `Object.entries()` serialization, as `extractScripts` does. */
function fromEntries(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const pairs = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return undefined
    pairs.push([entry[0], entry[1]])
  }
  return Object.fromEntries(pairs)
}

/** Every raw script object stored under one extension key. */
function listUnder(extensions, key) {
  const holder = extensions[key]
  if (holder === undefined) return []
  const asObject = isRecord(holder) ? holder : fromEntries(holder)
  const list = Array.isArray(holder) && asObject === undefined ? holder : asObject?.scripts
  if (!Array.isArray(list)) return []
  return list.flatMap(entry => (isRecord(entry) ? [isRecord(entry.value) ? entry.value : entry] : []))
}

/** The buttons a script declares, and which shape declared them. */
function buttonsOf(script) {
  const modern = script.button
  const legacy = script.buttons
  if (isRecord(modern)) {
    return {
      shape: legacy === undefined ? 'modern' : 'both',
      list: Array.isArray(modern.buttons) ? modern.buttons : [],
      enabled: modern.enabled,
      wrapperKeys: Object.keys(modern),
    }
  }
  if (Array.isArray(legacy)) return { shape: 'legacy', list: legacy, enabled: undefined, wrapperKeys: [] }
  return { shape: 'none', list: [], enabled: undefined, wrapperKeys: [] }
}

let cardsDecoded = 0
let cardsWithScripts = 0
let distinct = 0
let extracted = 0
let emptyPlaceholders = 0
let skippedReports = 0
let scriptsWithButtons = 0
let buttons = 0
let hidden = 0
let visibleMissing = 0
let buttonEnabledFalse = 0
const wrapperKeySets = new Map()
const buttonKeySets = new Map()
const shapes = {}
const perCard = []
/** Scripts that exist only under the legacy key with only the legacy field. */
const legacyOnly = []

for (const file of readdirSync(CARDS).filter(name => name.toLowerCase().endsWith('.png'))) {
  let card
  try { card = decodeCardPng(readFileSync(join(CARDS, file))) } catch { continue }
  cardsDecoded++
  const extensions = card?.data?.extensions ?? {}
  const legacyList = listUnder(extensions, 'TavernHelper_scripts')
  const modernList = listUnder(extensions, 'tavern_helper')
  if (legacyList.length === 0 && modernList.length === 0) continue
  cardsWithScripts++

  const bundle = extractScripts(card)
  extracted += bundle.scripts.length
  skippedReports += bundle.skipped.length

  // Group by the author's id; `tavern_helper` wins where both keys carry one,
  // matching the order `extractScripts` reads them in.
  const byId = new Map()
  for (const script of legacyList) byId.set(String(script.id ?? `noid-${byId.size}`), { script, from: 'legacy key' })
  for (const script of modernList) {
    const id = String(script.id ?? `noid-${byId.size}`)
    byId.set(id, { script, from: byId.has(id) ? 'both keys' : 'modern key' })
  }

  const names = []
  let withButtons = 0
  for (const [, { script, from }] of byId) {
    distinct++
    if (typeof script.content !== 'string' || script.content.length === 0) emptyPlaceholders++

    const { shape, list, enabled, wrapperKeys } = buttonsOf(script)
    shapes[shape] = (shapes[shape] ?? 0) + 1
    if (wrapperKeys.length) {
      const key = wrapperKeys.slice().sort().join(',')
      wrapperKeySets.set(key, (wrapperKeySets.get(key) ?? 0) + 1)
      if (enabled === false) buttonEnabledFalse++
    }
    if (shape === 'legacy' && from === 'legacy key' && list.length > 0) {
      legacyOnly.push(`${file}: ${String(script.name ?? script.id)} (${list.length})`)
    }

    if (list.length > 0) { withButtons++; scriptsWithButtons++ }
    for (const button of list) {
      buttons++
      if (!isRecord(button)) { buttonKeySets.set('(not an object)', (buttonKeySets.get('(not an object)') ?? 0) + 1); continue }
      const key = Object.keys(button).slice().sort().join(',')
      buttonKeySets.set(key, (buttonKeySets.get(key) ?? 0) + 1)
      if (button.visible === undefined) visibleMissing++
      else if (button.visible === false) hidden++
      if (typeof button.name === 'string') names.push(button.name)
    }
  }
  perCard.push({ file, scripts: byId.size, withButtons, names })
}

const sorted = map => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]))

console.log('card script & button census')
console.log(`  corpus: ${CARDS}`)
console.log('')
console.log('## the numbers a corpus-snapshot test pins')
console.log(`  scripts extractScripts reports   ${extracted}`)
console.log(`  scripts carrying >=1 button      ${scriptsWithButtons}`)
console.log(`  buttons in total                 ${buttons}`)
console.log(`  buttons with visible: false      ${hidden}`)
console.log(`  empty, disabled placeholders     ${emptyPlaceholders}`)
console.log('')
console.log('## context for reading a change in those')
console.log(`  cards decoded                    ${cardsDecoded}`)
console.log(`  cards carrying scripts           ${cardsWithScripts}`)
console.log(`  distinct scripts (by author id)  ${distinct}`)
console.log(`  skipped entries reported         ${skippedReports}  (a script under both keys is reported once per key)`)
console.log(`  cards with >=1 button            ${perCard.filter(card => card.withButtons > 0).length}`)
console.log('')
console.log('## shape invariants — these should hold for any card library')
console.log(`  keys on the button wrapper       ${JSON.stringify(sorted(wrapperKeySets))}`)
console.log(`  keys on each button              ${JSON.stringify(sorted(buttonKeySets))}`)
console.log(`  button.enabled false             ${buttonEnabledFalse}`)
console.log(`  buttons missing visible          ${visibleMissing}`)
console.log(`  declaration shapes               ${JSON.stringify(shapes)}`)
console.log('')
console.log('## legacy-only scripts whose buttons a `button`-only reader would drop')
console.log(legacyOnly.length === 0 ? '  none' : legacyOnly.map(line => `  ${line}`).join('\n'))

if (verbose) {
  console.log('\n## per card')
  for (const card of perCard) {
    console.log(`  ${card.file}: ${card.scripts} script(s), ${card.withButtons} with buttons`)
    if (card.names.length) console.log(`     ${card.names.map(name => JSON.stringify(name)).join(', ')}`)
  }
  // Name collisions matter to whoever routes a button click: the storage format
  // keys a button by position only, so `(scriptId, index)` is the sole handle
  // guaranteed unique by construction. `(scriptId, name)` happens to be unique
  // in this corpus; nothing enforces it.
  const collisions = perCard
    .map(card => ({ file: card.file, dupes: card.names.filter((name, i) => card.names.indexOf(name) !== i) }))
    .filter(entry => entry.dupes.length > 0)
  console.log('\n## button names repeated within one card (across its scripts)')
  console.log(collisions.length === 0
    ? '  none'
    : collisions.map(entry => `  ${entry.file}: ${[...new Set(entry.dupes)].map(n => JSON.stringify(n)).join(', ')}`).join('\n'))
}
