/**
 * Assert the built preset bundle really seeds the globals it claims to.
 *
 * A build-time check rather than a test, because what is being checked is the
 * *artifact*: the source can be correct while the bundle is not. Tree-shaking a
 * side-effect-only assignment, a bundler target change, or a library that stops
 * shipping a browser build all produce a preset.js that loads without error and
 * defines nothing — and the only symptom is a card three steps later saying
 * `YAML is not defined`, which reads like a missing dependency rather than a
 * broken build.
 *
 * The banner in the frame reports what is missing at runtime; this is the same
 * question asked before anyone runs a card.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'


/**
 * The artifact this build actually produced, by manifest rather than by name.
 *
 * The sandbox artifacts carry content hashes, so a fixed filename here would
 * check whichever build happened to leave a file behind — including one that has
 * since been superseded. The manifest is written by the hashing step and is the
 * single place that knows the current names.
 * @param key - which artifact to resolve.
 * @param dir - the sandbox asset directory.
 * @returns the absolute path to that artifact.
 */
function artifactPath(key, dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    console.error('check failed: no sandbox manifest — run the hash step after building')
    process.exit(1)
  }
  const name = manifest[key]
  if (typeof name !== 'string' || name === '') {
    console.error(`check failed: the sandbox manifest does not name a ${key} artifact`)
    process.exit(1)
  }
  return join(dir, name)
}

const here = dirname(fileURLToPath(import.meta.url))
const sandboxDir = join(here, '..', 'public', 'sandbox')
const source = readFileSync(artifactPath('preset', sandboxDir), 'utf8')

/*
 * Run in a vm context, and the reason is a bug this harness could not see.
 *
 * It used to be `new Function(...)`, whose body still resolves free identifiers
 * against Node's globals. The comment defended that as safe in one direction —
 * "anything the bundle needs beyond this is something a frame may not have
 * either" — which guards against a false failure and says nothing about a false
 * pass. Everything Node happens to provide and a browser does not was simply
 * invisible.
 *
 * That is not hypothetical. Vue's esm-bundler build reads `process.env.NODE_ENV`
 * unguarded, this config was not replacing it, and the bundle threw
 * `ReferenceError: process is not defined` on its first line in a real frame.
 * The check passed every time, because Node has `process`. The harness could
 * only ever fail on things its own environment also lacked.
 *
 * So the context is built the other way round: it starts empty and is given
 * exactly what a browser frame has. `process`, `require`, `Buffer`,
 * `setImmediate` and the rest are absent because they are absent there.
 */
const win = {
  /*
   * The timers are real browser globals and the bundle legitimately uses them —
   * Vue schedules a devtools check, jQuery uses them for readiness. Withholding
   * them would produce exactly the false failure the old comment worried about,
   * which is the opposite error and just as useless.
   */
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  queueMicrotask: () => {},
  console,
  /*
   * Still no `document`, and still deliberately. jQuery's UMD picks what to
   * export by looking for one at load, so supplying a half-built stand-in would
   * assert things about a branch the frame never takes — it once produced a
   * confident `$ (present but not usable)` against a perfectly good bundle. The
   * frame's own first-hand check is what covers the document-bearing path.
   */
  document: undefined,
}
win.window = win
win.self = win

createContext(win)
try {
  runInContext(source, win, { filename: 'preset.js' })
} catch (error) {
  console.error(`preset check failed: the bundle threw while loading — ${error.message}`)
  process.exit(1)
}

/**
 * Global → a call that proves it is the real library and not a husk.
 *
 * jQuery is absent from this table on purpose, and the reason is worth keeping.
 * Its UMD decides what to export by looking for `window.document` **at load**:
 * with one it returns an initialized instance, without one it returns a factory.
 * This harness deliberately supplies no document, so whatever it would assert
 * about jQuery's shape would be an assertion about a branch the frame never
 * takes. Checking it here anyway produced a confident `$ (present but not
 * usable)` against a bundle that was completely fine.
 *
 * jQuery is checked below instead, by the two questions this environment *can*
 * answer: is the library actually in the bundle, at the pinned version, and did
 * both names end up pointing at the same thing.
 */
