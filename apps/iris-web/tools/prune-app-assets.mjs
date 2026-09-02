/**
 * Remove superseded app bundles from the served asset directory.
 *
 * The sibling of `prune-sandbox-assets.mjs`, for the same reason and against the
 * same hazard — and it was missing, so `dist/assets` had accumulated **ten CSS
 * bundles across two days** while `dist/index.html` referenced one of them.
 *
 * Why that is not untidiness: every superseded name still answered its old URL.
 * The property that makes a content-hashed asset safe to cache forever is that
 * a superseded name **stops being answerable**, and in the directory that is
 * actually served it did not. A page holding an old URL went on being served
 * last week's stylesheet, and nothing anywhere reported it.
 *
 * It also cost a debugging round directly. A frame carried the current JS while
 * `dist/assets` held stylesheets both with and without a rule under
 * investigation, so "the attribute is set but the rule is not applying" had two
 * explanations and one of them was the build. Ruling that out took a round that
 * the measurement itself did not need.
 *
 * **The manifest is the source of truth, not `index.html`.** A dynamically
 * imported chunk is named only inside the JS that imports it, so pruning against
 * the HTML would delete precisely the files that load late — and leave no trace
 * until someone opened the feature that needed them.
 *
 * @module iris-web/tools/prune-app-assets
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
const assets = join(dist, 'assets')
const manifestPath = join(dist, '.vite', 'manifest.json')

if (!existsSync(assets)) {
  console.log('prune app: no dist/assets, nothing to prune')
  process.exit(0)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  /*
   * No manifest, no pruning — the same refusal the sandbox pruner makes, for the
   * same reason. Without it there is no way to tell a current artifact from a
   * superseded one, and a pruner that guesses deletes the build it exists to
   * protect. Loud rather than silent: a missing manifest means the build config
   * changed, and quietly skipping would let the accumulation start again.
   */
  console.error(`prune app: no manifest at ${manifestPath} — refusing to guess`)
  console.error('  enable `build.manifest` in vite.config.ts, or drop this step')
  process.exit(1)
}

/**
 * Every file the current build declares, including the maps beside them.
 *
 * Sourcemaps are not in the manifest — `build.sourcemap` writes them as a side
 * effect — so a pruner that trusted the manifest alone would delete every
 * `.map` on each build, and the one time anyone needed a stack trace it would
 * be the one thing missing.
 */
const kept = new Set()
for (const entry of Object.values(manifest)) {
  for (const name of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
    if (typeof name !== 'string') continue
    const base = name.startsWith('assets/') ? name.slice('assets/'.length) : name
    kept.add(base)
    kept.add(`${base}.map`)
  }
}

if (kept.size === 0) {
  console.error('prune app: the manifest named no files — refusing to empty the directory')
  process.exit(1)
}

const removed = []
for (const name of readdirSync(assets)) {
  if (kept.has(name)) continue
  const path = join(assets, name)
  // Directories are not hashed bundles; leave anything that is not a plain file.
  if (!statSync(path).isFile()) continue
  unlinkSync(path)
  removed.push(name)
}

console.log(
  `prune app: kept ${String(kept.size)} declared names, removed ${String(removed.length)} superseded`,
)
if (removed.length > 0) console.log(`  ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ', …' : ''}`)
