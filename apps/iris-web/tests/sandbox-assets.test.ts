/**
 * The sandbox artifacts are content-addressed, and nothing still names them.
 *
 * These two files were the last fixed URLs Iris served, and a fixed URL whose
 * bytes change is the failure this project has paid for most often: a browser
 * holds yesterday's copy, the frame reports a fault that was fixed an hour ago,
 * and the only known cure was a hard refresh before every verification round.
 * That ritual is not a workaround — it is a standing tax on believing any
 * reading at all.
 *
 * Three things have to stay true together, and each fails silently on its own:
 *
 * 1. the build emits hashed names and records them in a manifest;
 * 2. nothing in the source still spells out an unhashed name — a leftover
 *    literal would fetch a file the build no longer produces, or worse, one it
 *    still does;
 * 3. a superseded artifact is deleted, so a page holding an old reference gets a
 *    **404** rather than last hour's code running silently.
 *
 * @module iris-web/tests/sandbox-assets
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { parseSandboxManifest } from '../src/sandbox/asset-manifest.ts'

const here = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(here, '..', 'public', 'sandbox')

/** Source files that could name an artifact. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path))
    } else if (/\.(?:ts|tsx|mjs)$/u.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

/** Comments stripped, so prose explaining the old names is not read as a use. */
function code(source: string): string {
  const OPEN = String.fromCharCode(47, 42)
  const CLOSE = String.fromCharCode(42, 47)
  const LINE = String.fromCharCode(47, 47)
  const NEWLINE = String.fromCharCode(10)

  let stripped = source
  for (;;) {
    const at = stripped.indexOf(OPEN)
    if (at === -1) break
    const to = stripped.indexOf(CLOSE, at + OPEN.length)
    if (to === -1) break
    stripped = stripped.slice(0, at) + stripped.slice(to + CLOSE.length)
  }
  return stripped
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith(LINE))
    .join(NEWLINE)
}

/**
 * Skip aloud when the build has not run, rather than passing in silence.
 *
 * `public/sandbox/` is gitignored, so on a fresh checkout these artifacts do not
 * exist and there is genuinely nothing to check. The first version of this file
 * returned early — which reports as a **pass**, so three assertions about the
 * most cache-sensitive files in the project would have read as green while
 * checking nothing at all. That is the unfalsifiable silence this project keeps
 * paying to remove, rebuilt here by reflex.
 *
 * Failing instead would be the opposite error: it would report "you have not
 * built yet" as a broken invariant and send a reader hunting a bug that is not
 * there.
 * @param t - the test context.
 * @returns true when the caller should stop.
 */
function skipWithoutBuild(t: { skip: (reason: string) => void }): boolean {
  if (existsSync(join(SANDBOX, 'manifest.json'))) return false
  t.skip('no sandbox build in this checkout — run "npm run build:sandbox"')
  return true
}

test('the manifest names artifacts that exist on disk', t => {
  if (skipWithoutBuild(t)) return
  const parsed = parseSandboxManifest(readFileSync(join(SANDBOX, 'manifest.json'), 'utf8'))
  assert.notEqual(typeof parsed, 'string', `the manifest is unusable: ${String(parsed)}`)
  if (typeof parsed === 'string') return

  for (const url of [parsed.bootstrap, parsed.preset]) {
    const name = url.slice('/sandbox/'.length)
    assert.ok(existsSync(join(SANDBOX, name)), `${url} is named by the manifest but not on disk`)
    assert.ok(/-[0-9a-f]{16}\.js$/u.test(name), `${name} carries no content hash`)
  }
})

test('a rebuild leaves no superseded artifact answering an old URL', t => {
  if (skipWithoutBuild(t)) return
  const parsed = parseSandboxManifest(readFileSync(join(SANDBOX, 'manifest.json'), 'utf8'))
  if (typeof parsed === 'string') return

  const current = new Set([parsed.bootstrap, parsed.preset].map(url => url.slice('/sandbox/'.length)))
  const stale = readdirSync(SANDBOX).filter(
    entry => /^(?:bootstrap|preset)-/u.test(entry) && !current.has(entry),
  )

  /*
   * The property that makes hashing worth anything. Left in place, an old
   * artifact answers its old URL forever, so a tab open across a rebuild keeps
   * running last hour's code and reports nothing wrong — exactly the failure
   * hashing is here to end. Deleted, that tab gets a 404 and says so.
   */
  assert.deepEqual(stale, [], 'superseded artifacts are still being served')
})

