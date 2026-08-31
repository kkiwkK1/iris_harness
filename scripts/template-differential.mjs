/**
 * Differential acceptance for `@iris/compat-prompt-template`.
 *
 * A script rather than a test, because it reads the operator's own SillyTavern
 * install — the 19 character cards and the extension's vendored engine. A test
 * that did that would pass or fail depending on whose machine it ran on, which
 * is why every test in this repository is hermetic. This is the other half: the
 * measurement those hermetic tests were derived from, re-runnable on demand.
 *
 *   node scripts/template-differential.mjs
 *   node scripts/template-differential.mjs --verbose     # show every difference
 *
 * Exits 0 when the corpus is absent (nothing to say), 0 when every comparable
 * field agrees, 1 when any disagrees.
 *
 * ## What this does and does not prove
 *
 * It renders every EJS-bearing field of the corpus twice — once through Iris's
 * real host path (fork, locked-down child, `vm` realm) and once through the
 * engine the operator's SillyTavern actually runs, extracted from the extension's
 * bundle — over an **identical environment**, and compares the output.
 *
 * So it isolates the *engine*: the patch layer, the compile options, the identity
 * `escape`, the `include` stub, whitespace slurping, and the scanner. It does
 * **not** independently verify the *environment* — `getvar`, `setvar`, `getwi`
 * and the rest are this package's transcription of upstream's `variables.ts`, and
 * running them against themselves would be circular. Those are covered by
 * transcription plus the hermetic unit tests, and their semantics were measured
 * separately. Saying so here rather than letting a green run imply more.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(ROOT, 'scripts', 'x.cjs'))

const ST = 'E:/sillyTavern/SillyTavern'
const CARDS = `${ST}/data/default-user/characters`
const WORLDS = `${ST}/data/default-user/worlds`
const VENDORED_EJS = `${ST}/public/scripts/extensions/third-party/ST-Prompt-Template/src/3rdparty/ejs.js`

const verbose = process.argv.includes('--verbose')
/**
 * Perturb the comparison side to prove this script can detect a difference.
 *
 * A differential that cannot fail is decoration. With `--self-check` the
 * comparison side is given EJS's real HTML escaping instead of upstream's
 * identity one — and the run is expected to disagree. If it still agrees, the
 * harness is not measuring what it claims and the green run above meant nothing.
 *
 * Measured, that perturbation moves **3** of 196 fields, not the 289 that the
 * `<%=` tag count would suggest: escaping only shows where an output actually
 * carries `& < > " '`. Three is a thin but real margin, and it is the honest
 * size of this particular check.
 */
const selfCheck = process.argv.includes('--self-check')

if (!existsSync(CARDS) || !existsSync(VENDORED_EJS)) {
  console.log('template-differential: skipped — no local SillyTavern corpus at')
  console.log(`  cards : ${CARDS}`)
  console.log(`  engine: ${VENDORED_EJS}`)
  console.log('Nothing to compare against. This is expected on any machine but the operator\'s.')
  process.exit(0)
}

const { decodeCardPng } = await import('../packages/iris-character/src/index.ts')
const { extractScripts } = await import('../packages/iris-script/src/index.ts')
const { evaluateBatch, buildEnvironment, createState } =
  await import('../packages/iris-compat-prompt-template/src/index.ts')

/** The engine the operator's SillyTavern actually runs. */
const upstreamEjs = createRequire(VENDORED_EJS)('./ejs.js')
/** The same lodash the child loads into its realm, for the comparison side. */
const lodash = require('../packages/iris-compat-prompt-template/node_modules/lodash')
/** Upstream's five compile defaults, as `evalTemplate` applies them. */
const UPSTREAM_OPTIONS = {
  async: true,
  outputFunctionName: 'print',
  _with: true,
  localsName: 'locals',
  client: true,
}

/**
 * Stand in for `substituteParams`.
 *
 * Every `{{macro}}` becomes the same literal on both sides. It has to happen
 * before either engine sees the text — a corpus card writes
 * `<%_ if ({{roll 1d100}} >= 100) { _%>`, where the macro *is* the JavaScript.
 * @param {string} text - raw field text.
 * @returns {string} text with macros replaced by a fixed value.
 */
const substituteMacros = text => text.replace(/\{\{[^{}]*\}\}/g, '0')

/**
 * Templates whose output cannot be compared because it is not a function of the
 * input.
 *
 * The two sides run in different realms and cannot share a seed, so a template
 * that rolls a die renders differently for reasons that say nothing about the
 * engine. Counted and reported rather than silently dropped.
 * @param {string} text - the template.
 * @returns {boolean} whether the output is non-deterministic.
 */
const isNonDeterministic = text =>
  /\bMath\s*\.\s*random\b|\b_\s*\.\s*(random|sample|sampleSize|shuffle)\b|\bDate\s*\.\s*now\b|\bnew\s+Date\b/.test(text)

// --- gather the corpus ------------------------------------------------------

