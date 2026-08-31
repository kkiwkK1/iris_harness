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
import { fileURLToPath } from 'node:url'

import { checkBootstrap } from '../src/sandbox/bootstrap-source.ts'

const file = fileURLToPath(new URL('../public/sandbox/bootstrap.js', import.meta.url))
const source = await readFile(file, 'utf8')
const why = checkBootstrap(source)

if (why !== undefined) {
  console.error(`bootstrap check failed: ${why}`)
  console.error(`  ${file}`)
  console.error(`  starts with: ${JSON.stringify(source.slice(0, 120))}`)
  process.exit(1)
}

console.log(`bootstrap check: ok (${source.length} bytes, classic)`)
