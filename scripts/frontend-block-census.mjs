/**
 * How many blocks in the local corpus would upstream build a frame for?
 *
 * This is the only population that exercises the frontend-rendering pipeline, so
 * it is the acceptance population — and the answer on this machine is **one**,
 * which is a fact about the pipeline's coverage rather than a number to feel
 * good about. Kept re-runnable because the answer should change when the user
 * adds a card, and nobody should have to re-derive the predicate to find out.
 *
 *   node scripts/frontend-block-census.mjs
 *   node scripts/frontend-block-census.mjs --verbose   # show each matching block
 *
 * Skips when the corpus is absent. Always exits 0: a caliper, not a test.
 *
 * ## The predicate, read from upstream rather than reported
 *
 * `JS-Slash-Runner/src/util/is_frontend.ts` and
 * `src/store/iframe_runtimes/message.ts`:
 *
 * ```ts
 * isFrontend(content) = ['html>', '<head>', '<body'].some(t => content.includes(t))
 * render$mes = $(div).find('pre').filter(pre => isFrontend($(pre).text()))
 * ```
 *
 * Three things the signature does not show, each of which changes the count:
 *
 * 1. **Substring containment, not tag matching, and the fence's info string is
 *    never consulted.** The one match in this corpus is a ```` ```text ```` block.
 *    A pipeline that routed on the language tag would miss it entirely.
 * 2. **A `<pre>` comes from a fenced block *or* a 4-space-indented block.**
 *    Counting fences alone undercounts. (Measured: 0 indented matches — so this
 *    costs nothing today, and the口径 still has to cover it.)
 * 3. **`.text()` is entity-decoded**, so a block whose source says `&lt;body`
 *    renders as text `<body` and matches upstream.
 *
 * ### Why (3) is a requirement on Iris and not just a fidelity detail
 *
 * Upstream applies the predicate to **already-rendered DOM** — it can call
 * `$mes.find('pre')` because SillyTavern rendered to DOM first. Iris has no such
 * step: `MarkdownText` produces React elements, so there is never a tree to
 * query. Detection here must happen on the **source text**, at the fence level.
 *
 * That is where (3) bites. Source text carries the literal `&lt;body`, which does
 * not contain the substring; upstream sees the decoded `<body`, which does. So
 * decoding before testing is a step Iris **must perform explicitly**, or the same
 * message frames upstream and does not frame here. It happens to cost nothing on
 * this corpus — zero decode-only matches — and that is luck, not licence: the
 * implementation cannot rely on the corpus staying empty. Stated here because the
 * next person to touch the predicate will read the three substrings and see no
 * reason to decode.
 *
 * @module scripts/frontend-block-census
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ST = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern'
const CHATS = `${ST}/data/default-user/chats`
const CARDS = `${ST}/data/default-user/characters`
const WORLDS = `${ST}/data/default-user/worlds`
const verbose = process.argv.includes('--verbose')

if (!existsSync(CHATS) && !existsSync(CARDS)) {
  console.log('frontend-block-census: skipped — no local corpus at')
  console.log(`  ${ST}`)
  console.log('Expected on any machine but the operator\'s. Set IRIS_CORPUS to point elsewhere.')
  process.exit(0)
}

const { decodeCardPng } = await import('../packages/iris-character/src/index.ts')
const { parseChatFile } = await import('../packages/iris-persistence/src/index.ts')

/** Upstream's three substrings, verbatim. */
const TAGS = ['html>', '<head>', '<body']
const isFrontend = content => TAGS.some(tag => content.includes(tag))
const bytes = value => Buffer.byteLength(value, 'utf8')

/** Enough entity decoding for the three substrings to surface if encoded. */
const decode = text => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&amp;/g, '&')

