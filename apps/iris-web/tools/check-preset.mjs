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

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'public', 'sandbox', 'preset.js'), 'utf8')

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
  _: value => typeof value.get === 'function',
  z: value => typeof value.object === 'function',
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
}

/** `parse` and `stringify` are the whole of what MVU uses; both must survive. */
function YAML_ROUND_TRIPS(value) {
  if (typeof value.parse !== 'function' || typeof value.stringify !== 'function') return false
  const probe = { stat: { hp: 10 }, list: [1, 2] }
  return JSON.stringify(value.parse(value.stringify(probe))) === JSON.stringify(probe)
}

const broken = []
for (const [name, works] of Object.entries(seeds)) {
  const value = win[name]
  if (value === undefined || value === null) broken.push(`${name} (absent)`)
  else if (!works(value)) broken.push(`${name} (present but not usable)`)
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