const seeds = {
  /*
   * Called, not inspected, and that distinction is the whole reason this line
   * changed. It used to read `typeof value.get === 'function'` — which a module
   * *namespace* object passes, because a namespace has `get`. Every method was
   * present, every method worked, and the object itself was not callable.
   *
   * Cards use both forms. MagVarUpdate's unique-script election is written as
   * `_(list).map(...).last()`, so it sailed past every method access and then
   * threw `TypeError: _ is not a function` at the one line that needed the
   * wrapper. A check that only reads properties cannot see the difference
   * between a working lodash and a namespace pretending to be one.
   *
   * So this exercises the exact shape that broke: call it, chain it, and take
   * an implicitly-unwrapped result.
   */
  _: value => LODASH_IS_CALLABLE(value),
  /*
   * Chained, not merely probed for `object`. The prefault-compat install runs
   * inside this bundle, and the break it fixes is invisible to a presence
   * check: `typeof z.object === 'function'` passes on a namespace whose
   * `.prefault()` still severs the chain — the failure then belongs to a card
   * three steps later (`…prefault(...).min is not a function`, measured on the
   * 全职高手 variable-structure script). So the probe exercises the exact
   * measured chain: build, chain, parse the absent case and a present one.
   */
  z: value => ZOD_PREFAULT_CHAINS(value),
  YAML: value => YAML_ROUND_TRIPS(value),
  /*
   * `watch` and `ref` by name, not `Vue` by presence.
   *
   * This check is written around the failure that produced it. MagVarUpdate
   * publishes from inside a `Vue.watch` callback, so `watch` missing means the
   * publish never happens and every consumer of that card waits forever — with
   * no error anywhere, because the tag that used to supply Vue failed silently.
   * Asserting the exact member the gate depends on is the difference between
   * this check passing on a husk and catching the thing that actually broke.
   */
  Vue: value => typeof value.watch === 'function' && typeof value.ref === 'function',
  /*
   * The constructor cards actually reach for, and a round trip through it.
   *
   * `typeof value.Converter === 'function'` would pass on a showdown whose
   * bundling had gone wrong in the way that matters here — the UMD file assigns
   * its exports at the end of a factory, so a half-included bundle can leave a
   * constructor that throws on `new`. Cards write
   * `new showdown.Converter().makeHtml(text)` and nothing else, so that is what
   * is exercised.
   */
  showdown: value => SHOWDOWN_CONVERTS(value),
  /*
   * The two factories, by name.
   *
   * `createRouter` alone would pass on a build that dropped the history
   * implementations, and a router with no history throws at `createRouter` time
   * rather than at import time — inside a card's own setup, where the frame
   * reports it as the card's fault. Upstream cards use the hash history because
   * a script frame has no server to route against.
   */
  VueRouter: value =>
    typeof value.createRouter === 'function' && typeof value.createWebHashHistory === 'function',
}

/**
 * Whether `_` is the callable wrapper factory rather than a namespace of methods.
 * @param value - the seeded global.
 * @returns true when both the method form and the wrapper form work.
 */
function LODASH_IS_CALLABLE(value) {
  if (typeof value !== 'function') return false
  if (typeof value.get !== 'function') return false
  // The wrapper form, ending in an implicitly unwrapped method, exactly as the
  // card that exposed this does it.
  const chained = value([{ n: 1 }, { n: 2 }]).map(item => item.n).last()
  return chained === 2
}

/**
 * Whether showdown converts, rather than merely being present.
 * @param value - the seeded global.
 * @returns true when a converter can be constructed and produces markup.
 */
function SHOWDOWN_CONVERTS(value) {
  if (typeof value !== 'object' || value === null) return false
  if (typeof value.Converter !== 'function') return false
  const html = new value.Converter().makeHtml('**bold**')
  return typeof html === 'string' && html.includes('<strong>')
}

/** `parse` and `stringify` are the whole of what MVU uses; both must survive. */
function YAML_ROUND_TRIPS(value) {
  if (typeof value.parse !== 'function' || typeof value.stringify !== 'function') return false
  const probe = { stat: { hp: 10 }, list: [1, 2] }
  return JSON.stringify(value.parse(value.stringify(probe))) === JSON.stringify(probe)
}

/**
 * Whether the seeded zod chains `.prefault()` into the inner schema's methods.
 *
 * The chain is the one the corpus carries (全职高手's variable-structure
 * script): a coerced number with a prefault, constrained after it. The absent
 * input must yield the prefault value; a present input must coerce and still
 * pass the constraints. A second assertion covers the chaining continuing past
 * one hop, which is the shape of all five measured chains.
 * @param value - the seeded global.
 * @returns true when the chain parses as written.
 */
function ZOD_PREFAULT_CHAINS(value) {
  if (typeof value.object !== 'function' || typeof value.coerce?.number !== 'function') return false
  const chained = value.coerce.number().prefault(0).min(0).max(100)
  if (chained.parse(undefined) !== 0) return false
  if (chained.parse('55') !== 55) return false
  // The absent case refused when the prefault value fails its own constraint —
  // the composed semantics, not an invented clamp.
  let refused = false
  try {
    value.coerce.number().prefault(0).min(1).parse(undefined)
  } catch {
    refused = true
  }
  return refused
}

