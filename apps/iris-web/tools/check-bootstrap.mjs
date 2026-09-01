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
 */
const sends = source.match(/postMessage/g)?.length ?? 0
if (sends !== 1) {
  console.error(
    `bootstrap check failed: expected exactly one postMessage reference (the capture at boot), found ${sends}`,
  )
  console.error('  a late `window.parent.postMessage` read is severed the moment the bridge is published')
  process.exit(1)
}

console.log(`bootstrap check: ok (${source.length} bytes, classic, channel captured once)`)
