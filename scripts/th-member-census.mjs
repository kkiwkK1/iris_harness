/**
 * Which of upstream's TavernHelper members do real cards actually reach for?
 *
 *   node scripts/th-member-census.mjs
 *   node scripts/th-member-census.mjs --verbose
 *
 * Skips when the corpus is absent. Always exits 0: a caliper, not a test.
 *
 * ## THE INPUT IS THE EXPORTED CONSTANT, NOT THE SOURCE TEXT
 *
 * `settings-usage-census.mjs` is brittle against **upstream's** source layout.
 * This one used to be brittle against **ours** in a second way: it found
 * `UPSTREAM_MEMBERS` in `apps/iris-web/src/sandbox/upstream-surface.ts` and
 * `MEMBER_KINDS` in `identity.ts` by searching for their declaration text, and
 * read the names out of the literals. That is the more dangerous direction,
 * because **we refactor our own code far more often than upstream refactors
 * theirs** — and it failed silently: rename a constant or reformat its array,
 * and a shorter list quietly became the answer (`notes/PLUGIN-FEASIBILITY.md`
 * §8, item 3). It had already gone wrong once, the instructive way: the first
 * extractor read from the constant's name to the **end of the file**, so the
 * day `upstream-surface.ts` gained its second array, 171 names became 316 —
 * and the failure would not have looked like one, because 145 extra names that
 * no card uses land in the "declared but never used" column, which is this
 * report's *expected* shape.
 *
 * Both lists are imported now. A moved or renamed constant is a load-time
 * crash instead of a wrong number, and `apps/iris/tests/census-inputs.test.ts`
 * asserts that what this script read is exactly what those modules export —
 * the two can no longer drift apart quietly, in either direction.
 *
 * Same failure discipline as the settings caliper: conclusions already
 * recorded do not expire — they were true of the revision measured — but **no
 * new number may be quoted from a run whose inputs did not load**.
 *
 * ## 口径, chosen for the decision downstream (wiring order)
 *
 * - **The unit is the card, not the call.** One card calling a member a hundred
 *   times is one card's worth of breakage; ten cards calling it once each is
 *   ten. The tables sort by cards.
 * - **Card identity is the card FILE.** A second chat against one character gets
 *   its own directory (`…又看一集1`), and the script pool keys on the `.png`
 *   name — so keying the interface pool on the directory let one card vote
 *   twice and reported 11 where the answer was 9. Two pools, two naming schemes,
 *   and nothing checking they were the same scheme.
 * - **Three code populations**, deduplicated: card script bodies; the
 *   **rendered** interfaces (a display regex expands a token into HTML on 179
 *   floors, but that is one interface repeated, so each distinct rendered
 *   `<script>` counts once per card); and the acceptance card's SPA.
 * - **Matching** is an identifier at a word boundary followed by `(` or `.`.
 *   Generic names are flagged for manual review rather than trusted — every flag
 *   in the current corpus was checked by hand and is a real API use, though a
 *   couple of *call counts* include the name appearing inside an error string.
 * - **Not included:** global regex scripts from `settings.json`. Only the card's
 *   own regexes render, so the interface pool is a lower bound.
 *
 * @module scripts/th-member-census
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { decodeCardPng, normalizeCard } from '../packages/iris-character/src/index.ts'
import { extractScripts } from '../packages/iris-script/src/index.ts'
import { parseChatFile } from '../packages/iris-persistence/src/index.ts'
import { PLACEMENT, applyRegexScripts, orderScripts } from '../packages/iris-regex/src/index.ts'
import { UPSTREAM_MEMBERS } from '../apps/iris-web/src/sandbox/upstream-surface.ts'
import { MEMBER_KINDS } from '../apps/iris-web/src/sandbox/identity.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CORPUS = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern'
const ST = `${CORPUS}/data/default-user`
const CARDS = `${ST}/characters`
const CHATS = `${ST}/chats`
const SAMPLE = `${ROOT}测试用卡`

// --- the member list, and what Iris has built --------------------------------

/**
 * The declared surface, imported from the module that owns it.
 *
 * A copy, not the imported array itself: someone mutating `MEMBERS` must not
 * be able to reach into `upstream-surface.ts` through it.
 *
 * @type {string[]}
 */
