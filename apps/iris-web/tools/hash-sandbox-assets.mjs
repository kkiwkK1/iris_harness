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
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashedName } from './asset-fingerprint.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'public', 'sandbox')

/** The artifacts this owns, by the name their build emits. */
/*
 * `members` is here for the reason the others are, and for one more: the host
 * serves `immutable` only for names it finds in this manifest. An asset that is
 * hashed but unlisted is still *served* — with `no-cache`, so it is refetched on
 * every frame. That failure has no error and no wrong behaviour; its only
 * symptom is "somehow slower", which nobody attributes. Being in this list is
 * what makes the content hash mean anything.
 */
const ARTIFACTS = ['bootstrap', 'members', 'preset', 'message-preset']

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

  /*
   * The name comes from `asset-fingerprint.mjs` rather than from a local
   * `createHash` call, because `check-bootstrap.mjs` verifies this equality on
   * every build — that the file the manifest names still hashes to the hash in
   * its own filename — and a verifier with its own spelling of the hash would be
   * checking one convention against another.
   */
  const name = hashedName(artifact, bytes)
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

/*
 * The one name in this directory that must NOT be content-addressed.
 *
 * Everything above exists because a fixed URL whose bytes change is the shape
 * that has cost this project the most. This file is the exception that proves
 * the rule is about *bytes changing*, not about fixed names: its bytes never
 * change, and its **name is its entire function**.
 *
 * A card cannot cheaply ask whether FontAwesome's rules are present — they are,
 * inlined into the frame by the message preset before any card runs. So
 * upstream's cards ask a question they *can* ask: has a stylesheet whose href
 * contains `fontawesome` / `font-awesome` been loaded? Finding none, they inject
 * a CDN `<link>`, the frame's policy refuses it, and a card that was never
 * missing anything spends its recovery path on a wall and reports a failure.
 *
 * `srcdoc.ts` links this path (`FA_SENTINEL`) so that guard finds its substring.
 * Both sides are literals, because the reader of the name is card code that is
 * not ours and cannot be updated to follow a hash.
 *
 * **Written by the build rather than committed**, because this whole directory
 * is generated and git-ignored — a hand-placed file here would be correct on the
 * machine that placed it and absent from every fresh checkout, which is a
 * failure that only appears somewhere else. It has to load, not merely exist:
 * a 404 still satisfies a `querySelector('link[href*=…]')` guard but produces no
 * entry in `document.styleSheets`, and cards use both forms.
 */
const SENTINEL = 'fontawesome.min.css'
writeFileSync(join(dir, SENTINEL), `/*
 * A sentinel: the filename is the payload, and it carries no rules.
 *
 * FontAwesome's actual rules are already inlined in the frame before any card
 * runs. This exists so a card's "has FontAwesome loaded?" guard — a substring
 * test on stylesheet hrefs — finds its evidence and skips a CDN fallback that
 * this frame's policy would refuse anyway.
 *
 * Generated by tools/hash-sandbox-assets.mjs. Do not rename: srcdoc.ts links
 * this exact path, and card code that is not ours reads the name.
 */
`, 'utf8')

console.log(`sandbox assets: ${ARTIFACTS.map(a => manifest[a]).join(', ')}`)
