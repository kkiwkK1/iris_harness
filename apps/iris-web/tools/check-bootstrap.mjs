/**
 * Refuse to ship a bootstrap that is not a classic self-contained script.
 *
 * The failure this guards against cost a full verification round and was
 * invisible from inside the frame: a dev server rewrote the file into an ES
 * module, and the resulting `import` was a **parse-time** error in the `srcdoc`
 * classic script — so the block never executed and the frame's own reporter
 * never existed to report it.
 *
 * A parse error cannot be caught by the thing failing to parse. This check is
 * therefore the layer outside it, run at build time on the emitted bytes.
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkBootstrap } from '../src/sandbox/bootstrap-source.ts'
import { FRAME_OVERHEAD_BYTES } from '../src/app/frame-budget.ts'


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

const sandboxDir = fileURLToPath(new URL('../public/sandbox', import.meta.url))
const file = artifactPath('bootstrap', sandboxDir)
const source = await readFile(file, 'utf8')
const why = checkBootstrap(source)

if (why !== undefined) {
  console.error(`bootstrap check failed: ${why}`)
  console.error(`  ${file}`)
  console.error(`  starts with: ${JSON.stringify(source.slice(0, 120))}`)
  process.exit(1)
}

/*
 * Exactly one reference to `postMessage`, which must be the capture at boot.
 *
 * This pins a bug that severed the frame in silence. `post` used to read
 * `window.parent.postMessage` at call time; once `publishGlobals` began
 * redefining `window.parent` to the virtual parent — a proxy that throws on
 * members it does not bridge — every send after that became a thrown error, the
 * body never ran, and the frame said nothing at all for the rest of its life.
 *
 * A second occurrence means someone reintroduced a late read, and the failure it
 * causes is invisible from outside the frame. Counting is crude and survives
 * minification, which a name would not.
 *
 * **Counting member reads, not every occurrence.** The first version counted the
 * bare word, and a legitimate change broke it: the nested-frame stand-in has to
 * *define* a `postMessage` method, because a card broadcasting to every iframe
 * it can find would otherwise throw on the stand-in instead of being ignored.
 * Defining a key is not re-deriving the channel, so the bare count was measuring
 * the wrong thing — and the ways to make it pass again were to obfuscate the
 * key, which would blind the check to real late reads, or to say what the rule
 * actually is.
 *
 * The rule is: **the channel is read exactly once.** So both member forms are
 * counted — `x.postMessage` and `x["postMessage"]` — which also makes this
 * stricter than before against a late read written in bracket form, while a
 * property *key* no longer trips it.
 */
const reads = source.match(/\.postMessage|\[\s*["']postMessage["']\s*\]/g)?.length ?? 0
const mentions = source.match(/postMessage/g)?.length ?? 0
if (reads !== 1) {
  console.error(
    `bootstrap check failed: expected exactly one postMessage read (the capture at boot), found ${reads} reads in ${mentions} mentions`,
  )
  console.error('  a late `window.parent.postMessage` read is severed the moment the bridge is published')
  process.exit(1)
}

/*
 * The frame budget's basis, checked against the artifact it describes.
 *
 * `FRAME_OVERHEAD_BYTES` is what every frame costs before its card writes
 * anything, and the whole reading-window budget is denominated in it — the
 * count gate's position is derived from it. It is a **measurement of this
 * bootstrap**, rounded to a whole KiB on purpose so that per-build drift does
 * not make the documentation stale.
 *
 * Which leaves the question of who notices when the drift stops being small.
 * `notes/apps/iris-web/DEVIATIONS.md` §15 answered "run the build and read its output", and that
 * is a person remembering — the weakest link a measurement can hang from. So
 * the comparison happens here, where the number is produced.
 *
 * The two directions are not symmetric:
 *
 * - **Understating fails.** If the constant no longer covers the bootstrap plus
 *   its wrapper, every frame is charged less than it costs, twenty frames
 *   silently overshoot the budget, and the layer's only hard number is wrong in
 *   the direction that removes the protection.
 * - **Overstating warns.** A constant well above the artifact makes the budget
 *   needlessly tight — fewer interfaces than the page could afford — which is a
 *   visible, harmless conservatism, not a broken invariant.
 */

/**
 * What the srcdoc wrapper adds around the bootstrap.
 *
 * The doctype, the meta tags, the CSP, the token and the reset — about a KiB,
 * and stated here rather than measured because it is assembled at runtime per
 * frame (`srcdoc.ts`) and there is no artifact on disk to weigh.
 */
const WRAPPER_ALLOWANCE = 1024

const measured = source.length + WRAPPER_ALLOWANCE
if (measured > FRAME_OVERHEAD_BYTES) {
  console.error(
    `bootstrap check failed: a frame now costs about ${measured} bytes (bootstrap ${source.length}`
      + ` + ${WRAPPER_ALLOWANCE} wrapper) but FRAME_OVERHEAD_BYTES is ${FRAME_OVERHEAD_BYTES}`,
  )
  console.error('  the reading window would charge less per frame than a frame costs')
  console.error('  raise FRAME_OVERHEAD_BYTES in src/app/frame-budget.ts and revisit')
  console.error('  FRAME_COUNT_LIMIT with it, since the gate position is derived from this number')
  process.exit(1)
}
if (measured < FRAME_OVERHEAD_BYTES * 0.75) {
  console.warn(
    `bootstrap check: FRAME_OVERHEAD_BYTES (${FRAME_OVERHEAD_BYTES}) now overstates a frame`
      + ` by more than a quarter — measured about ${measured} bytes`,
  )
  console.warn('  harmless, but the budget is tighter than it needs to be')
}

console.log(`bootstrap check: ok (${source.length} bytes, classic, channel captured once)`)
console.log(`  frame overhead: about ${measured} bytes against a budgeted ${FRAME_OVERHEAD_BYTES}`)
