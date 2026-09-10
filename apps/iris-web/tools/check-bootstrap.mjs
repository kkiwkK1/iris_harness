/**
 * Refuse to ship a bootstrap the frame will not be able to run, or a frame that
 * would not notice.
 *
 * The failure this started as a guard against cost a full verification round and
 * was invisible from inside the frame: a dev server rewrote the file into an ES
 * module, and the resulting `import` was a **parse-time** error in the `srcdoc`
 * classic script — so the block never executed and the frame's own reporter never
 * existed to report it. A parse error cannot be caught by the thing failing to
 * parse, so the check happens at build time, on the emitted bytes, outside.
 *
 * **Since 2026-09-10 it also checks the wiring, because there is wiring now.**
 * The bootstrap is no longer inlined into each frame; the frame loads it with a
 * blocking classic `<script src>` at a content-hashed URL
 * (`notes/apps/iris-web/DEVIATIONS.md` §91). That introduces two joints an
 * inlined string did not have, and both fail silently:
 *
 * - **The name.** A manifest naming a file this build did not emit, or a file
 *   whose bytes no longer match the hash in its own name, produces a frame that
 *   404s or runs somebody else's build. So the artifact is hashed here and the
 *   name it must carry is compared with the name the manifest gives.
 * - **The tag.** The whole move rests on one premise — a blocking classic script
 *   finishes before the body parses — and that premise is a property of the *tag*,
 *   not of the file. An `async`, a `defer` or a `type="module"` would leave every
 *   assertion in `srcdoc.ts` true about the document and false about the timing.
 *   So the real `srcdoc` is built here and read.
 *
 * This is the first of the three checks that premise gets. The second is in the
 * frame (`bootstrap-contract.ts`'s guard, which observes the served bytes in the
 * frame that loaded them); the third is a real browser
 * (`tests/frame-bootstrap-live.test.ts`, with a 404 control). They are ordered
 * by how early they can speak and by how much they can see, and none of them
 * subsumes another.
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkBootstrap } from '../src/sandbox/bootstrap-source.ts'
import { FRAME_BUDGET_BYTES, FRAME_COUNT_LIMIT, FRAME_OVERHEAD_BYTES } from '../src/app/frame-budget.ts'
import { buildSrcdoc } from '../src/sandbox/srcdoc.ts'
import { BOOTSTRAP_TAG_MARK, bootstrapGuard } from '../src/sandbox/bootstrap-contract.ts'
import { parseSandboxManifest } from '../src/sandbox/asset-manifest.ts'
import { hashedName } from './asset-fingerprint.mjs'

/** Stop with a sentence, in the one shape this file's failures take. */
function refuse(what, ...detail) {
  console.error(`bootstrap check failed: ${what}`)
  for (const line of detail) console.error(`  ${line}`)
  process.exit(1)
}

const sandboxDir = fileURLToPath(new URL('../public/sandbox', import.meta.url))

/**
 * This build's artifacts, read through the **shell's own manifest parser**.
 *
 * Not `JSON.parse` here, and that is a deliberate narrowing: the shell resolves
 * asset URLs with `parseSandboxManifest`, which rejects a path where a bare
 * filename belongs and refuses an HTML body. Using the same function means a
 * manifest this check accepts is a manifest the shell will accept — where a
 * local parser would have been a second, laxer opinion about the same file.
 */
let assets
try {
  assets = parseSandboxManifest(readFileSync(join(sandboxDir, 'manifest.json'), 'utf8'))
} catch {
  refuse('no sandbox manifest — run the hash step after building')
}
if (typeof assets === 'string') refuse(`the sandbox manifest is unusable: ${assets}`)

/*
 * `parseSandboxManifest` answers a **path** (`/sandbox/<name>`), which is what
 * the shell needs and not what a filesystem read needs. Split rather than
 * re-read from the raw JSON, so there is exactly one reading of the manifest.
 */
const name = assets.bootstrap.slice('/sandbox/'.length)
const file = join(sandboxDir, name)

let source
try {
  source = await readFile(file, 'utf8')
} catch {
  refuse(
    `the manifest names ${name} but no such file is in public/sandbox`,
    'the manifest and the directory disagree — run "npm run build:sandbox"',
  )
}