/** Fenced blocks: info string and body. */
function fencedBlocks(text) {
  const out = []
  const pattern = /^[ \t]*```([^\n`]*)\n([\s\S]*?)^[ \t]*```/gm
  let match
  while ((match = pattern.exec(text))) out.push({ kind: 'fenced', info: (match[1] ?? '').trim(), body: match[2] ?? '' })
  return out
}

/** Indented code blocks, per CommonMark: 4-space runs after a blank line. */
function indentedBlocks(text) {
  const stripped = text.replace(/^[ \t]*```[^\n`]*\n[\s\S]*?^[ \t]*```/gm, '')
  const out = []
  let current = []
  let previousBlank = true
  for (const line of stripped.split('\n')) {
    if (/^ {4}|^\t/.test(line) && (previousBlank || current.length > 0)) {
      current.push(line.replace(/^ {4}|^\t/, ''))
      continue
    }
    if (current.length > 0) { out.push({ kind: 'indented', info: '', body: current.join('\n') }); current = [] }
    previousBlank = line.trim().length === 0
  }
  if (current.length > 0) out.push({ kind: 'indented', info: '', body: current.join('\n') })
  return out
}

/** Every remote host a block reaches for. */
const hostsIn = body => [...new Set([...body.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)].map(m => m[1]))]

/** Test one text, returning the blocks upstream would frame. */
function matchesIn(text) {
  const found = []
  for (const block of [...fencedBlocks(text), ...indentedBlocks(text)]) {
    const direct = isFrontend(block.body)
    const decoded = !direct && isFrontend(decode(block.body))
    if (!direct && !decoded) continue
    found.push({
      ...block,
      via: decoded ? 'entity-decoded only' : 'direct',
      tags: TAGS.filter(tag => (decoded ? decode(block.body) : block.body).includes(tag)),
      hosts: hostsIn(block.body),
    })
  }
  return found
}

const populations = {
  'chat files': [],
  'card text': [],
  'disk world books': [],
}