const broken = []
for (const [name, works] of Object.entries(seeds)) {
  const value = win[name]
  if (value === undefined || value === null) {
    broken.push(`${name} (absent)`)
    continue
  }
  /*
   * A predicate that throws is answering the question, not failing to.
   *
   * Every one of these probes *uses* the library — `_([…]).map(…)`,
   * `value.parse(…)`, `new value.Converter()` — precisely so that a husk cannot
   * pass, and using a broken library is how you find out it is broken. Unguarded,
   * the throw escaped this loop and the build died with a raw stack from a check
   * script, which reads as "the checker is broken" rather than "the preset is".
   *
   * Found by exercising the new showdown probe against a `Converter` that throws
   * on `new` — a shape its own comment had named as the reason to construct one
   * rather than inspect it. The comment described the case the code did not
   * handle, which is the more useful half of why this is guarded here, at the one
   * place all six probes pass through, rather than inside each of them.
   */
  let usable
  try {
    usable = works(value)
  } catch (error) {
    broken.push(`${name} (present but threw: ${error instanceof Error ? error.message : String(error)})`)
    continue
  }
  if (!usable) broken.push(`${name} (present but not usable)`)
}

/*
 * Vue's flags are values, not objects, and `false` is a legitimate one — so they
 * are checked for presence by key rather than by truthiness. Leaving them unset
 * is what upstream records as having broken a great many scripts.
 */
for (const flag of ['__VUE_PROD_DEVTOOLS__', '__VUE_OPTIONS_API__', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__']) {
  if (!Object.hasOwn(win, flag)) broken.push(`${flag} (absent)`)
}

/*
 * jQuery, by source and by identity.
 *
 * The version comes from the manifest rather than being written here twice, so
 * bumping the pin cannot leave the check asserting the old number. jQuery's `/*!`
 * banner is a preserved comment and survives minification, which a name would
 * not.
 */
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).dependencies
const pinned = manifest.jquery
if (!source.includes(`jQuery JavaScript Library v${pinned}`)) {
  broken.push(`jquery (v${pinned} not in the bundle)`)
}

/*
 * Vue's pin is checked as an exact string in the manifest rather than by reading
 * a version out of the bundle, because the runtime build carries no banner to
 * read. The property being defended is that nobody quietly relaxes the pin: an
 * unpinned Vue whose failure mode is silent absence is the arrangement this
 * whole change replaced.
 */
const vuePin = manifest.vue
if (typeof vuePin !== 'string' || /[\^~*]|x/.test(vuePin)) {
  broken.push(`vue (pin is "${String(vuePin)}", which is not an exact version)`)
}
if (typeof win.$ !== 'function') broken.push('$ (absent)')
else if (win.$ !== win.jQuery) broken.push('$ and jQuery are different objects')

/*
 * The end-of-file marker, which is what the frame checks first-hand.
 *
 * Pinned at both ends deliberately. The frame reads it to tell "the preset never
 * ran" from "the preset does not carry this library" — two findings that look
 * identical as a list of missing names, and were confused once at the cost of a
 * verification round. If the marker were dropped from the bundle, the frame
 * would silently fall back to reporting every absence as a gap, which is the
 * exact ambiguity it was added to remove, and nothing else would notice.
 */
if (win.__iris_preset_loaded__ !== true) {
  broken.push('__iris_preset_loaded__ (absent — the bundle did not run to its last statement)')
}

/*
 * The bundle's own account of a throw comes first, and alone.
 *
 * Without this the failure printed nine absent globals and never mentioned the
 * cause, which is the same defect the frame's report was just fixed for: a list
 * of consequences reads as a list of independent gaps. The wrapper around the
 * IIFE records the exception, so when there is one there is nothing to infer.
 */
if (typeof win.__iris_preset_error__ === 'string') {
  console.error(`preset check failed: the bundle threw while loading — ${win.__iris_preset_error__}`)
  console.error('  every missing global below is a consequence of that one throw')
  console.error(`  ${broken.join(', ')}`)
  process.exit(1)
}

if (broken.length > 0) {
  console.error(`preset check failed: ${broken.join(', ')}`)
  console.error('  the bundle loaded but does not provide what a card is told it has')
  process.exit(1)
}

console.log(
  `preset check: ok (${Math.round(source.length / 1024)} KB, seeds ${Object.keys(seeds).join(', ')} usable, jquery v${pinned}, vue v${vuePin} bundled)`,
)
