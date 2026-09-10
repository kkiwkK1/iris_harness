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
  /*
   * No manifest means nothing was built into this directory, which is a
   * legitimate state — a build that has not run yet is not a stale build. It is
   * also the only safe reading: without a manifest there is no way to tell a
   * current artifact from a superseded one, and a pruner that guesses would
   * delete the build it was meant to protect.
   */
  console.log(`prune: no manifest in ${dir}, nothing to prune`)
  process.exit(0)
}

/** Everything the manifest vouches for, plus the manifest itself. */
const keep = new Set(['manifest.json', ...Object.values(manifest)])

/**
 * The artifact families this tool is allowed to touch.
 *
 * Deletion is restricted to `<prefix>-<hash>.js` names so the pruner can only
 * ever remove a **superseded version of something the manifest names**. Anything
 * else in the directory is left alone, which is why the report below lists what
 * it did not manage as well as what it did.
 */
const prefixes = Object.keys(manifest)

let removed = 0
for (const entry of readdirSync(dir)) {
  if (keep.has(entry)) continue
  if (!prefixes.some(prefix => entry.startsWith(`${prefix}-`))) continue
  unlinkSync(join(dir, entry))
  removed += 1
}

/*
 * Reported as the directory actually is, not as the manifest wishes it were.
 *
 * The first version of this line said the directory "now serves only" the three
 * manifest entries, and it served five, so the sentence walked straight past
 * two. A build log that overstates what it checked is the same failure this whole
 * tool was written to fix — the stale artifacts it now deletes went unnoticed
 * because nothing ever said what was really there.
 *
 * **What those two were is no longer what this paragraph said.** It named the
 * un-hashed `bootstrap.js` and `preset.js` as build outputs left alone; the hash
 * step *renames* rather than copies, so neither has existed for some time and the
 * only unlisted entry today is `fontawesome.min.css` — the sentinel, whose
 * filename is its entire function and which must never be hashed. Corrected
 * 2026-09-10 while the bootstrap moved to a fetched URL (§91) and the un-hashed
 * copy was looked for and found absent.
 *
 * Anything unlisted is safe only because the host derives its `immutable` set
 * from the manifest (`sandbox-assets.ts`), so a name that is not in the manifest
 * never gets a year-long TTL. Printing them keeps that dependency visible: if
 * anyone ever caches this directory by pattern instead, they are the trap.
 */
/**
 * The last two segments of a path, under either separator.
 *
 * Split rather than matched, and the first attempt here is why: written as a
 * character class it became `[/\]`, where the backslash escaped the closing
 * bracket and the whole expression failed to compile. Escapes in this repo have
 * been eaten in transit repeatedly; a split has nothing to eat.
 * @param full - an absolute path.
 * @returns its last two segments, joined with a forward slash.
 */
function shortPath(full) {
  const BACKSLASH = String.fromCharCode(92)
  return full.split(BACKSLASH).flatMap(part => part.split('/')).slice(-2).join('/')
}

const listed = new Set(Object.values(manifest))
const alsoPresent = readdirSync(dir).filter(
  entry => entry !== 'manifest.json' && !listed.has(entry),
)

console.log(
  `prune: ${shortPath(dir)} — ` +
    `${String(removed)} superseded removed; ` +
    `hashed: ${[...listed].join(', ')}` +
    (alsoPresent.length === 0
      ? ''
      : `; also present, never immutable: ${alsoPresent.join(', ')}`),
)