// --- chats: every renderable text, swipe-expanded ---------------------------
let chatFiles = 0
let chatTexts = 0
if (existsSync(CHATS)) {
  for (const dir of readdirSync(CHATS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    for (const file of readdirSync(join(CHATS, dir.name))) {
      if (!file.endsWith('.jsonl')) continue
      chatFiles++
      let chat
      try { chat = parseChatFile(readFileSync(join(CHATS, dir.name, file), 'utf8')) } catch { continue }
      chat.messages.forEach((message, index) => {
        const swipes = Array.isArray(message.swipes) && message.swipes.length > 0
          ? message.swipes
          : [message.mes ?? '']
        swipes.forEach((raw, swipeIndex) => {
          chatTexts++
          for (const hit of matchesIn(typeof raw === 'string' ? raw : '')) {
            populations['chat files'].push({ where: `${dir.name}/${file}#${index}.${swipeIndex}`, ...hit })
          }
        })
      })
    }
  }
}

// --- card text: the fields that become message 0 or reach the prompt --------
let cards = 0
let cardFields = 0
if (existsSync(CARDS)) {
  for (const file of readdirSync(CARDS).filter(name => name.toLowerCase().endsWith('.png'))) {
    let card
    try { card = decodeCardPng(readFileSync(join(CARDS, file))) } catch { continue }
    cards++
    const data = card?.data ?? {}
    const fields = [
      ['first_mes', String(data.first_mes ?? '')],
      ['description', String(data.description ?? '')],
      ['mes_example', String(data.mes_example ?? '')],
    ]
    ;(data.alternate_greetings ?? []).forEach((greeting, i) => fields.push([`alternate_greetings[${i}]`, String(greeting)]))
    ;(data.character_book?.entries ?? []).forEach((entry, i) => fields.push([`wi[${i}]`, String(entry?.content ?? '')]))
    for (const [name, text] of fields) {
      cardFields++
      for (const hit of matchesIn(text)) populations['card text'].push({ where: `${file} ${name}`, ...hit })
    }
  }
}

// --- disk world books -------------------------------------------------------
let books = 0
let bookEntries = 0
if (existsSync(WORLDS)) {
  for (const file of readdirSync(WORLDS).filter(name => name.endsWith('.json'))) {
    books++
    let book
    try { book = JSON.parse(readFileSync(join(WORLDS, file), 'utf8')) } catch { continue }
    for (const entry of Object.values(book.entries ?? {})) {
      bookEntries++
      for (const hit of matchesIn(String(entry?.content ?? ''))) {
        populations['disk world books'].push({ where: `${file} / ${entry?.comment ?? ''}`, ...hit })
      }
    }
  }
}

// --- report -----------------------------------------------------------------
const occurrences = Object.values(populations).reduce((sum, list) => sum + list.length, 0)
/**
 * Distinct blocks, keyed by body.
 *
 * **The populations overlap.** A card's `first_mes` becomes message 0 of every
 * chat opened against it, so one authored block is one hit in `card text` and
 * one more in `chat files` — summing the columns counts it twice. That is the
 * same mistake as reading two storage keys without deduplicating, which this
 * repository has now made in three separate censuses, so the sum is labelled as
 * a sum and the distinct count is reported beside it.
 */
const distinct = new Set(Object.values(populations).flat().map(hit => hit.body)).size

console.log('frontend-block census — blocks upstream would build a frame for')
console.log(`  corpus: ${ST}`)
console.log('')
console.log('## by population (these overlap — see below)')
console.log(`  chat files         ${String(populations['chat files'].length).padStart(3)}  (${chatFiles} files, ${chatTexts} renderable texts, swipe-expanded)`)
console.log(`  card text          ${String(populations['card text'].length).padStart(3)}  (${cards} cards, ${cardFields} fields)`)
console.log(`  disk world books   ${String(populations['disk world books'].length).padStart(3)}  (${books} books, ${bookEntries} entries)`)
console.log(`  ── sum of columns  ${String(occurrences).padStart(3)}  (a greeting appears as card text AND as message 0)`)
console.log(`  distinct blocks    ${String(distinct).padStart(3)}  <- the answer`)
console.log('')

const all = Object.entries(populations).flatMap(([population, list]) => list.map(hit => ({ population, ...hit })))
const byKind = {}
const byVia = {}
const byTag = {}
const byInfo = {}
for (const hit of all) {
  byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1
  byVia[hit.via] = (byVia[hit.via] ?? 0) + 1
  byInfo[hit.info || '(none)'] = (byInfo[hit.info || '(none)'] ?? 0) + 1
  for (const tag of hit.tags) byTag[tag] = (byTag[tag] ?? 0) + 1
}
console.log('## how they matched')
console.log(`  block kind         ${JSON.stringify(byKind)}`)
console.log(`  matched via        ${JSON.stringify(byVia)}`)
console.log(`  substring          ${JSON.stringify(byTag)}`)
console.log(`  fence info string  ${JSON.stringify(byInfo)}   <- upstream ignores this`)
console.log('')

const remote = all.filter(hit => hit.hosts.length > 0)
console.log('## remote sources inside matching blocks')
if (remote.length === 0) console.log('  none')
else {
  for (const hit of remote) console.log(`  ${hit.where}\n     hosts: ${hit.hosts.join(', ')}`)
  console.log('')
  console.log('  A block whose real payload is fetched at render time is not measurable')
  console.log('  from disk: the author can change it after distribution, and Iris\'s remote')
  console.log('  whitelist (SANDBOX.md) decides whether the fetch happens at all.')
}

if (verbose && all.length > 0) {
  console.log('\n## each matching block')
  for (const hit of all) {
    console.log(`\n  [${hit.population}] ${hit.where}`)
    console.log(`     ${hit.kind}, info=${JSON.stringify(hit.info)}, via ${hit.via}, ${bytes(hit.body)} B, matched ${hit.tags.join(' ')}`)
    console.log(hit.body.split('\n').slice(0, 12).map(line => `     | ${line}`).join('\n'))
  }
}

console.log('')
if (distinct === 0) {
  console.log('No block in this corpus would be framed. The frontend pipeline has no')
  console.log('acceptance sample here — a design built against it is unmeasured.')
} else {
  console.log(`${distinct} distinct block(s). Read the remote-source section before treating`)
  console.log('that as coverage: a loader stub is one block on disk and an unbounded')
  console.log('amount off it.')
}
