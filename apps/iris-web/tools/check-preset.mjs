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

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'public', 'sandbox', 'preset.js'), 'utf8')

/*
 * Executed with a bare object standing in for `window`, and nothing else.
 *
 * Anything the bundle needs beyond that is something a sandboxed frame may not
 * have either, so a failure here is a real finding rather than an artefact of
 * the harness.
 */
const win = {}
try {
  new Function('window', 'self', 'globalThis', 'document', source)(win, win, win, undefined)
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

if (broken.length > 0) {
  console.error(`preset check failed: ${broken.join(', ')}`)
  console.error('  the bundle loaded but does not provide what a card is told it has')
  process.exit(1)
}

console.log(
  `preset check: ok (${Math.round(source.length / 1024)} KB, seeds ${Object.keys(seeds).join(', ')} usable, jquery v${pinned}, vue v${vuePin} bundled)`,
)