export const MEMBERS = [...UPSTREAM_MEMBERS]

/**
 * What Iris answers for: every name `identity.ts` classifies.
 *
 * @type {Set<string>}
 */
export const BUILT = new Set(Object.keys(MEMBER_KINDS))

// --- the detector, and a fixture that proves it can see -----------------------

/**
 * Does this body reach for `name`?
 *
 * The boundary excludes `.` so that an unrelated object's method does not
 * count, with one exception: cards legitimately reach the API through its own
 * namespace, and `TavernHelper.getWorldbook(…)` is a real call. The first
 * version excluded that too, and reported four members short — two of them as
 * *never used*, in the column that decides what not to build.
 * @param {string} code - the body to scan.
 * @param {string} name - the member.
 * @returns {number} how many times it is reached for.
 */
function reachesFor(code, name) {
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_$.])${WINDOW_CHAIN}${NAMESPACE}${name}\\s*(\\?\\s*)?[(.]`,
    'g',
  )
  return [...code.matchAll(pattern)].length
}

/**
 * The window hops a card takes to get out of its iframe.
 *
 * Card scripts run inside a frame, so the API is routinely reached as
 * `window.parent.TavernHelper.x` or `window.top.TavernHelper.x` rather than
 * bare. Measured in this corpus for `extension_settings`, whose readers are
 * written exactly this way. Repeated, because `window.parent.top` happens.
 */
const WINDOW_CHAIN = '((?:window|parent|top|self|globalThis)\\s*(?:\\?\\s*)?\\.\\s*)*'

/** The namespace object itself, optionally, with optional chaining. */
const NAMESPACE = '(TavernHelper\\s*(?:\\?\\s*)?\\.\\s*)?'

/**
 * Shapes the detector must see, and shapes it must not.
 *
 * Checking the real corpus can only ever show that nothing was found. It cannot
 * tell "there is none" from "the detector is blind to this shape" — those are
 * the same output. So the detector is handed source written on purpose and asked
 * what it sees.
 *
 * This exists because the `.`-boundary bug produced exactly that
 * indistinguishable pair: `TavernHelper.getWorldbook(…)` was never matched, and
 * the report said "0 cards", which reads identically to "nobody calls it".
 */
const DETECTOR_FIXTURE = {
  mustSee: {
    'bare call': 'getWorldbook("book")',
    'through the namespace': 'await TavernHelper.getWorldbook("book")',
    'namespace with spacing': 'TavernHelper . getWorldbook ("book")',
    'property access, not a call': 'const n = getWorldbook.length',
    'awaited': 'const e = await getWorldbook(name)',
    'chained off the result': 'getWorldbook(n).then(x => x)',
    'after a destructure': 'const { getWorldbook } = TavernHelper; getWorldbook(n)',
    'at the very start of the body': 'getWorldbook(n)',
    /*
     * Multi-path arrival. The same member is reachable by several routes, and a
     * detector that knows one route reports the others as absent — which is the
     * same output as "nobody calls it". Card scripts run in a frame, so the
     * window hops below are the normal way out of it, not exotica: this corpus's
     * `extension_settings` readers are written exactly this way.
     */
    'out through window': 'window.TavernHelper.getWorldbook("book")',
    'out through the parent frame': 'window.parent.TavernHelper.getWorldbook("book")',
    'out through the top frame': 'window.top.TavernHelper.getWorldbook("book")',
    'a window hop to the bare global': 'window.parent.getWorldbook("book")',
    'optional chaining on the namespace': 'TavernHelper?.getWorldbook("book")',
    'optional chaining on the call': 'getWorldbook?.("book")',
  },
  mustNotSee: {
    'another object with the same method': 'myCache.getWorldbook("book")',
    'a longer identifier that contains it': 'getWorldbookNames("book")',
    'a prefixed identifier': 'myGetWorldbook("book")',
    'bare mention with no call or access': 'typeof getWorldbook === "function"',
    /*
     * Widening for the window hops must not widen to *any* receiver — the whole
     * point of the boundary is that a card's own cache object named `x` calling
     * `x.getWorldbook()` is not this API. These stay excluded.
     */
    'an unrelated receiver reached through window': 'window.myCache.getWorldbook("b")',
    'a deep unrelated path': 'a.b.c.getWorldbook("b")',
  },
}

/**
 * Run the fixture. A caliper that cannot see is worse than no caliper: it
 * reports zeros that read like findings.
 * @returns {string[]} the failures, empty when the detector is sound.
 */
function checkDetector() {
  const failures = []
  for (const [label, code] of Object.entries(DETECTOR_FIXTURE.mustSee)) {
    if (reachesFor(code, 'getWorldbook') === 0) failures.push(`MISSED  ${label}: ${code}`)
  }
  for (const [label, code] of Object.entries(DETECTOR_FIXTURE.mustNotSee)) {
    if (reachesFor(code, 'getWorldbook') > 0) failures.push(`FALSE+  ${label}: ${code}`)
  }
  return failures
}

const detectorFailures = checkDetector()

// --- count -------------------------------------------------------------------
/** Names generic enough that a word-boundary hit may not be the API. */
const GENERIC = new Set(['builtin', 'Mvu', 'SillyTavern', 'TavernHelper', 'EjsTemplate', 'errorCatched'])

/**
 * Run the census against the corpus, or say why there is nothing to count.
 *
 * Everything above this — the imported surface, the classification, the
 * detector fixture — is corpus-independent on purpose: `census-inputs.test.ts`
 * imports this module for its inputs and must not scan a corpus (or exit) to
 * get them.
 */
function run() {
  if (!existsSync(CARDS)) {
    console.log('th-member-census: skipped — no local card corpus at')
    console.log(`  ${CARDS}`)
    console.log('Expected on any machine but the operator machine. Set IRIS_CORPUS to point elsewhere.')
    return
  }

  /*
   * The floor survives the extractor that needed it: it now guards the
   * constant itself. A surface that arrives short must stop the run rather
   * than report one — a shorter member list silently turns "unused" into the
   * majority answer.
   */
  if (MEMBERS.length < 150) {
    console.log(`th-member-census: only ${MEMBERS.length} members arrived from upstream-surface.ts.`)
    console.log('The surface itself looks broken — repair it before quoting any number from this caliper.')
    return
  }

  /** @type {{card: string, origin: string, code: string}[]} */
  const sources = []

  // 1. card script bodies
  for (const file of readdirSync(CARDS).filter(f => f.toLowerCase().endsWith('.png'))) {
    let card
    try { card = decodeCardPng(readFileSync(join(CARDS, file))) } catch { continue }
    for (const script of extractScripts(card).scripts) {
      sources.push({ card: file, origin: `script:${script.name}`, code: script.content })
    }
  }

  // 2. rendered interfaces, deduplicated per card
  const seenRendered = new Set()
  /**
   * Resolve a chat directory to the card **file** it belongs to.
   *
   * The file, not the directory name: a second chat against one character gets its
   * own directory (`…又看一集1`), so keying card identity on the directory lets a
   * single card vote twice. Caught by answering the same question a second way and
   * getting 11 against 9.
   */
  const cardFor = dir => {
    for (const candidate of [dir, dir.replace(/\d+$/, '')]) {
      const path = join(CARDS, `${candidate}.png`)
      if (existsSync(path)) {
        try { return { card: decodeCardPng(readFileSync(path)), file: `${candidate}.png` } } catch { return undefined }
      }
    }
    return undefined
  }
  for (const dir of readdirSync(CHATS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const resolved = cardFor(dir.name)
    if (!resolved) continue
    const card = resolved.card
    const cardFile = resolved.file
    const scripts = orderScripts((card?.data?.extensions?.regex_scripts ?? []).map(script => ({ script, type: 'character' })))
    if (scripts.length === 0) continue
    for (const file of readdirSync(join(CHATS, dir.name))) {
      if (!file.endsWith('.jsonl')) continue
      let chat
      try { chat = parseChatFile(readFileSync(join(CHATS, dir.name, file), 'utf8')) } catch { continue }
      chat.messages.forEach((message, index) => {
        const depth = chat.messages.length - 1 - index
        const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0
        const raw = Array.isArray(message.swipes) && message.swipes.length > 0
          ? String(message.swipes[swipeId] ?? message.mes ?? '')
          : String(message.mes ?? '')
        const rendered = applyRegexScripts(raw, message.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, scripts, { isMarkdown: true, depth })
        for (const match of rendered.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
          const code = match[1] ?? ''
          if (code.trim().length === 0) continue
          const key = `${cardFile}\u0000${code}`
          if (seenRendered.has(key)) continue          // same interface, rendered again
          seenRendered.add(key)
          sources.push({ card: cardFile, origin: 'rendered-interface', code })
        }
      })
    }
  }

  // 3. the acceptance card's SPA
  if (existsSync(`${SAMPLE}/战锤群星闪耀.json`)) {
    const sample = normalizeCard(JSON.parse(readFileSync(`${SAMPLE}/战锤群星闪耀.json`, 'utf8')))
    for (const [i, script] of (sample.data?.extensions?.regex_scripts ?? []).entries()) {
      const text = String(script?.replaceString ?? '')
      for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        sources.push({ card: '战锤群星闪耀 (sample)', origin: `regex[${i}] SPA`, code: match[1] ?? '' })
      }
    }
    for (const script of extractScripts(sample).scripts) {
      sources.push({ card: '战锤群星闪耀 (sample)', origin: `script:${script.name}`, code: script.content })
    }
  }

  /** @type {Map<string, {cards: Set<string>, calls: number, origins: Set<string>}>} */
  const usage = new Map()
  for (const name of MEMBERS) usage.set(name, { cards: new Set(), calls: 0, origins: new Set() })

  for (const source of sources) {
    for (const name of MEMBERS) {
      const hits = reachesFor(source.code, name)
      if (hits === 0) continue
      const entry = usage.get(name)
      entry.calls += hits
      entry.cards.add(source.card)
      entry.origins.add(source.origin.split(':')[0])
    }
  }

  const used = MEMBERS.filter(n => (usage.get(n)).cards.size > 0)
  const builtUsed = used.filter(n => BUILT.has(n))
  const unbuiltUsed = used.filter(n => !BUILT.has(n))
  const unbuiltUnused = MEMBERS.filter(n => !BUILT.has(n) && (usage.get(n)).cards.size === 0)
  const builtUnused = MEMBERS.filter(n => BUILT.has(n) && (usage.get(n)).cards.size === 0)

  if (detectorFailures.length > 0) {
    console.log('## DETECTOR FIXTURE FAILED — every number below is unreliable')
    for (const line of detectorFailures) console.log(`  ${line}`)
    console.log('')
    console.log('  A missed shape reports as "0 cards", which reads exactly like')
    console.log('  "nobody calls it" — and that column decides what not to build.')
    console.log('')
  } else {
    console.log(`## detector fixture: ${Object.keys(DETECTOR_FIXTURE.mustSee).length} shapes seen, ` +
      `${Object.keys(DETECTOR_FIXTURE.mustNotSee).length} correctly ignored`)
    console.log('')
  }

  console.log('## corpus scanned')
  console.log(`  card script bodies      ${sources.filter(s => s.origin.startsWith('script')).length}`)
  console.log(`  distinct rendered interfaces ${sources.filter(s => s.origin === 'rendered-interface').length}  (deduplicated per card)`)
  console.log(`  sample-card SPA blocks  ${sources.filter(s => s.origin.includes('SPA')).length}`)
  console.log(`  upstream members        ${MEMBERS.length}`)
  console.log(`  Iris implements         ${MEMBERS.filter(n => BUILT.has(n)).length}`)

  console.log('\n## THE PRIORITY TABLE — unbuilt and used, by cards touched')
  console.log('  cards  calls  member                          seen in')
  for (const name of unbuiltUsed.sort((a, b) => {
    const d = (usage.get(b)).cards.size - (usage.get(a)).cards.size
    return d !== 0 ? d : (usage.get(b)).calls - (usage.get(a)).calls
  })) {
    const u = usage.get(name)
    console.log(`  ${String(u.cards.size).padStart(5)}  ${String(u.calls).padStart(5)}  ${name.padEnd(30)} ${[...u.origins].join(', ')}${GENERIC.has(name) ? '   [GENERIC NAME — verify]' : ''}`)
  }

  console.log('\n## built and used (the members we built that cards do call)')
  for (const name of builtUsed.sort((a, b) => (usage.get(b)).cards.size - (usage.get(a)).cards.size)) {
    const u = usage.get(name)
    console.log(`  ${String(u.cards.size).padStart(5)}  ${String(u.calls).padStart(5)}  ${name}${GENERIC.has(name) ? '   [GENERIC NAME — verify]' : ''}`)
  }

  console.log(`\n## built but unused in this corpus: ${builtUnused.length}`)
  console.log(`  ${builtUnused.join(', ')}`)
  console.log(`\n## unbuilt and unused in this corpus: ${unbuiltUnused.length}`)
  console.log(`  ${unbuiltUnused.join(', ')}`)

  // --- triggerSlash ------------------------------------------------------------
  console.log('\n\n## triggerSlash: which slash commands do cards actually call?')
  const commandCards = new Map()
  const commandCalls = new Map()
  let triggerSlashSites = 0
  const unparsed = []
  for (const source of sources) {
    for (const match of source.code.matchAll(/triggerSlash\s*\(\s*([\s\S]{0,200}?)\)/g)) {
      triggerSlashSites++
      const argument = match[1] ?? ''
      // Every leading `/name` in the argument, including multi-command pipelines.
      const names = [...argument.matchAll(/\/([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(m => m[1])
      if (names.length === 0) { unparsed.push(argument.replace(/\s+/g, ' ').slice(0, 70)); continue }
      for (const name of names) {
        commandCalls.set(name, (commandCalls.get(name) ?? 0) + 1)
        commandCards.set(name, (commandCards.get(name) ?? new Set()).add(source.card))
      }
    }
  }
  console.log(`  triggerSlash call sites: ${triggerSlashSites}`)
  if (triggerSlashSites === 0) console.log('  none in this corpus.')
  else {
    console.log('  cards  calls  command')
    for (const [name, cards] of [...commandCards].sort((a, b) => b[1].size - a[1].size || (commandCalls.get(b[0]) ?? 0) - (commandCalls.get(a[0]) ?? 0))) {
      console.log(`  ${String(cards.size).padStart(5)}  ${String(commandCalls.get(name) ?? 0).padStart(5)}  /${name}`)
    }
    if (unparsed.length) console.log(`  arguments with no literal command (computed): ${unparsed.length}`)
    for (const u of unparsed.slice(0, 5)) console.log(`     ${u}`)
  }
}

/*
 * Run as a program, not as an import. The census half scans the corpus and
 * prints; an importer (`census-inputs.test.ts`) must be able to take the
 * module's exported inputs without any of that happening. The `argv[1]`
 * comparison is what `node scripts/th-member-census.mjs` and
 * `npm run census:th-members` both satisfy, and what an import does not.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
