/**
 * What the reading view actually has to render, and what a window would cost.
 *
 *   node scripts/read-view-census.mjs
 *   node scripts/read-view-census.mjs --verbose    # per-chat detail
 *
 * Skips when the corpus is absent. Always exits 0: a caliper, not a test.
 *
 * ## Why this measures rendered text and not stored text
 *
 * Cards store a short token and expand it into an interface with a **display
 * regex** at render time. Measured on this corpus, that is not a quirk — it is
 * the dominant pattern:
 *
 * | | on disk | rendered |
 * |---|---|---|
 * | floors carrying a frame block | 1 | 179 |
 * | cards involved | 1 | 11 |
 *
 * **Not one of the 179 is a frame in storage.** A census of the files therefore
 * answers a question nobody asked, and answering it cost this project a planning
 * premise once already: "the corpus has no acceptance sample for the rendering
 * pipeline" was written into a design document on the strength of the disk-side
 * figure, and it was false.
 *
 * So every size here is measured **after** the owning card's display-stage regex
 * scripts have run, via `@iris/regex`'s own engine — the same engine the product
 * uses, not a reimplementation.
 *
 * ## 口径
 *
 * - **Floor** = one message. **One swipe per floor, the current one**
 *   (`swipes[swipe_id] ?? mes`): a reader lays out what is displayed, not every
 *   alternative.
 * - **Display stage** is upstream's flag semantics: `markdownOnly` → display,
 *   `promptOnly` → prompt, neither → both. Placement is `USER_INPUT` for user
 *   floors and `AI_OUTPUT` otherwise, and `depth` is passed so `minDepth` /
 *   `maxDepth` windows are honoured.
 * - **Reasoning counts** — `extra.reasoning` enters the DOM. Note it is *present*
 *   on 2410 messages and *non-empty* on 116; the count to use is the second one.
 * - **Frame block** = a fenced block whose body contains `html>`, `<head>` or
 *   `<body` — upstream's own predicate. See `frontend-block-census.mjs`.
 * - Sizes are UTF-8 bytes.
 *
 * ## Two gaps, and why the totals are a LOWER bound
 *
 * 1. **Global regexes are not included.** Only the card's own
 *    `data.extensions.regex_scripts` are applied. SillyTavern also keeps global
 *    regex scripts in `settings.json`, and a user with a global status-bar script
 *    would render more than this reports.
 * 2. **A chat whose character is missing from the library gets no regexes at
 *    all**, so its floors are counted as stored. `缄默之秋2.5 MVU` is in that
 *    state on this machine.
 *
 * Both push the same way: **the numbers here are a floor, not a ceiling.** That
 * matters for a budget, so it is stated at the top of the output too, not only
 * here.
 *
 * @module scripts/read-view-census
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ST = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern'
const CHATS = `${ST}/data/default-user/chats`
const CARDS = `${ST}/data/default-user/characters`
const verbose = process.argv.includes('--verbose')

if (!existsSync(CHATS)) {
  console.log('read-view-census: skipped — no local chat corpus at')
  console.log(`  ${CHATS}`)
  console.log('Expected on any machine but the operator\'s. Set IRIS_CORPUS to point elsewhere.')
  process.exit(0)
}

const { decodeCardPng } = await import('../packages/iris-character/src/index.ts')
const { parseChatFile } = await import('../packages/iris-persistence/src/index.ts')
const { PLACEMENT, applyRegexScripts, orderScripts } = await import('../packages/iris-regex/src/index.ts')

const bytes = value => Buffer.byteLength(value, 'utf8')
const kib = n => `${(n / 1024).toFixed(1)} KiB`
const mib = n => `${(n / 1024 / 1024).toFixed(2)} MiB`
const median = list => (list.length === 0 ? 0 : [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)])
const quantile = (list, q) => (list.length === 0 ? 0 : [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * q))])

/** Upstream's frame predicate, applied to each fenced block's body. */
const FRAME_TAGS = ['html>', '<head>', '<body']
function frameSizes(text) {
  const out = []
  const pattern = /^[ \t]*```[^\n`]*\n([\s\S]*?)^[ \t]*```/gm
  let match
  while ((match = pattern.exec(text))) {
    const body = match[1] ?? ''
    if (FRAME_TAGS.some(tag => body.includes(tag))) out.push(bytes(body))
  }
  return out
}

/**
 * The card a chat directory belongs to.
 *
 * A second chat against the same character gets a directory with a numeric
 * suffix (`【Sgw】又看一集1`), so the bare name is tried first and the stripped
 * one second. A directory that matches neither is reported, not silently given
 * an empty script list — that would look like "this card has no regexes".
 */
function cardFor(dir) {
  for (const candidate of [dir, dir.replace(/\d+$/, '')]) {
    const path = join(CARDS, `${candidate}.png`)
    if (existsSync(path)) {
      try { return decodeCardPng(readFileSync(path)) } catch { return undefined }
    }
  }
  return undefined
}

// --- gather ------------------------------------------------------------------

const chats = []
const missingCards = new Set()
const framesByCard = new Map()
let reasoningPresent = 0
let reasoningNonEmpty = 0
let reasoningBytes = 0
let grewFloors = 0, grewBytes = 0, shrankFloors = 0, shrankBytes = 0
let diskFrameFloors = 0

for (const dir of readdirSync(CHATS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const card = cardFor(dir.name)
  if (card === undefined) missingCards.add(dir.name)
  const owned = (card?.data?.extensions?.regex_scripts ?? []).map(script => ({ script, type: 'character' }))
  const scripts = orderScripts(owned)

  for (const file of readdirSync(join(CHATS, dir.name))) {
    if (!file.endsWith('.jsonl')) continue
    let parsed
    try { parsed = parseChatFile(readFileSync(join(CHATS, dir.name, file), 'utf8')) } catch { continue }

    const floors = parsed.messages.map((message, index) => {
      const depth = parsed.messages.length - 1 - index
      const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0
      const stored = Array.isArray(message.swipes) && message.swipes.length > 0
        ? String(message.swipes[swipeId] ?? message.mes ?? '')
        : String(message.mes ?? '')

      const placement = message.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT
      const rendered = applyRegexScripts(stored, placement, scripts, { isMarkdown: true, depth })

      if (bytes(rendered) > bytes(stored)) { grewFloors++; grewBytes += bytes(rendered) - bytes(stored) }
      else if (bytes(rendered) < bytes(stored)) { shrankFloors++; shrankBytes += bytes(stored) - bytes(rendered) }

      const extra = message.extra ?? {}
      if ('reasoning' in extra) reasoningPresent++
      const reasoningRaw = String(extra.reasoning ?? '')
      if (reasoningRaw.length > 0) reasoningNonEmpty++
      const reasoning = reasoningRaw.length === 0
        ? ''
        : applyRegexScripts(reasoningRaw, PLACEMENT.REASONING, scripts, { isMarkdown: true, depth })
      reasoningBytes += bytes(reasoning)

      const frames = frameSizes(rendered)
      if (frameSizes(stored).length > 0) diskFrameFloors++
      if (frames.length > 0) {
        const entry = framesByCard.get(dir.name) ?? { floors: 0, bytes: 0, max: 0 }
        entry.floors++
        entry.bytes += frames.reduce((a, b) => a + b, 0)
        entry.max = Math.max(entry.max, ...frames)
        framesByCard.set(dir.name, entry)
      }

      return { dom: bytes(rendered) + bytes(reasoning), stored: bytes(stored), frames }
    })

    chats.push({ label: `${dir.name}/${file}`, floors, total: floors.reduce((s, f) => s + f.dom, 0) })
  }
}

const allFloors = chats.flatMap(chat => chat.floors)
const totalDom = allFloors.reduce((s, f) => s + f.dom, 0)
const totalStored = allFloors.reduce((s, f) => s + f.stored, 0)
const framedFloors = allFloors.filter(f => f.frames.length > 0).length

// --- report ------------------------------------------------------------------

console.log('reading-view render census')
console.log(`  corpus: ${CHATS}`)
console.log('  NOTE: these totals are a LOWER bound — global regexes are not applied,')
console.log('        and a chat with no matching card is counted as stored. See the header.')

console.log('\n## on disk vs rendered — the reason this script exists')
console.log(`  floors carrying a frame block   disk ${String(diskFrameFloors).padStart(4)}   rendered ${String(framedFloors).padStart(4)}`)
console.log(`  total text                      disk ${mib(totalStored).padStart(9)}   rendered ${mib(totalDom).padStart(9)}`)
console.log(`  display regexes GREW  ${grewFloors} floor(s) by ${mib(grewBytes)}`)
console.log(`  display regexes SHRANK ${shrankFloors} floor(s) by ${mib(shrankBytes)}`)

console.log('\n## corpus shape')
const shape = {}
for (const chat of chats) {
  const n = chat.floors.length
  const label = n === 1 ? '1' : n <= 10 ? '2-10' : n <= 50 ? '11-50' : n <= 100 ? '51-100' : n <= 300 ? '101-300' : '300+'
  shape[label] = (shape[label] ?? 0) + 1
}
console.log(`  chats ${chats.length}, floors ${allFloors.length}`)
console.log(`  floors per chat: ${JSON.stringify(shape)}`)
console.log(`  reasoning: present on ${reasoningPresent}, non-empty on ${reasoningNonEmpty}, ${kib(reasoningBytes)} total`)

console.log('\n## per-floor rendered size')
const sizes = allFloors.map(f => f.dom)
console.log(`  median ${kib(median(sizes))}   p90 ${kib(quantile(sizes, 0.9))}   p99 ${kib(quantile(sizes, 0.99))}   max ${kib(Math.max(...sizes))}`)
console.log('  Four orders of magnitude. This is why a floor count cannot bound cost.')

console.log('\n## which cards produce frames, and which regex does it')
for (const [name, entry] of [...framesByCard].sort((a, b) => b[1].floors - a[1].floors)) {
  console.log(`  ${String(entry.floors).padStart(3)} floor(s)  ${mib(entry.bytes).padStart(9)}  largest ${kib(entry.max).padStart(9)}  ${name}`)
}

console.log('\n## a floor-count window does not bound cost')
for (const n of [20, 50, 100]) {
  const costs = chats.map(chat => chat.floors.slice(-n).reduce((s, f) => s + f.dom, 0))
  const covered = chats.filter(chat => chat.floors.length <= n).length
  console.log(`  N=${String(n).padStart(3)}  whole chats covered ${covered}/${chats.length}` +
    `   bytes per chat: min ${mib(Math.min(...costs))} median ${mib(median(costs))} max ${mib(Math.max(...costs))}`)
}
console.log('  The max column is the point: the same N buys wildly different work.')

console.log('\n## a byte-budget window, counting back from the newest floor')
for (const budget of [1, 2, 4].map(n => n * 1024 * 1024)) {
  const windows = chats.map((chat) => {
    let used = 0, shown = 0
    const frames = []
    for (let i = chat.floors.length - 1; i >= 0; i--) {
      const floor = chat.floors[i]
      if (used + floor.dom > budget && shown > 0) break
      used += floor.dom
      shown++
      frames.push(...floor.frames)
    }
    return { label: chat.label, shown, used, frames, whole: shown === chat.floors.length }
  })
  const counts = windows.filter(w => w.frames.length > 0).map(w => w.frames.length)
  const frameSizesInWindow = windows.flatMap(w => w.frames)
  console.log(`\n  budget ${mib(budget)}`)
  console.log(`    whole chats covered ${windows.filter(w => w.whole).length}/${chats.length}` +
    `   floors shown: min ${Math.min(...windows.map(w => w.shown))} median ${median(windows.map(w => w.shown))} max ${Math.max(...windows.map(w => w.shown))}`)
  console.log(`    chats with >=1 frame in window: ${counts.length}/${chats.length}`)
  console.log(`    frames per chat (of those): min ${Math.min(...counts)} median ${median(counts)} max ${Math.max(...counts)}`)
  console.log(`    frame size in window: median ${kib(median(frameSizesInWindow))} p90 ${kib(quantile(frameSizesInWindow, 0.9))} max ${kib(Math.max(...frameSizesInWindow))}`)
  console.log(`    total ${frameSizesInWindow.length} frame(s), ${mib(frameSizesInWindow.reduce((a, b) => a + b, 0))}`)
  if (verbose) {
    for (const w of [...windows].filter(x => x.frames.length > 0).sort((a, b) => b.frames.length - a.frames.length).slice(0, 6)) {
      console.log(`      ${String(w.frames.length).padStart(3)} frames / ${String(w.shown).padStart(3)} floors / ${mib(w.used)}  ${w.label.slice(0, 52)}`)
    }
  }
}
console.log('\n  A budget bounds bytes but not frame count, and both shapes occur here:')
console.log('  many small frames (21 in 0.43 MiB) and few large ones (15 in 1.92 MiB).')
console.log('  Each frame is its own srcdoc and observer, so the count is a second budget.')

if (missingCards.size > 0) {
  console.log(`\n## chat dirs with no card in the library — regexes NOT applied, counted as stored`)
  for (const name of missingCards) console.log(`  ${name}`)
}