/** Every world book on disk, by name, for `getwi` to resolve against. */
const diskEntries = []
for (const file of readdirSync(WORLDS).filter(name => name.endsWith('.json'))) {
  const world = file.replace(/\.json$/, '')
  let book
  try { book = JSON.parse(readFileSync(join(WORLDS, file), 'utf8')) } catch { continue }
  for (const entry of Object.values(book.entries ?? {})) {
    if (entry?.disable) continue
    diskEntries.push({
      world,
      uid: String(entry?.uid ?? ''),
      comment: String(entry?.comment ?? ''),
      content: substituteMacros(String(entry?.content ?? '')),
    })
  }
}

const cards = []
for (const file of readdirSync(CARDS).filter(name => name.toLowerCase().endsWith('.png'))) {
  const card = decodeCardPng(readFileSync(join(CARDS, file)))
  const data = card.data ?? {}
  const items = []

  const bookEntries = data.character_book?.entries ?? []
  bookEntries.forEach((entry, index) => {
    const text = String(entry?.content ?? '')
    if (!text.includes('<%')) return
    items.push({
      id: `${file}#wi[${index}]`,
      text: substituteMacros(text),
      origin: `worldinfo/${data.extensions?.world ?? file}/${entry?.uid ?? index}-${entry?.comment ?? ''}`,
    })
  })
  ;(data.extensions?.regex_scripts ?? []).forEach((script, index) => {
    const text = String(script?.replaceString ?? '')
    if (!text.includes('<%')) return
    items.push({ id: `${file}#regex[${index}]`, text: substituteMacros(text), origin: `regex/${script?.scriptName ?? index}` })
  })

  if (items.length === 0) continue

  let initial = {}
  try { initial = extractScripts(card).variables ?? {} } catch { initial = {} }

  const bound = data.extensions?.world
  // The card's own embedded book, plus every disk book, so `getwi` can resolve
  // the same way it does in the running application.
  const worldInfo = [
    ...bookEntries.map((entry, index) => ({
      world: String(bound ?? file),
      uid: String(entry?.uid ?? index),
      comment: String(entry?.comment ?? ''),
      content: substituteMacros(String(entry?.content ?? '')),
    })),
    ...diskEntries,
  ]

  cards.push({
    file,
    items,
    snapshot: {
      variables: { global: {}, initial, local: {}, message: {} },
      chatMetadata: {},
      worldInfo,
      lorebooks: bound ? { character: String(bound) } : {},
      scalars: {
        charName: String(data.name ?? ''),
        assistantName: String(data.name ?? ''),
        userName: 'User',
        chatId: 'differential',
        characterId: 0,
        model: 'differential',
      },
      traceId: 1,
    },
  })
}

// --- side B: the engine the operator actually runs --------------------------

/**
 * Render one card's items through upstream's own engine, in order, sharing
 * variable state exactly as the child does.
 *
 * The environment is this package's, deliberately: holding it fixed is what
 * makes the comparison a statement about the engine rather than about both.
 * @param {{items: object[], snapshot: object}} card - the card's batch.
 * @returns {Promise<Map<string, {ok: boolean, text?: string, error?: string}>>} results by item id.
 */
async function renderWithUpstream(card) {
  const state = createState(card.snapshot)
  const out = new Map()

  const render = async (text, origin, locals) => {
    if (!text.includes('<%')) return text
    const compiled = upstreamEjs.compile(text, { ...UPSTREAM_OPTIONS, filename: origin })
    return await compiled.call(
      locals,
      // lodash reaches a template as a *realm global* on the Iris side, because
      // the child evaluates lodash's source inside the `vm` context so that its
      // objects and the template's share a realm. There is no realm to do that
      // in here, so it goes in as a local. Both resolve `_` under `with`; the
      // difference is plumbing, not dialect. Without it every lodash-using field
      // fails on this side alone, which reads as 33 engine disagreements and is
      // really one missing binding in the harness.
      { ...locals, _: lodash },
      selfCheck ? undefined : markup => markup, // upstream's identity escape
      path => ({ filename: path, template: '' }), // upstream's include stub
      undefined,                   // let the compiled source use its own rethrow
    )
  }

  for (const item of card.items) {
    const environment = buildEnvironment({
      snapshot: card.snapshot,
      evaluateNested: (text, origin, locals) => render(text, origin, locals),
    }, state)
    try {
      out.set(item.id, { ok: true, text: await render(item.text, item.origin, environment.locals) })
    } catch (error) {
      out.set(item.id, { ok: false, error: String(error?.message ?? error) })
    }
  }
  return out
}

// --- run both sides ---------------------------------------------------------

let compared = 0
let agreed = 0
let skippedRandom = 0
const bothFailed = []
const disagreements = []
/** Members the corpus reaches for that this package does not provide. */
const environmentGaps = new Map()