test('no source file spells out an unhashed artifact name', () => {
  /*
   * The leftover literal is the quiet way this regresses. It would keep working
   * for exactly as long as someone leaves an unhashed file in the directory, and
   * then start fetching a file the build does not produce — reported three steps
   * later as a frame that never started.
   */
  const offenders: string[] = []
  for (const dir of ['src', 'tools']) {
    for (const file of sourceFiles(join(here, '..', dir))) {
      const body = code(readFileSync(file, 'utf8'))
      if (body.includes('/sandbox/bootstrap.js') || body.includes('/sandbox/preset.js')) {
        offenders.push(file)
      }
    }
  }
  assert.deepEqual(offenders, [], 'these still name an artifact the build no longer emits')
})

test('the directory the host actually serves has no superseded artifact either', t => {
  /*
   * The guard above checks `public/sandbox` — where the build *writes*. The host
   * serves `dist/sandbox` — where Vite *copies*. Vite copies without removing, so
   * that directory accumulated every earlier build: **eleven superseded
   * artifacts against three current ones**, each still answering its own URL.
   *
   * So the property this whole scheme rests on — a superseded name stops being
   * answerable, which is what makes an immutable long-lived cache safe — was
   * only ever true of the directory nobody fetches from. A test that checks the
   * written directory and calls that "the artifacts are pruned" is checking the
   * wrong side of a copy.
   *
   * It cost measurement time too: two instrument revisions were built into
   * `public/` and never reached the browser, and read as "the change had no
   * effect" rather than "the change was never served".
   */
  const served = join(here, '..', 'dist', 'sandbox')
  if (!existsSync(join(served, 'manifest.json'))) {
    t.skip('no built dist in this checkout — run "npm run build"')
    return
  }

  const manifest = JSON.parse(readFileSync(join(served, 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >
  const current = new Set(Object.values(manifest))
  const stale = readdirSync(served).filter(
    entry =>
      /^(?:bootstrap|preset|message-preset)-/u.test(entry) && !current.has(entry),
  )

  assert.deepEqual(stale, [], 'the served directory still answers superseded URLs')
})


test('every font ships once, and ships the bytes the package holds', () => {
  /*
   * Two assertions that have to travel together, because each alone rewards the
   * wrong fix.
   *
   * "The bundle got smaller" is satisfied by losing glyphs. "The fonts are
   * correct" is satisfied by shipping each one five times. So: the decoded set
   * must be **byte-identical to the installed package**, and no payload may
   * appear twice.
   *
   * The oracle is `node_modules`, not a previous build. Comparing against the
   * last artifact only says "nothing changed since whenever", which is also true
   * of two builds that are both wrong.
   *
   * History worth keeping: the split-sheet change that preceded this reduced ten
   * `@font-face` declarations to seven, and its note claims the split sheets
   * inline "every face once". The built artifact disagreed — `v4-font-face`
   * redeclares the same three files under the `FontAwesome` family — which is
   * why the claim is now a test instead of a sentence.
   */
  const dir = join(here, '..', 'dist', 'sandbox')
  if (!existsSync(dir)) return

  const bundle = readdirSync(dir).find(name => name.startsWith('message-preset-'))
  if (bundle === undefined) return
  const code = readFileSync(join(dir, bundle), 'utf8')

  const BACKSLASH = String.fromCharCode(92)
  const pattern = new RegExp(`data:font/woff2;base64,[A-Za-z0-9+${BACKSLASH}/=]+`, 'g')
  const payloads = [...code.matchAll(pattern)].map(match => match[0])

  assert.deepEqual(
    payloads.filter((one, at) => payloads.indexOf(one) !== at),
    [],
    'a font is inlined more than once — every duplicate is its own size in wasted bytes',
  )

  const shipped = new Set(
    payloads.map(one =>
      createHash('sha1')
        .update(Buffer.from(one.slice('data:font/woff2;base64,'.length), 'base64'))
        .digest('hex')),
  )

  const webfonts = join(here, '..', 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts')
  const installed = new Set(
    readdirSync(webfonts)
      .filter(name => name.endsWith('.woff2'))
      .map(name => createHash('sha1').update(readFileSync(join(webfonts, name))).digest('hex')),
  )

  assert.equal(shipped.size, 4, 'the bundle must carry exactly the four faces')
  for (const digest of shipped) {
    assert.ok(installed.has(digest), 'a shipped font is not byte-identical to the installed package')
  }
})
