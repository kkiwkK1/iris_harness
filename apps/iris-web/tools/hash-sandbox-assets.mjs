/**
 * Give the sandbox artifacts content-addressed names.
 *
 * These two files — the frame bootstrap and the card-library preset — were the
 * last fixed URLs Iris served, and a fixed URL whose bytes change is the shape
 * that has cost this project the most. A stale copy in a browser cache reads as
 * a code bug: the frame reports a fault that was fixed an hour ago, and the only
 * cure anyone found was a superstitious Ctrl+Shift+R before every verification
 * round. That ritual is not a workaround, it is a permanent tax on trusting any
 * reading at all.
 *
 * Content hashing removes the ambiguity rather than shortening it. A name that
 * changes when the bytes change means a cached copy is *correct by definition*,
 * and a request for a superseded name is a **404** — a loud, diagnosable answer
 * instead of silently-old code.
 *
 * Done here rather than in the Vite configs because both builds use library mode,
 * whose `fileName` hook is handed no content hash. Renaming afterwards is a
 * smaller mechanism than fighting for one, and it keeps a single place that
 * decides how these names are formed.
 *
 * Writes `manifest.json`, which is the one fixed path left. It is a few dozen
 * bytes, it must never be cached, and it is fetched by the shell rather than by a
 * frame — so a card frame's own startup still depends on nothing but its tag.
 *
 * @module iris-web/tools/hash-sandbox-assets
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'public', 'sandbox')

/** The artifacts this owns, by the name their build emits. */
const ARTIFACTS = ['bootstrap', 'preset', 'message-preset']

/**
 * Sixteen hex characters of SHA-256.
 *
 * Long enough that a collision is not a thing anyone needs to reason about,
 * short enough to read in a network panel and compare by eye — which is what
 * someone does when they are trying to work out whether the browser has the
 * build they just made.
 * @param bytes - the file contents.
 * @returns the hash fragment for the name.
 */
function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

const manifest = {}
const keep = new Set(['manifest.json'])

for (const artifact of ARTIFACTS) {
  const plain = join(dir, `${artifact}.js`)
  let bytes
  try {
    bytes = readFileSync(plain)
  } catch {
    console.error(`hash step failed: ${artifact}.js was not emitted, so there is nothing to name`)
    process.exit(1)
  }

  const name = `${artifact}-${fingerprint(bytes)}.js`
  renameSync(plain, join(dir, name))
  manifest[artifact] = name
  keep.add(name)
}

/*
 * Superseded builds are deleted, and that is a correctness property rather than
 * tidiness.
 *
 * Left in place, an old hashed file goes on answering its old URL forever. Any
 * page still holding that reference — a tab left open across a rebuild — would
 * keep running last hour's code while reporting no error at all, which is
 * precisely the failure hashing is here to end. Deleted, that page gets a 404
 * and says so.
 */
for (const entry of readdirSync(dir)) {
  if (keep.has(entry)) continue
  if (!ARTIFACTS.some(artifact => entry.startsWith(`${artifact}-`))) continue
  unlinkSync(join(dir, entry))
}

writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}
`, 'utf8')

console.log(`sandbox assets: ${ARTIFACTS.map(a => manifest[a]).join(', ')}`)
