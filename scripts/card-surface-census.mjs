/**
 * All four surfaces a card script can reach, counted by **source** and split
 * into the two columns a card's code actually arrives in.
 *
 *   node scripts/card-surface-census.mjs
 *   node scripts/card-surface-census.mjs --verbose      # every name, every source
 *
 * Skips when no corpus is present. Always exits 0: a caliper, not a test.
 *
 * ## WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT REPEAT
 *
 * Two per-member audits preceded this and it is not a third:
 *
 * - **TH-SURFACE-AUDIT** (+ `th-surface-audit.mjs`) — Tavern Helper's 171
 *   declared members, one row each, with upstream's declaration site and Iris's
 *   status;
 * - **ST-CONTEXT-SURFACE-AUDIT** (+ `st-context-audit.mjs`) — the
 *   `getContext()` 145, the host-page globals and the bare library globals, one
 *   row each, with the gap list graded P0/P1/P2.
 *
 * Both were retired on 2026-09-11 by decision: their pull requests (#50, #51)
 * closed unmerged on 2026-09-09 and their branches were deleted, so neither
 * file is in this tree — which is why they are named without their paths here:
 * `md-references.test.ts` checks that every `.md` a source comment names
 * exists, and it is right to. The texts stay frozen at the PRs' head commits
 * (`4840297`, `c91d7b5`; `git fetch origin pull/50/head`). The standing
 * per-member account is this report's 用到 · 没建 tables plus the ledger, and
 * `notes/apps/iris-web/CARD-SURFACE.md` says so in one place.
 *
 * **Those two owned the verdicts; the ledger owns them now.** A name's status,
 * its upstream semantics and whether it should be built are decided in
 * `DEVIATIONS.md`'s family entries; this file must not restate them, because
 * two documents answering one question drift and then the reader has to decide
 * which is stale.
 *
 * What this adds is the *population* and the *unit*:
 *
 * 1. **Two code populations neither audit reads.** Both scan card scripts, card
 *    regex source text, rendered chat interfaces and sample cards. Neither
 *    scans **preset regexes** (`OpenAI Settings/*.json` →
 *    `extensions.regex_scripts[].replaceString`) or **disk world book entries**
 *    (`worlds/*.json` → `entries[].content`). Both carry code in this corpus,
 *    and the code in them reaches for members no card reaches for: the only
 *    `parent.postMessage` and the only `triggerSlash` in a preset regex, and a
 *    world book that reads `chatMetadata` / `saveMetadata` sixteen times. A
 *    census whose population is "cards" cannot see any of it, and reports it as
 *    absent — which is the same output as "nobody uses it".
 * 2. **Two columns, always both.** A member used only from interface text and a
 *    member used only from a script body need different work (one is a
 *    `<script>` in rendered markup with no module scope, the other a card
 *    script with a run token), and a single "cards" column hides which. This
 *    project has produced three tidy wrong zeros by scanning `extractScripts`
 *    alone.
 * 3. **The unit is the source**, and a source is a *card*, a *preset* or a
 *    *world book* — not a call site. One card calling a member two hundred
 *    times is one source's worth of breakage. Identical bodies deduplicate by
 *    content hash first, because one script pasted into nine cards would
 *    otherwise read as nine independent votes.
 *
 * ## OUR SIDE IS EXTRACTED FROM OUR OWN SOURCE, AND REFUSES RATHER THAN SHRINKS
 *
 * Every "built" list is read out of the implementation — `MEMBER_KINDS` in
 * `identity.ts`, the two proxies' dispatch branches in `frame.ts`, the seeded
 * globals in `preset-entry.ts` and `frame-entry.ts`. Brittle against **our**
 * source, which is the more dangerous direction: we refactor far more often
 * than upstream does, and a half-working extractor answers with a shorter
 * built list, which silently turns "unbuilt and used" into the majority finding.
 *
 * So each extraction has a floor, and a floor that fails stops the report
 * instead of shading it. Conclusions already recorded do not expire — they were
 * true of the revision measured — but **no new number may be quoted until the
 * extraction is repaired and re-run**.
 *
 * ## THE MATCHING RULES, INCLUDING WHAT IS EXCLUDED AND WHY
 *
 * The parent face is where a naive detector is most confidently wrong, and the
 * prototype of this script was: it counted `parent.replaceChild` (28 hits) and
 * `parent.__list` (8) as host-global reads. Neither is: the first is a DOM
 * node's `parentNode` walked with `.parent`, the second a plain object. So a
 * bare `parent.` / `top.` is admitted only when
 *
 * - it is **not a property access** — `(^|[^\w$.])` before it, which drops
 *   `node.parent.replaceChild` outright; and
 * - the body does **not declare its own** `parent` or `top` (`var/let/const`,
 *   a function parameter, or a `for` binding). A body that does is a body where
 *   the bare spelling means the local, and its hits are *flagged and set aside*
 *   rather than counted — the print says how many, because "excluded" and
 *   "never happened" must not look alike.
 *
 * `window.parent.X` / `top.X` through an explicit window chain is always
 * admitted; a local named `window` is not a thing the corpus does.
 *
 * **Aliases are resolved**, because the corpus reads the host window through
 * one more than half the time: `var _pw = window.parent`, `var hostWindow =
 * window.parent || window`, `var tw = window.parent`. An alias is only taken
 * when the assignment ends *at* the parent expression — `var _pd =
 * window.parent.document` aliases the document, not the window, and admitting
 * it would put the document's members on the parent face.
 *
 * The `getContext()` face resolves the same way: a zero-argument
 * `getContext()` assigned to a name makes that name an alias.
 * `canvas.getContext('2d')` is not zero-argument and creates none — the
 * prototype's `ctx.fillStyle` / `ctx.arc` rows came from exactly that, and they
 * are the reason the parenthesis is checked rather than the name.
 *
 * **Known blind spot, shared with both audits**: `const { chat } =
 * getContext()` destructuring is not matched. Zero hits in this corpus, and it
 * stays written down because a blind spot nobody has recorded reads as a zero.
 *
 * @module scripts/card-surface-census
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { decodeCardPng, normalizeCard } from '../packages/iris-character/src/index.ts'
import { extractScripts } from '../packages/iris-script/src/index.ts'
import { parseChatFile } from '../packages/iris-persistence/src/index.ts'
import { PLACEMENT, applyRegexScripts, orderScripts } from '../packages/iris-regex/src/index.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const verbose = process.argv.includes('--verbose')

const UPSTREAM = process.env.IRIS_CORPUS ?? 'E:/sillyTavern/SillyTavern'
const ST = `${UPSTREAM}/data/default-user`
/*
 * Iris's own data directory, overridable — and it has to be, because this repo
 * is worked in **git worktrees** and the data directory is gitignored. In a
 * worktree `${ROOT}apps/iris/data` does not exist, so this population is simply
 * empty there and the run says so rather than reporting a smaller corpus as a
 * smaller answer.
 */