for (const card of cards) {
  const deterministic = card.items.filter(item => !isNonDeterministic(item.text))
  skippedRandom += card.items.length - deterministic.length
  if (deterministic.length === 0) continue

  const [iris, upstream] = await Promise.all([
    // The real host path: fork, --permission, vm realm. Not a shortcut through
    // the in-process evaluator — the boundary is part of what is being accepted.
    evaluateBatch({ items: deterministic, snapshot: card.snapshot, deadlineMs: 60_000 }),
    renderWithUpstream(card),
  ])

  for (const { id, result } of iris.results) {
    const other = upstream.get(id)
    if (other === undefined) continue
    compared++

    if (!result.ok && !other.ok) {
      // Both sides refuse it — but they share this package's environment, so
      // agreement here is not evidence of correctness. A `ReferenceError` means
      // the template reached for a member upstream provides and this package
      // does not, and it would *work* in the operator's real SillyTavern. Kept
      // out of the agreement count for exactly that reason: the differential is
      // blind to a gap both sides inherit.
      bothFailed.push({ id, iris: result.error, upstream: other.error })
      const missing = /^ReferenceError: (\w+) is not defined/.exec(String(result.error ?? ''))
        ?? /(\w+) is not defined/.exec(String(result.error ?? ''))
      if (missing) environmentGaps.set(missing[1], (environmentGaps.get(missing[1]) ?? 0) + 1)
      continue
    }
    if (result.ok && other.ok && result.text === other.text) { agreed++; continue }
    disagreements.push({ id, iris: result, upstream: other })
  }
}

// --- report -----------------------------------------------------------------

const totalItems = cards.reduce((sum, card) => sum + card.items.length, 0)
console.log('template differential — Iris vs the engine this machine runs')
console.log('')
console.log(`  cards with EJS        ${cards.length}`)
console.log(`  EJS-bearing fields    ${totalItems}`)
console.log(`  excluded as random    ${skippedRandom}`)
console.log(`  compared              ${compared}`)
console.log(`  agreed                ${agreed}`)
console.log(`  disagreed             ${disagreements.length}`)
console.log(`  not comparable        ${bothFailed.length}  (both sides failed — see below)`)

if (environmentGaps.size) {
  console.log('\nenvironment gaps — names the corpus reaches for that this package lacks.')
  console.log('These fields fail in Iris and render in the operator\'s SillyTavern. The')
  console.log('provider is not always ST-Prompt-Template: a template runs in the page realm,')
  console.log('so it can also reach a global some other extension installed — YAML and z')
  console.log('come from TavernHelper, not from the template engine at all.')
  console.log('Both sides fail identically because both use this package\'s environment,')
  console.log('so the comparison above cannot see them. This list is the actionable part.')
  for (const [name, count] of [...environmentGaps].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}  — ${count} field(s)`)
  }
}

if (bothFailed.length && verbose) {
  console.log('\nfields neither side could render:')
  for (const entry of bothFailed) {
    const first = String(entry.iris ?? '').split('\n').filter(Boolean).pop() ?? ''
    console.log(`  ${entry.id}\n    ${first.slice(0, 140)}`)
  }
}

if (disagreements.length) {
  console.log('\ndisagreements:')
  for (const entry of disagreements.slice(0, verbose ? disagreements.length : 10)) {
    console.log(`\n  ${entry.id}`)
    if (entry.iris.ok !== entry.upstream.ok) {
      console.log(`    iris    : ${entry.iris.ok ? 'rendered' : `failed — ${entry.iris.error?.slice(0, 160)}`}`)
      console.log(`    upstream: ${entry.upstream.ok ? 'rendered' : `failed — ${entry.upstream.error?.slice(0, 160)}`}`)
      continue
    }
    const a = entry.iris.text ?? ''
    const b = entry.upstream.text ?? ''
    let at = 0
    while (at < a.length && at < b.length && a[at] === b[at]) at++
    console.log(`    first difference at character ${at} (lengths ${a.length} vs ${b.length})`)
    console.log(`    iris    : ${JSON.stringify(a.slice(Math.max(0, at - 40), at + 60))}`)
    console.log(`    upstream: ${JSON.stringify(b.slice(Math.max(0, at - 40), at + 60))}`)
  }
  if (!verbose && disagreements.length > 10) {
    console.log(`\n  … and ${disagreements.length - 10} more. Re-run with --verbose.`)
  }
}

console.log('')
if (selfCheck) {
  if (disagreements.length === 0) {
    console.log('SELF-CHECK FAILED: the comparison side was deliberately broken and')
    console.log('this script still reported agreement. It is not measuring the engine.')
    process.exit(1)
  }
  console.log(`self-check passed: ${disagreements.length} field(s) detected when the`)
  console.log('comparison side was given EJS HTML escaping instead of the identity one.')
  process.exit(0)
}
if (disagreements.length === 0) {
  console.log('Every comparable field renders identically under both engines.')
  console.log('This accepts the engine layer. The environment is transcription plus')
  console.log('hermetic tests — see the header for what is and is not covered.')
} else {
  console.log(`${disagreements.length} field(s) render differently. Each one is either a fidelity`)
  console.log('bug in this package or an upstream behaviour not yet recorded in DEVIATIONS.md.')
}

process.exit(disagreements.length === 0 ? 0 : 1)