const why = checkBootstrap(source)
if (why !== undefined) {
  refuse(why, file, `starts with: ${JSON.stringify(source.slice(0, 120))}`)
}

/*
 * ─── ① The name is this build's name ──────────────────────────────────────
 *
 * A content-addressed name is only worth anything if the content still hashes
 * to it. Two ways it stops doing so, and neither has a symptom:
 *
 * - A **stale manifest** beside a fresh artifact. The frame's tag would point
 *   at a name nothing answers, and the failure arrives as the frame's guard
 *   saying "nothing was delivered" — correct, and three steps from the cause.
 * - A file **touched after hashing**. Then a name promising immutability is
 *   served with `cache-control: immutable` for a year
 *   (`@iris/app-service`'s sandbox-asset route reads its immutable set from this
 *   very manifest), which is the one failure content hashing exists to make
 *   impossible.
 *
 * Hashed with the same function the hash step names the file with, so this
 * compares the build against itself rather than one convention against another.
 */
const expected = hashedName('bootstrap', Buffer.from(source, 'utf8'))
if (expected !== name) {
  refuse(
    `the manifest names ${name} but its bytes hash to ${expected}`,
    'the artifact changed after it was named, or the manifest is from an earlier build',
    'the host serves every manifest name as `immutable`, so a wrong name here is cached for a year',
  )
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
 *
 * **Two counts now, not one combined count.** The bootstrap is one of the
 * frame's two scripts; the guard is the other, and it holds a `postMessage` of
 * its own — the pre-bridge report it sends when the bootstrap never installed.
 * A single count across both would be one number satisfied by two wrong
 * distributions (two reads in the bootstrap and none in the guard reads the
 * same as one each), so each is asserted where it belongs.
 */
const PM = /\.postMessage|\[\s*["']postMessage["']\s*\]/g
const reads = source.match(PM)?.length ?? 0
const mentions = source.match(/postMessage/g)?.length ?? 0
if (reads !== 1) {
  refuse(
    `expected exactly one postMessage read in the bootstrap (the capture at boot), found ${reads} reads in ${mentions} mentions`,
    'a late `window.parent.postMessage` read is severed the moment the bridge is published',
  )
}

const guard = bootstrapGuard()
const guardReads = guard.match(PM)?.length ?? 0
if (guardReads !== 1) {
  refuse(
    `expected exactly one postMessage read in the frame guard, found ${guardReads}`,
    'the guard reports through `window.parent` before the bridge exists; a second read is a second channel',
  )
}

/*
 * ─── ② The tag the frame will actually emit ────────────────────────────────
 *
 * Built from `srcdoc.ts` rather than described here, so this checks the
 * assembly the frame gets instead of a belief about it. The URL is the one the
 * manifest just yielded, which is what makes this the **hash** check the build
 * was asked for: the document under assertion points at this build's file, by
 * name, or the assertion below fails.
 */
const ORIGIN = 'http://127.0.0.1:8790'
const TOKEN = 'a'.repeat(32)
const bootstrapUrl = `${ORIGIN}${assets.bootstrap}`

/**
 * A deliberately long origin, for the figure the budget is compared against.
 *
 * The shell's origin appears **seven times** in a frame document — three CSP
 * directives, the `iris-origin` meta, the sentinel link, and the three script
 * `src`s — so the wrapper's size depends on where Iris is deployed. Measuring
 * only at `http://127.0.0.1:8790` (21 characters) would budget for the
 * developer's machine and let a deployment behind a long hostname quietly cost
 * more than the reading window charges. So both are measured, both are printed,
 * and the **long** one is what the comparison uses.
 */
const LONG_ORIGIN = 'https://cards.iris.example-deployment.internal:8443'

/** One frame document per shape and origin, so the widest is what gets budgeted. */
const shapes = [ORIGIN, LONG_ORIGIN].flatMap(origin =>
  [false, true].flatMap(networkGranted =>
    [undefined, ''].map(body => ({
      label: `${body === undefined ? 'script' : 'interface'} frame, network`
        + ` ${networkGranted ? 'granted' : 'closed'}, ${String(origin.length)}-char origin`,
      origin,
      doc: buildSrcdoc(TOKEN, `${origin}${assets.bootstrap}`, {
        networkGranted,
        libraries: [`${origin}${assets.messagePreset}`],
        members: `${origin}${assets.members}`,
        selfOrigin: origin,
        ...(body === undefined ? {} : { body }),
      }),
    })),
  ),
)

const sample = shapes[0].doc

/** The whole `<script …>` opening tag at an index, for reading its attributes. */
function tagAt(doc, at) {
  return doc.slice(doc.lastIndexOf('<script', at), doc.indexOf('>', at) + 1)
}

/*
 * Located by its `src`, not by the marker attribute — and that is not
 * fastidiousness. The guard's own source contains the string
 * `script[data-iris-bootstrap]`, because that is how it finds the tag at run
 * time, so `indexOf(BOOTSTRAP_TAG_MARK)` finds whichever comes first in the
 * document. Under the correct order that is the tag; under a wrong order it is
 * the guard, and the check then went red with a message about the *guard's*
 * attributes. Measured while proving these assertions can fail.
 */
const tagAtIndex = sample.indexOf(`src="${bootstrapUrl}"`)
if (tagAtIndex === -1) {
  refuse(
    'the frame document carries no tag loading the artifact this build emitted',
    `expected src="${bootstrapUrl}"`,
    sample.includes(BOOTSTRAP_TAG_MARK)
      ? `there is a ${BOOTSTRAP_TAG_MARK} attribute in the document, so the tag exists and points elsewhere`
      : 'srcdoc.ts no longer emits a bootstrap tag, so nothing in the frame loads it',
  )
}
const tag = tagAt(sample, tagAtIndex)

if (!tag.includes(BOOTSTRAP_TAG_MARK)) {
  refuse(
    `the frame bootstrap tag does not carry ${BOOTSTRAP_TAG_MARK}`,
    'the frame guard finds the tag by that attribute, to read the failing URL off the document',
    `tag: ${tag}`,
  )
}
for (const forbidden of ['async', 'defer', 'type=']) {
  if (new RegExp(`\\b${forbidden}`).test(tag)) {
    refuse(
      `the frame bootstrap tag carries ${forbidden.replace('=', '')}, so it no longer blocks the parser`,
      "the card's markup reads bridged names at parse time; a deferred bootstrap runs after it",
      `tag: ${tag}`,
    )
  }
}
if (!tag.includes('crossorigin="anonymous"')) {
  refuse(
    'the frame bootstrap tag does not request CORS',
    'an opaque-origin frame redacts a cross-origin throw to the bare words "Script error."',
    `tag: ${tag}`,
  )
}

/*
 * The guard's **position**, not its presence. A guard emitted before the tag
 * always sees "no marker" and reports a working frame as broken; a guard emitted
 * after the card's markup cannot stop anything, which is the half of its job that
 * is not reporting.
 */
const guardAt = sample.indexOf(guard)
if (guardAt === -1) {
  refuse(
    'the frame document does not carry the bootstrap guard',
    'a bootstrap that never runs would then be a frame full of ReferenceErrors blamed on the card',
  )
}
if (guardAt < sample.lastIndexOf('<script', tagAtIndex)) {
  refuse(
    'the bootstrap guard runs before the bootstrap tag',
    'it would report every healthy frame as one whose bootstrap did not install',
  )
}

/*
 * And on an interface frame, before the markup. `MARKER` is a body this check
 * supplies, so a `srcdoc` that dropped the body entirely fails here too.
 */
const MARKER = '<div id="iris-check-body"></div>'
const withBody = buildSrcdoc(TOKEN, bootstrapUrl, {
  networkGranted: false,
  libraries: [],
  selfOrigin: ORIGIN,
  body: MARKER,
})
const bodyAt = withBody.indexOf(MARKER)
if (bodyAt === -1) refuse('the frame document dropped the card markup it was handed')
if (withBody.indexOf(guard) > bodyAt) {
  refuse(
    "the bootstrap guard is emitted after the card's markup",
    'by then the markup has parsed and run, which is what the guard exists to prevent',
  )
}

/*
 * And nothing inlined it after all. A `srcdoc` that carried both the tag and the
 * source would pass every assertion above while charging the frame the bytes
 * twice — and the budget below would read the wrapper and miss them.
 */
if (sample.includes(source.slice(0, 200))) {
  refuse(
    'the frame document contains the bootstrap source as well as a tag for it',
    'the bytes would be paid per frame again, and the overhead measured below would not see them',
  )
}

/*
 * ─── The frame budget's basis, checked against what it now describes ───────
 *
 * `FRAME_OVERHEAD_BYTES` is what every frame costs before its card writes
 * anything, and the whole reading-window budget is denominated in it. It is a
 * **measurement**, rounded to a whole KiB on purpose so that per-build drift does
 * not make the documentation stale — and until 2026-09-10 the measurement was
 * `bootstrap bytes + a stated 1 KiB allowance for the wrapper`, because the
 * wrapper is assembled per frame and there was no artifact on disk to weigh.
 *
 * There still is not, so the wrapper is **built and weighed** instead of
 * allowed for: `buildSrcdoc` is right here, and an allowance was the weaker half
 * of the old reading in any case. Now that the wrapper *is* the whole figure,
 * an allowance would be the entire figure guessed.
 *
 * The two directions are not symmetric:
 *
 * - **Understating fails.** If the constant no longer covers the wrapper, every
 *   frame is charged less than it costs and the layer's only hard number is
 *   wrong in the direction that removes the protection.
 * - **Overstating warns, and the warning had to be rebuilt.** The rule was "warn
 *   when the constant is more than a quarter above the measurement", on the
 *   reasoning that overstating makes the budget needlessly tight. At a 54 KiB
 *   overhead that was true: a quarter was 13 KiB per frame, 270 KiB across a
 *   full gate, an eighth of the whole budget. At 4 KiB a quarter is 1 KiB
 *   per frame — 15 KiB across the gate, 0.7% of the budget — so the old rule
 *   fires on an overstatement that costs nothing, and a warning nobody can act
 *   on is how a build log stops being read. The fraction is kept **and** paired
 *   with a materiality test: the waste has to be worth more than 5% of the
 *   budget across a full gate. Changed because the dimension changed, not to
 *   silence a particular reading — the fraction alone would have been silenced
 *   by moving 0.75 to 0.70, which is fitting the instrument to the data.
 */
let widest = shapes[0]
let here = shapes[0]
for (const shape of shapes) {
  const size = Buffer.byteLength(shape.doc, 'utf8')
  if (size > Buffer.byteLength(widest.doc, 'utf8')) widest = shape
  if (shape.origin === ORIGIN && size > Buffer.byteLength(here.doc, 'utf8')) here = shape
}
const measured = Buffer.byteLength(widest.doc, 'utf8')
const local = Buffer.byteLength(here.doc, 'utf8')

if (measured > FRAME_OVERHEAD_BYTES) {
  refuse(
    `a frame wrapper now costs ${measured} bytes (${widest.label}) but FRAME_OVERHEAD_BYTES is ${FRAME_OVERHEAD_BYTES}`,
    'the reading window would charge less per frame than a frame costs',
    'raise FRAME_OVERHEAD_BYTES in src/app/frame-budget.ts to the next whole KiB',
    'and add a row to its table. Since 2026-09-10 that is the whole of the fix:',
    'the degradation point is 512 frames at 4 KiB, so FRAME_COUNT_LIMIT is nowhere',
    'near the invariant and a kibibyte here no longer costs a live panel (§91)',
  )
}
const wasted = (FRAME_OVERHEAD_BYTES - measured) * FRAME_COUNT_LIMIT
if (measured < FRAME_OVERHEAD_BYTES * 0.75 && wasted > FRAME_BUDGET_BYTES * 0.05) {
  console.warn(
    `bootstrap check: FRAME_OVERHEAD_BYTES (${FRAME_OVERHEAD_BYTES}) overstates a frame by more`
      + ` than a quarter — measured ${measured} bytes — and across ${String(FRAME_COUNT_LIMIT)} frames`
      + ` that withholds ${wasted} bytes of a ${FRAME_BUDGET_BYTES}-byte budget`,
  )
  console.warn('  harmless, but the budget is tighter than it needs to be')
}

console.log(
  `bootstrap check: ok (${name}, ${source.length} bytes, classic, channel captured once,`
    + ' fetched by hashed URL, guard after the tag and before the body)',
)
console.log(
  `  frame overhead: ${measured} bytes of wrapper (${widest.label}; guard ${guard.length})`
    + ` against a budgeted ${FRAME_OVERHEAD_BYTES}`,
)
console.log(`  on this machine's dev origin it is ${local} bytes (${here.label})`)