const IRIS_DATA = `${process.env.IRIS_DATA_DIR ?? `${ROOT}apps/iris/data`}/default-user`

/** Where each population lives, per corpus. A missing directory is skipped. */
const CORPORA = [
  { label: 'st', cards: `${ST}/characters`, chats: `${ST}/chats`, presets: `${ST}/OpenAI Settings`, worlds: `${ST}/worlds` },
  { label: 'iris', cards: `${IRIS_DATA}/characters`, chats: `${IRIS_DATA}/chats`, presets: `${IRIS_DATA}/presets`, worlds: `${IRIS_DATA}/worlds` },
]

if (!CORPORA.some(corpus => existsSync(corpus.cards))) {
  console.log('card-surface-census: skipped — no card corpus at')
  for (const corpus of CORPORA) console.log(`  ${corpus.cards}`)
  console.log('Expected on any machine but the operator machine. Set IRIS_CORPUS to point elsewhere.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 1. The four declared surfaces, and what Iris has built of each
// ---------------------------------------------------------------------------

/** Read a source file of ours, or stop the run saying which one went missing. */
const ours = (path) => {
  try {
    return readFileSync(`${ROOT}${path}`, 'utf8')
  } catch {
    console.log(`card-surface-census: cannot read ${path} — the extraction is broken, no numbers follow`)
    process.exit(0)
  }
}

/**
 * The names in one `readonly string[]` literal, bounded at its closing bracket.
 *
 * Bounded on purpose. The older caliper (`th-member-census.mjs`, now fixed the
 * same way) sliced from the constant's name to the **end of the file**, so a
 * second array anywhere below it was silently absorbed — 171 names became 316
 * the moment `upstream-surface.ts` gained the context list, and a 316-name
 * surface reports most of itself as "declared but never used", which reads as a
 * finding.
 * @param {string} source - the module text.
 * @param {string} name - the exported constant.
 * @returns {string[]} the quoted names inside that literal.
 */
function namesInArray(source, name) {
  const at = source.indexOf(`${name}: readonly string[] = [`)
  if (at === -1) return []
  const end = source.indexOf('\n]', at)
  const body = source.slice(at, end === -1 ? source.length : end)
  return [...body.matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map(match => match[1])
}

/** Every `property === 'name'` in a slice of `frame.ts`, minus the type test. */
function trapNames(source, fromMarker, toMarker) {
  const from = source.indexOf(fromMarker)
  const to = source.indexOf(toMarker, from === -1 ? 0 : from)
  if (from === -1 || to === -1) return []
  return [
    ...new Set(
      [...source.slice(from, to).matchAll(/property === '([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map(match => match[1]),
    ),
  ].filter(name => name !== 'symbol')
}

const surfaceSource = ours('apps/iris-web/src/sandbox/upstream-surface.ts')
const identitySource = ours('apps/iris-web/src/sandbox/identity.ts')
const frameSource = ours('apps/iris-web/src/sandbox/frame.ts')
const cardApiSource = ours('apps/iris-web/src/sandbox/card-api.ts')
const presetGlobalsSource = ours('apps/iris-web/src/sandbox/preset-globals.ts')
const presetEntrySource = ours('apps/iris-web/src/sandbox/preset-entry.ts')
const frameEntrySource = ours('apps/iris-web/src/sandbox/frame-entry.ts')

/** ① Tavern Helper's declared surface, and the members Iris classifies. */
const TH_DECLARED = namesInArray(surfaceSource, 'UPSTREAM_MEMBERS')
const kindsBlock = identitySource.slice(
  identitySource.indexOf('MEMBER_KINDS'),
  identitySource.indexOf('export function identityMembers'),
)
const TH_BUILT = new Set(
  [...kindsBlock.matchAll(/^\s*'?([A-Za-z_$][A-Za-z0-9_$]*)'?\s*:\s*'(identity|shared)'/gm)].map(match => match[1]),
)
for (const name of namesInArray(identitySource, 'FRAME_MEMBERS')) TH_BUILT.add(name)

/** ② upstream's `getContext()` keys, and what the facade answers. */
const CTX_DECLARED = namesInArray(surfaceSource, 'UPSTREAM_CONTEXT_MEMBERS')
/*
 * Three sources, because the facade answers from three places and a list that
 * knew one of them would report the other two as gaps:
 *
 * - the proxy's own dispatch branches (`property === 'x'` between the facade's
 *   declaration and its `set` trap);
 * - the routed actions — `CARD_METHODS` minus `OFF_ST_SURFACE`, which is what
 *   `isOnSillyTavernSurface` computes;
 * - the snapshot's fields, which fall through to `Object.hasOwn(fields, …)`.
 *   Read from the protocol's `ScriptContext` rather than listed here.
 */
const facadeBranches = trapNames(
  frameSource,
  'const sillyTavern = new Proxy',
  'set(_target, property): boolean {',
)
const cardMethods = [
  ...new Set(
    [
      ...cardApiSource
        .slice(cardApiSource.indexOf('CARD_METHODS'), cardApiSource.indexOf('OFF_ST_SURFACE'))
        .matchAll(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*):/gm),
    ].map(match => match[1]),
  ),
]
const offStSurface = (() => {
  const at = cardApiSource.indexOf('OFF_ST_SURFACE: readonly string[] = [')
  const end = cardApiSource.indexOf('\n]', at)
  return new Set([...cardApiSource.slice(at, end).matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map(match => match[1]))
})()
/*
 * The snapshot's own fields, which the facade answers by falling through to
 * `Object.hasOwn(fields, property)` — so a field is a built member even though
 * no branch names it.
 *
 * Read from `views.ts`, where the interface actually lives. The first version
 * of this read `index.ts`, found the file, found no interface, and returned an
 * empty list **without saying so** — which reported `chat` (38 calls, 4
 * sources) and `characters` as unbuilt members of the getContext surface. A
 * clean zero from a wrong path is indistinguishable from a real gap, so the
 * count is a floor below.
 */
const protocolSource = ours('packages/iris-protocol/src/views.ts')
const snapshotFields = (() => {
  const at = protocolSource.indexOf('export interface ScriptContext')
  if (at === -1) return []
  const end = protocolSource.indexOf('\n}', at)
  return [...protocolSource.slice(at, end).matchAll(/^ {2}(?:readonly )?([A-Za-z_$][A-Za-z0-9_$]*)\??:/gm)].map(
    match => match[1],
  )
})()
const CTX_BUILT = new Set([
  ...facadeBranches,
  ...cardMethods.filter(name => !offStSurface.has(name)),
  ...snapshotFields,
])

/** ③ the virtual parent's bridged surface. */
const PARENT_BRIDGED = new Set([
  ...trapNames(frameSource, 'const virtualParent = new Proxy', 'set(_target, property, value): boolean {'),
  ...namesInArray(frameSource, 'VIRTUAL_PARENT_SCHEDULER_MEMBERS'),
  ...[
    ...frameSource
      .slice(
        frameSource.indexOf('export const VIRTUAL_PARENT_SCHEDULER_MEMBERS'),
        frameSource.indexOf('] as const', frameSource.indexOf('export const VIRTUAL_PARENT_SCHEDULER_MEMBERS')),
      )
      .matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g),
  ].map(match => match[1]),
])

/** ④ the bare globals: what upstream seeds, and what Iris puts in the realm. */
const BARE_EXPECTED = namesInArray(presetGlobalsSource, 'EXPECTED_GLOBALS')
const BARE_BUILT = new Set([
  ...[...presetEntrySource.matchAll(/^host\['([^']+)'\]\s*=/gm)].map(match => match[1]),
  ...[...frameEntrySource.matchAll(/host\['([^']+)'\]\s*=/g)].map(match => match[1]),
  // `z` is published through an accessor rather than an assignment, so the
  // pattern above cannot see it. Named here with its call site instead of being
  // silently missing, which would report the corpus's 17 `z` sources as a gap.
  ...(presetEntrySource.includes('publishZodGlobal(host') ? ['z'] : []),
  // The core list of shadowed names in `frame.ts` — `parent`, `SillyTavern`,
  // `EjsTemplate`, `fetch`, the dialog trio and the rest.
  ...[
    ...frameSource
      .slice(frameSource.indexOf('const core = ['), frameSource.indexOf('] as const', frameSource.indexOf('const core = [')))
      .matchAll(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g),
  ].map(match => match[1]),
])

/** Floors. A short list here would turn a working member into a reported gap. */
const FLOORS = [
  ['UPSTREAM_MEMBERS', TH_DECLARED.length, 150],
  ['MEMBER_KINDS', TH_BUILT.size, 45],
  ['UPSTREAM_CONTEXT_MEMBERS', CTX_DECLARED.length, 130],
  ['the facade surface', CTX_BUILT.size, 20],
  ['ScriptContext fields', snapshotFields.length, 10],
  ['the virtual parent', PARENT_BRIDGED.size, 18],
  ['EXPECTED_GLOBALS', BARE_EXPECTED.length, 8],
  ['the seeded globals', BARE_BUILT.size, 12],
]
const short = FLOORS.filter(([, size, floor]) => size < floor)
if (short.length > 0) {
  console.log('card-surface-census: an extraction came back short, so no numbers follow.')
  for (const [label, size, floor] of short) {
    console.log(`  ${label}: ${String(size)} names, expected at least ${String(floor)}`)
  }
  console.log('  Repair the extraction against the current source before quoting anything.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. The corpus: five populations, two columns
// ---------------------------------------------------------------------------

/**
 * One body of code to scan.
 *
 * `column` is the report's two-column split: `script` is a card script body,
 * `interface` is everything that arrives as text a card renders — its own
 * display regexes, the interfaces those regexes produce in a real chat, preset
 * regexes and world book entries.
 * @typedef {{owner: string, kind: string, column: 'script'|'interface', origin: string, code: string}} Source
 */

/** @type {Source[]} */
const sources = []
const seenBodies = new Set()
let duplicateBodies = 0

/** Add a body unless an identical one has already been counted. */
function addSource(owner, kind, column, origin, code) {
  const text = String(code ?? '')
  if (text.trim().length === 0) return
  const hash = createHash('sha1').update(text).digest('hex')
  if (seenBodies.has(hash)) {
    duplicateBodies += 1
    return
  }
  seenBodies.add(hash)
  sources.push({ owner, kind, column, origin, code: text })
}

/** A card's own name, which is how the two audits key a card. */
function cardOwner(card, file) {
  const name = card?.data?.name ?? card?.name
  return typeof name === 'string' && name.trim().length > 0 ? name : file
}

for (const corpus of CORPORA) {
  // — card script bodies, and the card's own regex source text —
  if (existsSync(corpus.cards)) {
    for (const file of readdirSync(corpus.cards).filter(name => name.toLowerCase().endsWith('.png'))) {
      let card
      try {
        card = normalizeCard(decodeCardPng(readFileSync(join(corpus.cards, file))))
      } catch {
        continue
      }
      const owner = cardOwner(card, file)
      for (const script of extractScripts(card).scripts) {
        addSource(owner, 'card', 'script', `script:${script.name}`, script.content)
      }
      /*
       * The card's own display regexes, as **source text** — whether or not a
       * local chat ever rendered them. This is the population the older card
       * census lacked, and it is where three of the measured gaps live: a card's
       * interface code is in its regex whether or not this machine happens to
       * have a conversation that triggered it.
       */
      for (const [at, regex] of (card?.data?.extensions?.regex_scripts ?? []).entries()) {
        addSource(owner, 'card', 'interface', `card-regex[${String(at)}]`, regex?.replaceString)
      }
    }
  }

  // — the interfaces a real chat actually rendered —
  if (existsSync(corpus.chats) && existsSync(corpus.cards)) {
    const cardFor = (dir) => {
      for (const candidate of [dir, dir.replace(/\d+$/, '')]) {
        const path = join(corpus.cards, `${candidate}.png`)
        if (!existsSync(path)) continue
        try {
          return normalizeCard(decodeCardPng(readFileSync(path)))
        } catch {
          return undefined
        }
      }
      return undefined
    }
    for (const dir of readdirSync(corpus.chats, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const card = cardFor(dir.name)
      if (card === undefined) continue
      const owner = cardOwner(card, dir.name)
      const scripts = orderScripts(
        (card?.data?.extensions?.regex_scripts ?? []).map(script => ({ script, type: 'character' })),
      )
      if (scripts.length === 0) continue
      for (const file of readdirSync(join(corpus.chats, dir.name)).filter(name => name.endsWith('.jsonl'))) {
        let chat
        try {
          chat = parseChatFile(readFileSync(join(corpus.chats, dir.name, file), 'utf8'))
        } catch {
          continue
        }
        chat.messages.forEach((message, index) => {
          const depth = chat.messages.length - 1 - index
          const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0
          const raw = Array.isArray(message.swipes) && message.swipes.length > 0
            ? String(message.swipes[swipeId] ?? message.mes ?? '')
            : String(message.mes ?? '')
          const rendered = applyRegexScripts(
            raw,
            message.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT,
            scripts,
            { isMarkdown: true, depth },
          )
          for (const match of rendered.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
            addSource(owner, 'card', 'interface', 'rendered', match[1])
          }
        })
      }
    }
  }

  // — preset regexes: a population neither audit reads —
  if (existsSync(corpus.presets)) {
    for (const file of readdirSync(corpus.presets).filter(name => name.endsWith('.json'))) {
      let preset
      try {
        preset = JSON.parse(readFileSync(join(corpus.presets, file), 'utf8'))
      } catch {
        continue
      }
      for (const [at, regex] of (preset?.extensions?.regex_scripts ?? []).entries()) {
        addSource(`preset:${file.replace(/\.json$/, '')}`, 'preset', 'interface', `preset-regex[${String(at)}]`, regex?.replaceString)
      }
    }
  }

  // — world book entries: the other population neither audit reads —
  if (existsSync(corpus.worlds)) {
    for (const file of readdirSync(corpus.worlds).filter(name => name.endsWith('.json'))) {
      let book
      try {
        book = JSON.parse(readFileSync(join(corpus.worlds, file), 'utf8'))
      } catch {
        continue
      }
      for (const [uid, entry] of Object.entries(book?.entries ?? {})) {
        addSource(`world:${file.replace(/\.json$/, '')}`, 'world', 'interface', `entry:${uid}`, entry?.content)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The detectors
// ---------------------------------------------------------------------------

/** The window hops a card takes on its way out of its frame. */
const CHAIN = '(?:(?:window|self|globalThis|parent|top)\\s*(?:\\?\\s*)?\\.\\s*)*'
/** Not a property of something else, and not the tail of a longer identifier. */
const OPEN = '(?:^|[^A-Za-z0-9_$.])'
/**
 * A **used** bare identifier: called, or read as an object or an array.
 *
 * Only for the two faces whose names are reached bare (Tavern Helper's members
 * and the library globals). There the receiver is nothing, so this is the whole
 * of what separates `getWorldbook(…)` from the word appearing in a comment.
 */
const AFTER = '\\s*(?:\\?\\s*)?[(.\\[]'

/**
 * A member read off a **named receiver**: anything but more identifier.
 *
 * For the `SillyTavern` and `parent` faces, where the receiver has already
 * disambiguated the read, and where requiring a call or a member access after
 * the name **systematically hides the scalars**. Half of both surfaces is
 * values rather than functions: `parent.innerWidth`, `parent.is_send_press`,
 * `ctx.name1`, and every `if (top.Mvu)` probe. With `AFTER` in force those read
 * as zero uses — `innerWidth` and `$` reported 0 sources here while the audit
 * beside this measured three cards each, and the difference was entirely this
 * regex.
 *
 * A truthiness probe therefore **counts as a use**, deliberately: a card that
 * tests `if (parent.toastr)` and takes the other branch on `undefined` is a
 * card whose feature silently does not happen, which is the failure this whole
 * census exists to find. "Reached for" is the question, not "called".
 */
const WORD_END = '(?![A-Za-z0-9_$])'

const escape = name => name.replace(/[$\\^.*+?()[\]{}|]/g, '\\$&')

/** Bodies where a name is the card's own function, with the name. */
const selfDeclared = new Map()

/**
 * Does this body define its own **function** of that name?
 *
 * The bare-name faces have no receiver to disambiguate them, so a card that
 * writes its own `deletePreset` is indistinguishable from one calling Tavern
 * Helper's — and the corpus does exactly that: 创世回廊's preset panel declares
 * `const deletePreset = (id) => {…}` and `const loadPreset = (preset) => {…}`
 * for its own UI, and both appeared in this census's "used but unbuilt" column,
 * beside a real gap, indistinguishable from it.
 *
 * **Function-shaped declarations only**, and that restriction is the whole
 * design. A plain `const X = something` is an *alias* far more often than a
 * redefinition — `const _ = window.parent._` and `const Mvu =
 * getMvuInstance()` are both real reaches for the host's member through a local
 * name — so suppressing those would delete true uses to remove false ones. A
 * `function`, an arrow, an object method or a class method is a definition.
 *
 * The left boundary is load-bearing: without it, `_writeSurveillanceToMvu(a) {`
 * declared `Mvu` and `async sendToSillyTavern(m) {` declared `SillyTavern`,
 * which suppressed two real rows in the card that has the most of both.
 * @param {string} code - the body.
 * @param {string} name - the member.
 * @returns {boolean} whether the body defines it.
 */
function declaresOwnFunction(code, name) {
  const bare = escape(name)
  const shapes = [
    `function\\s*\\*?\\s*${bare}\\s*\\(`,
    `(?:var|let|const)\\s+${bare}\\s*=\\s*(?:async\\s+)?function\\b`,
    `(?:var|let|const)\\s+${bare}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][A-Za-z0-9_$]*)\\s*=>`,
    `${bare}\\s*:\\s*(?:async\\s+)?function\\b`,
    `${bare}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`,
    /*
     * **No method-shorthand shape**, and its absence is measured rather than an
     * omission. `NAME(…) {` looks like `methods: { deletePreset(id) { … } }`,
     * and it also looks like `await updateWorldbookWith(book, cb => { … })` —
     * a *call* whose last argument is an arrow function, which is how half of
     * this API is called. It suppressed four real `updateWorldbookWith` sites
     * in 魔法少女的扣扣审判 before it was dropped.
     *
     * The cost of dropping it: a card's own class method (銀麒赎世's
     * `async generate(prompt, options)`) is counted as reaching the member of
     * that name. That direction overstates a *built* member's usage, which
     * misleads nobody about what to build next; the other direction hides a
     * gap. When the two errors are not symmetric, take the one that fails
     * towards the column that gets read.
     */
  ]
  return new RegExp(`(?<![A-Za-z0-9_$.])(?:${shapes.join('|')})`).test(code)
}

/** Note a suppression so the exclusion appears in the report. */
function noteSelfDeclared(name, owner) {
  if (!selfDeclared.has(name)) selfDeclared.set(name, new Set())
  selfDeclared.get(name).add(owner)
}

/** ① `getWorldbook(…)`, `TavernHelper.getWorldbook(…)`, `parent.getWorldbook(…)`. */
function reachesTh(code, name, owner) {
  if (declaresOwnFunction(code, name)) {
    noteSelfDeclared(name, owner)
    return 0
  }
  const pattern = new RegExp(`${OPEN}${CHAIN}(?:TavernHelper\\s*(?:\\?\\s*)?\\.\\s*)?${escape(name)}${AFTER}`, 'g')
  return [...code.matchAll(pattern)].length
}

/**
 * Names a body binds itself, so the bare spelling means the local.
 *
 * `var parent = node.parentNode` and `function f(parent) {…}` both make
 * `parent.replaceChild(…)` a DOM call rather than a host-global read. The
 * prototype of this script counted 28 of them as host reads.
 * @param {string} code - the body.
 * @returns {Set<string>} which of `parent` / `top` the body shadows.
 */
function shadowedWindows(code) {
  const shadowed = new Set()
  for (const name of ['parent', 'top']) {
    const declared = new RegExp(
      `(?:var|let|const)\\s+${name}\\b|function[^(]*\\([^)]*\\b${name}\\b[^)]*\\)|\\(\\s*${name}\\s*(?:,|\\)\\s*=>)`,
    )
    if (declared.test(code)) shadowed.add(name)
  }
  return shadowed
}

/**
 * Names a body aliases the host window to.
 *
 * Three rules, and the second and third are each here because the version
 * without them put string and DOM methods on the host-global face:
 *
 * 1. the assignment has to **end** at the parent expression. `_pw =
 *    window.parent` and `hostWindow = window.parent || window` are the host
 *    window; `_pd = window.parent.document` is the document, and admitting it
 *    would move every `_pd.getElementById` onto this face;
 * 2. it has to be a **declaration** (`var` / `let` / `const`). Without that,
 *    `el.style.top = top` and `pos = top` both read as aliases, and layout code
 *    assigns from a local `top` constantly;
 * 3. the window it aliases must not be one the body **shadows**. A body holding
 *    `const top = rect.top` then writing `const p = top` was aliasing a number,
 *    and `p.replace(…)` / `p.trim()` / `p.match(…)` then appeared as host
 *    globals — 25 such rows in the first run of this script, ordinary string
 *    and DOM members every one;
 * 4. the alias name must be **at least two characters** and must never appear as
 *    a function parameter. This scan has no scope tracking, and minified
 *    interface bundles reuse single letters everywhere: one `const e = top` in
 *    创世回廊's bundle made every `e.replace(…)`, `e.trim()` and `e.match(…)` in
 *    it — 53 sites across a dozen unrelated functions, each with its own
 *    parameter `e` — read as host-global members. Rejected rather than resolved,
 *    because resolving it is a scope analysis and this is a caliper.
 *
 * **What is deliberately *not* a rejection: more than one binding.** The first
 * version required exactly one, and that threw away the corpus's most common
 * host-window idiom. `win` and `targetWindow` are each declared three or four
 * times in one body — `window.parent || window`, then `window`, then
 * `getCore().window`, then `btn.ownerDocument.defaultView || window` — because
 * the card is written to work both inside a frame and standalone. Rejecting
 * them cut `parent.SillyTavern` from 4 sources / 84 calls to 2 / 4, and
 * `parent.TavernHelper` to zero, in a corpus where the audit beside this
 * measured 6 cards and 4. Every one of those bindings is a window; the rule was
 * measuring how defensively the card was written.
 *
 * Bodies whose alias has bindings this rule cannot verify are counted and
 * printed, so the residual uncertainty is visible rather than assumed away.
 * @param {string} code - the body.
 * @param {Set<string>} shadowed - windows this body binds itself.
 * @returns {string[]} alias identifiers.
 */
function parentAliases(code, shadowed) {
  const tail = '\\s*(?:\\|\\|\\s*(?:window|self|globalThis)\\s*)?(?=[;,)\\n]|$)'
  /*
   * Two patterns, because shadowing only reaches the bare spelling.
   *
   * `var targetWindow = window.parent || window` says what it means whatever
   * else the body calls `parent`, while `var x = parent` means the local when
   * the body has one. Running both through the shadow test cost the corpus's
   * largest card its whole parent face: 銀麒赎世's phone UI declares `const top`
   * for a CSS offset, which suppressed `targetWindow` and with it 41
   * `targetWindow.SillyTavern` reads — a card the audit beside this counts among
   * the six that reach `parent.SillyTavern`.
   */
  const patterns = [
    new RegExp(
      `(?:var|let|const)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:window|self|globalThis)\\s*\\.\\s*(?:parent|top)\\b${tail}`,
      'g',
    ),
  ]
  const bare = ['parent', 'top'].filter(name => !shadowed.has(name))
  if (bare.length > 0) {
    patterns.push(
      new RegExp(`(?:var|let|const)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:${bare.join('|')})\\b${tail}`, 'g'),
    )
  }
  const candidates = [
    ...new Set(patterns.flatMap(pattern => [...code.matchAll(pattern)].map(match => match[1]))),
  ].filter(name => !['parent', 'top', 'window', 'self', 'globalThis'].includes(name))
  return candidates.filter(name => {
    const asParameter = new RegExp(
      `function\\b[^(){]*\\([^)]*\\b${escape(name)}\\b[^)]*\\)|\\([^)]*\\b${escape(name)}\\b[^)]*\\)\\s*=>|\\b${escape(name)}\\s*=>`,
    )
    if (name.length < 2 || asParameter.test(code)) {
      ambiguousAliases.add(name)
      return false
    }
    // Counted, not rejected: see the note above on multiply-bound aliases.
    const bindings = [...code.matchAll(new RegExp(`(?:var|let|const)\\s+${escape(name)}\\s*=`, 'g'))].length
    if (bindings > 1) multiplyBoundAliases.add(name)
    return true
  })
}

/** Alias names dropped as ambiguous, printed so the exclusion stays visible. */
const ambiguousAliases = new Set()
/** Aliases taken despite several bindings in one body, printed for the same reason. */
const multiplyBoundAliases = new Set()

/** ③ `window.parent.X`, a non-property `parent.X`, or an alias's `X`. */
function reachesParent(code, name, aliases, shadowed) {
  let hits = 0
  const chained = new RegExp(
    `(?:window|self|globalThis)\\s*(?:\\?\\s*)?\\.\\s*(?:parent|top)\\s*(?:\\?\\s*)?\\.\\s*${escape(name)}${WORD_END}`,
    'g',
  )
  hits += [...code.matchAll(chained)].length
  for (const window of ['parent', 'top']) {
    if (shadowed.has(window)) continue
    const bare = new RegExp(`${OPEN}${window}\\s*(?:\\?\\s*)?\\.\\s*${escape(name)}${WORD_END}`, 'g')
    hits += [...code.matchAll(bare)].length
  }
  for (const alias of aliases) {
    const through = new RegExp(`${OPEN}${escape(alias)}\\s*(?:\\?\\s*)?\\.\\s*${escape(name)}${WORD_END}`, 'g')
    hits += [...code.matchAll(through)].length
  }
  return hits
}

/**
 * Names a body aliases `getContext()`'s result to.
 *
 * **Zero-argument only.** `canvas.getContext('2d')` is the other call of that
 * name in this corpus, and taking it as an alias put `fillStyle`, `arc`,
 * `beginPath` and `clearRect` on the SillyTavern face in the prototype — four
 * rows that look exactly like real findings.
 * @param {string} code - the body.
 * @returns {string[]} alias identifiers.
 */
function contextAliases(code) {
  const fromCall = /(?:var|let|const)?\s*\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[^;\n]{0,80}?getContext\s*\(\s*\)/g
  const fromGlobal = /(?:var|let|const)?\s*\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:(?:window|self|globalThis|parent|top)\s*\.\s*)*SillyTavern\b\s*(?=[;,)\n]|$)/g
  return [...new Set([...code.matchAll(fromCall), ...code.matchAll(fromGlobal)].map(match => match[1]))].filter(
    name => name !== 'SillyTavern',
  )
}

/** ② `SillyTavern.X`, `getContext().X`, or an alias's `X`. */
function reachesContext(code, name, aliases) {
  let hits = 0
  const direct = new RegExp(`${OPEN}${CHAIN}SillyTavern\\s*(?:\\?\\s*)?\\.\\s*${escape(name)}${WORD_END}`, 'g')
  hits += [...code.matchAll(direct)].length
  const chained = new RegExp(`getContext\\s*\\(\\s*\\)\\s*(?:\\?\\s*)?\\.\\s*${escape(name)}${WORD_END}`, 'g')
  hits += [...code.matchAll(chained)].length
  for (const alias of aliases) {
    const through = new RegExp(`${OPEN}${escape(alias)}\\s*(?:\\?\\s*)?\\.\\s*${escape(name)}${WORD_END}`, 'g')
    hits += [...code.matchAll(through)].length
  }
  return hits
}

/** ④ a bare global, called or read as an object. */
function reachesBare(code, name, owner) {
  if (declaresOwnFunction(code, name)) {
    noteSelfDeclared(name, owner)
    return 0
  }
  const pattern = new RegExp(`${OPEN}${escape(name)}${AFTER}`, 'g')
  let hits = 0
  for (const match of code.matchAll(pattern)) {
    // `${x}` in a template literal opens with `{`, and `$` is a global name, so
    // the template's own punctuation would otherwise read as a jQuery call.
    if (match[0].endsWith('{')) continue
    hits += 1
  }
  return hits
}

// ---------------------------------------------------------------------------
// 4. The fixture: shapes the detectors must see, and shapes they must not
// ---------------------------------------------------------------------------

/*
 * Scanning the corpus can only ever show that nothing was found, and "there is
 * none" and "the detector is blind to this shape" are the same output. So each
 * detector is handed source written on purpose. Every `mustNotSee` row below is
 * a shape the prototype of this script counted as a real hit.
 */
const FIXTURE = [
  ['th', () => reachesTh('await TavernHelper.getWorldbook("b")', 'getWorldbook', 'fixture') > 0, true, 'through the namespace'],
  ['th', () => reachesTh('getWorldbook(name)', 'getWorldbook', 'fixture') > 0, true, 'bare call'],
  ['th', () => reachesTh('window.parent.getWorldbook("b")', 'getWorldbook', 'fixture') > 0, true, 'out through the parent'],
  ['th', () => reachesTh('getWorldbookNames()', 'getWorldbook', 'fixture') > 0, false, 'a longer identifier'],
  ['th', () => reachesTh('myCache.getWorldbook("b")', 'getWorldbook', 'fixture') > 0, false, 'another object'],

  ['ctx', () => reachesContext('SillyTavern.getContext().chat.length', 'chat', []) > 0, true, 'the chained call'],
  ['ctx', () => reachesContext('top.SillyTavern.saveChat()', 'saveChat', []) > 0, true, 'a window hop'],
  [
    'ctx',
    () => {
      const code = 'const ctx = SillyTavern.getContext(); ctx.printMessages()'
      return reachesContext(code, 'printMessages', contextAliases(code)) > 0
    },
    true,
    'through an alias',
  ],
  [
    'ctx',
    () => {
      const code = 'const ctx = canvas.getContext("2d"); ctx.fillStyle = "red"; ctx.arc(1,2,3)'
      return reachesContext(code, 'arc', contextAliases(code)) > 0
    },
    false,
    'a canvas 2d context, which is not this surface',
  ],
  ['ctx', () => reachesContext('myOwn.chat.push(1)', 'chat', []) > 0, false, 'an unrelated receiver'],

  ['parent', () => reachesParent('window.parent.saveChat()', 'saveChat', [], new Set()) > 0, true, 'the window chain'],
  /*
   * A probe counts. It used to be a `mustNotSee` row, on the reasoning that a
   * bare `if (top.Mvu)` calls nothing — which is exactly backwards: the card
   * that probes and finds nothing takes its fallback and goes quiet, and that
   * silence is what this census is for. Requiring a call also hid every scalar
   * on both receiver faces (`innerWidth`, `is_send_press`, `name1`).
   */
  ['parent', () => reachesParent('if (top.Mvu) {}', 'Mvu', [], new Set()) > 0, true, 'a truthiness probe'],
  ['parent', () => reachesParent('const w = parent.innerWidth', 'innerWidth', [], new Set()) > 0, true, 'a scalar read'],
  ['parent', () => reachesParent('top.Mvu.data', 'Mvu', [], new Set()) > 0, true, 'a bare top read'],
  [
    'parent',
    () => reachesParent('parent.MvuExtra.x', 'Mvu', [], new Set()) > 0,
    false,
    'a longer member that starts with the name',
  ],
  [
    'parent',
    () => {
      const code = 'var _pw = window.parent; _pw.alert("hi")'
      return reachesParent(code, 'alert', parentAliases(code, shadowedWindows(code)), shadowedWindows(code)) > 0
    },
    true,
    'through a host-window alias',
  ],
  [
    'parent',
    () => {
      const code = 'var _pd = window.parent.document; _pd.getElementById("x")'
      return reachesParent(code, 'getElementById', parentAliases(code, shadowedWindows(code)), shadowedWindows(code)) > 0
    },
    false,
    'a document alias, whose members are not on this face',
  ],
  [
    'parent',
    () => reachesParent('node.parent.replaceChild(a, b)', 'replaceChild', [], new Set()) > 0,
    false,
    'a DOM node reached as a property',
  ],
  [
    'parent',
    () => {
      const code = 'var parent = node.parentNode; parent.replaceChild(a, b)'
      return reachesParent(code, 'replaceChild', parentAliases(code, shadowedWindows(code)), shadowedWindows(code)) > 0
    },
    false,
    'a local named parent',
  ],

  ['bare', () => reachesBare('$("#x").hide()', '$', 'fixture') > 0, true, 'a jQuery call'],
  ['bare', () => reachesBare('_.get(a, "b")', '_', 'fixture') > 0, true, 'a lodash member'],
  ['bare', () => reachesBare('const s = `${x}`', '$', 'fixture') > 0, false, 'a template literal'],
  ['bare', () => reachesBare('el.$.x', '$', 'fixture') > 0, false, 'a property named $'],
  ['bare', () => reachesBare('my_.map()', '_', 'fixture') > 0, false, 'an identifier ending in _'],
]

const fixtureFailures = FIXTURE.filter(([, run, expected]) => run() !== expected).map(
  ([face, , expected, label]) => `${expected ? 'MISSED' : 'FALSE+'}  ${face}: ${label}`,
)

// ---------------------------------------------------------------------------
// 5. Count
// ---------------------------------------------------------------------------

/** Per-source alias tables, computed once. */
const prepared = sources.map(source => ({
  ...source,
  ctxAliases: contextAliases(source.code),
  shadowed: shadowedWindows(source.code),
  parentAliases: parentAliases(source.code, shadowedWindows(source.code)),
}))

const shadowedBodies = prepared.filter(source => source.shadowed.size > 0).length

/**
 * Tally one face.
 * @param {string[]} declared - the names upstream declares.
 * @param {Set<string>} built - the names Iris answers.
 * @param {(source: object, name: string) => number} probe - hits in one body.
 * @returns {Map<string, {script: Set<string>, iface: Set<string>, kinds: Set<string>, calls: number}>}
 */
function tally(declared, built, probe) {
  const usage = new Map()
  for (const name of declared) usage.set(name, { script: new Set(), iface: new Set(), kinds: new Set(), calls: 0 })
  for (const source of prepared) {
    for (const name of declared) {
      const hits = probe(source, name)
      if (hits === 0) continue
      const entry = usage.get(name)
      entry.calls += hits
      entry.kinds.add(source.kind)
      if (source.column === 'script') entry.script.add(source.owner)
      else entry.iface.add(source.owner)
    }
  }
  return usage
}

const FACES = [
  {
    key: '①',
    label: '酒馆助手声明给卡脚本的接口（@types，171）',
    declared: TH_DECLARED,
    built: TH_BUILT,
    probe: (source, name) => reachesTh(source.code, name, source.owner),
    authority: 'TH-SURFACE-AUDIT（已退役 2026-09-11；冻结在 PR #50 头提交 4840297）',
  },
  {
    key: '②',
    label: 'SillyTavern.getContext() 成员（st-context.js，145）',
    declared: CTX_DECLARED,
    built: CTX_BUILT,
    probe: (source, name) => reachesContext(source.code, name, source.ctxAliases),
    authority: 'ST-CONTEXT-SURFACE-AUDIT §3.1（已退役 2026-09-11；冻结在 PR #51 头提交 c91d7b5）',
  },
  {
    key: '③',
    label: 'window.parent.X（宿主页面全局）',
    // The parent face has no upstream declaration list to walk: upstream's
    // parent *is* the whole SillyTavern page. So the names asked about are the
    // union of what Iris bridges and what the corpus reaches for, and the
    // corpus half is discovered rather than declared.
    declared: undefined,
    built: PARENT_BRIDGED,
    probe: (source, name) => reachesParent(source.code, name, source.parentAliases, source.shadowed),
    authority: 'ST-CONTEXT-SURFACE-AUDIT §3.2（已退役 2026-09-11；冻结在 PR #51 头提交 c91d7b5）',
  },
  {
    key: '④',
    label: '裸全局（upstream 每帧种下的库）',
    declared: BARE_EXPECTED,
    built: BARE_BUILT,
    probe: (source, name) => reachesBare(source.code, name, source.owner),
    authority: 'ST-CONTEXT-SURFACE-AUDIT §3.3（已退役 2026-09-11；冻结在 PR #51 头提交 c91d7b5）',
  },
]

/** Every `parent.X` / alias `.X` name the corpus reads, for face ③. */
function discoverParentNames() {
  const found = new Set()
  for (const source of prepared) {
    const patterns = [
      /(?:window|self|globalThis)\s*(?:\?\s*)?\.\s*(?:parent|top)\s*(?:\?\s*)?\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
    ]
    for (const window of ['parent', 'top']) {
      if (source.shadowed.has(window)) continue
      patterns.push(new RegExp(`${OPEN}${window}\\s*(?:\\?\\s*)?\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, 'g'))
    }
    for (const alias of source.parentAliases) {
      patterns.push(new RegExp(`${OPEN}${escape(alias)}\\s*(?:\\?\\s*)?\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, 'g'))
    }
    for (const pattern of patterns) for (const match of source.code.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

// ---------------------------------------------------------------------------
// 6. Print
// ---------------------------------------------------------------------------

const pad = (value, width) => String(value).padStart(width)

if (fixtureFailures.length > 0) {
  console.log('## DETECTOR FIXTURE FAILED — every number below is unreliable')
  for (const line of fixtureFailures) console.log(`  ${line}`)
  console.log('')
  console.log('  A missed shape reports as "0 sources", which reads exactly like')
  console.log('  "nobody uses it" — and that column decides what not to build.')
  console.log('')
} else {
  const seen = FIXTURE.filter(row => row[2]).length
  console.log(`## detector fixture: ${String(seen)} shapes seen, ${String(FIXTURE.length - seen)} correctly ignored`)
}

console.log('\n## corpus scanned (deduplicated by content hash)')
for (const corpus of CORPORA) {
  const present = ['cards', 'chats', 'presets', 'worlds'].filter(part => existsSync(corpus[part]))
  console.log(
    `  ${corpus.label.padEnd(5)} ${present.length === 0 ? 'absent' : present.join(', ')}`
    + (present.length === 4 ? '' : `   (missing: ${['cards', 'chats', 'presets', 'worlds'].filter(part => !present.includes(part)).join(', ') || 'none'})`),
  )
}
const byKind = kind => sources.filter(source => source.kind === kind)
const byColumn = column => sources.filter(source => source.column === column)
console.log(`  bodies                    ${pad(sources.length, 5)}   (script ${String(byColumn('script').length)} / interface ${String(byColumn('interface').length)})`)
console.log(`  identical bodies dropped  ${pad(duplicateBodies, 5)}`)
console.log(`  sources (cards)           ${pad(new Set(byKind('card').map(source => source.owner)).size, 5)}`)
console.log(`  sources (presets)         ${pad(new Set(byKind('preset').map(source => source.owner)).size, 5)}`)
console.log(`  sources (world books)     ${pad(new Set(byKind('world').map(source => source.owner)).size, 5)}`)
console.log(`  bodies shadowing parent/top, bare spelling set aside: ${String(shadowedBodies)}`)
console.log(
  `  host-window aliases dropped as ambiguous: ${String(ambiguousAliases.size)}`
  + (ambiguousAliases.size === 0 ? '' : ` (${[...ambiguousAliases].join(', ')})`),
)
console.log(
  `  host-window aliases taken with several bindings: ${String(multiplyBoundAliases.size)}`
  + (multiplyBoundAliases.size === 0 ? '' : ` (${[...multiplyBoundAliases].join(', ')})`),
)

for (const face of FACES) {
  const declared = face.declared ?? [...new Set([...face.built, ...discoverParentNames()])]
  const usage = tally(declared, face.built, face.probe)
  const used = declared.filter(name => usage.get(name).script.size + usage.get(name).iface.size > 0)
  const sourcesOf = name => usage.get(name).script.size + usage.get(name).iface.size

  console.log(`\n\n═══ ${face.key} ${face.label}`)
  console.log(`    逐成员账目曾在 ${face.authority}；现状以下表为准，此处只给来源计数与两列`)
  console.log(`    ${face.declared === undefined ? '桥接 + 语料读到' : '声明'} ${String(declared.length)}`
    + ` · Iris 建 ${String(declared.filter(name => face.built.has(name)).length)}`
    + ` · 语料用到 ${String(used.length)}`
    + ` · 用到但没建 ${String(used.filter(name => !face.built.has(name)).length)}`)

  const rows = [...used].sort((a, b) => sourcesOf(b) - sourcesOf(a) || usage.get(b).calls - usage.get(a).calls)
  const table = (label, names) => {
    if (names.length === 0) return
    console.log(`\n  ── ${label}`)
    console.log('     脚本  界面  调用  成员                             来源种类')
    for (const name of names) {
      const entry = usage.get(name)
      console.log(
        `     ${pad(entry.script.size, 4)}  ${pad(entry.iface.size, 4)}  ${pad(entry.calls, 4)}  ${name.padEnd(32)} ${[...entry.kinds].join(',')}`,
      )
      if (!verbose) continue
      const owners = [...entry.script].map(owner => `脚本:${owner}`).concat([...entry.iface].map(owner => `界面:${owner}`))
      for (const owner of owners) console.log(`             ${owner}`)
    }
  }

  table('用到 · 没建', rows.filter(name => !face.built.has(name)))
  table('用到 · 建了', rows.filter(name => face.built.has(name)))

  const unusedBuilt = declared.filter(name => face.built.has(name) && sourcesOf(name) === 0)
  const unusedUnbuilt = declared.filter(name => !face.built.has(name) && sourcesOf(name) === 0)
  console.log(`\n  ── 没用到 · 建了：${String(unusedBuilt.length)}`)
  if (unusedBuilt.length > 0) console.log(`     ${unusedBuilt.join(', ')}`)
  console.log(`  ── 没用到 · 没建：${String(unusedUnbuilt.length)}`)
  if (unusedUnbuilt.length > 0) console.log(`     ${unusedUnbuilt.join(', ')}`)
}

// ---------------------------------------------------------------------------
// 7. What the two new populations contribute on their own
// ---------------------------------------------------------------------------

/*
 * The reason this file exists, isolated so it can be checked: which names are
 * reached **only** from a preset regex or a world book entry — the two
 * populations no other census reads. A name in this list is invisible to every
 * other instrument in the tree.
 */
/*
 * Printed rather than merely applied, and printed **after** the faces because
 * that is when the tallies have run. Every one of these is a name the corpus
 * contains and this census does not count, so the list is the difference
 * between "nobody reaches for it" and "one source defines its own function of
 * that name" — and 创世回廊's `deletePreset` / `loadPreset` sat in the gap
 * column looking like the former, beside a real gap.
 */
console.log('\n\n═══ 源自身定义的同名函数（按口径不计入「够到宿主」）')
if (selfDeclared.size === 0) console.log('  none.')
else {
  for (const [name, owners] of [...selfDeclared].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${name.padEnd(24)} ${[...owners].join(', ')}`)
  }
}

console.log('\n\n═══ 只有预设正则 / 世界书条目才够到的名字（其他普查看不见的部分）')
const onlyNewPopulations = []
for (const face of FACES) {
  const declared = face.declared ?? [...new Set([...face.built, ...discoverParentNames()])]
  const usage = tally(declared, face.built, face.probe)
  for (const name of declared) {
    const entry = usage.get(name)
    if (entry.script.size + entry.iface.size === 0) continue
    if (entry.kinds.has('card')) continue
    onlyNewPopulations.push({
      face: face.key,
      name,
      built: face.built.has(name),
      kinds: [...entry.kinds].join(','),
      calls: entry.calls,
    })
  }
}
if (onlyNewPopulations.length === 0) {
  console.log('  none — every name the presets and world books reach for, a card reaches for too.')
} else {
  console.log('     面  建了  调用  成员                             来源种类')
  for (const row of onlyNewPopulations) {
    console.log(
      `     ${row.face}   ${row.built ? '是  ' : '否  '}  ${pad(row.calls, 4)}  ${row.name.padEnd(32)} ${row.kinds}`,
    )
  }
}
