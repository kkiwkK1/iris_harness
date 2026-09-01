/**
 * Remove superseded sandbox artifacts from a served directory.
 *
 * The hash step prunes `public/sandbox`, which is where the build writes — and the
 * host serves `dist/sandbox`, which is where Vite *copies*. Vite copies without
 * removing, so every earlier build's artifacts accumulated there: sixteen files
 * for three current ones.
 *
 * That is not untidiness. The property that makes an immutable, long-lived cache
 * safe — **a superseded name stops being answerable** — was only ever true of the
 * directory nobody fetches from. In the directory that is actually served, every
 * old bootstrap still answered its old URL, so a page holding one would go on
 * running last week's frame code with nothing to report.
 *
 * It also cost two rounds of measurement directly: two instrument revisions were
 * built into `public/`, never copied into `dist/` because only `build:sandbox` had
 * run, and read as "the change had no effect" when the change had never been
 * served.
 *
 * @module iris-web/tools/prune-sandbox-assets
 */
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', process.argv[2] ?? 'dist/sandbox')

let manifest
try {
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
} catch {
  // No manifest means nothing was built into this directory, which is a
  // legitimate state — a build that has not run yet is not a stale build.
  console.log(`prune: no manifest in ${dir}, nothing to do`)
  process.exit(0)
}

const keep = new Set(['manifest.json', ...Object.values(manifest)])
const prefixes = Object.keys(manifest)

let removed = 0
for (const entry of readdirSync(dir)) {
  if (keep.has(entry)) continue
  if (!prefixes.some(prefix => entry.startsWith(`${prefix}-`))) continue
  unlinkSync(join(dir, entry))
  removed += 1
}

console.log(
  `prune: ${dir.split(/[\/]/).slice(-2).join('/')} now serves only ` +
    `${prefixes.map(p => manifest[p]).join(', ')} (${String(removed)} superseded removed)`,
)
