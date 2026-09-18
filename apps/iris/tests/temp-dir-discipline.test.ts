import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every tool that makes a temporary directory makes it through one helper.
 *
 * Why this exists: on 2026-09-19 this machine's `%TEMP%` held **321 abandoned
 * headless-Chrome profiles totalling 11.5 GB**, under 90 different prefixes,
 * most belonging to QA scripts that no longer exist in the tree. Every one of
 * them was a script that wrote its own `--user-data-dir` path inline, spawned
 * Chrome at it, and exited. None of them was wrong in a way a reviewer would
 * see: the missing line is the one that is not there.
 *
 * So the rule is a **source-text pin**, the way `md-references.test.ts` pins
 * that a cited path exists — not a runtime check, because nothing here runs in
 * CI. Two assertions, because they fail for different reasons:
 *
 *  1. a file under the scanned roots that mentions `--user-data-dir` or
 *     `mkdtemp` must import `qa/chrome-profile.mjs`. That is what keeps the
 *     twenty-first script from being the twenty-first copy;
 *  2. no `--user-data-dir=` may be built out of `process.env.TEMP`,
 *     `tmpdir()`, or a `Date.now()` stamp. This is the one that actually
 *     catches the regression, because a file can import the helper for one
 *     browser and still hand-roll a path for a second one.
 *
 * The allowances below are named individually rather than by pattern. A
 * pattern would quietly grow to cover the next leak; a name has to be typed,
 * and the test checks that each named file still exists and still matches, so
 * an allowance for a file that has since been converted goes red instead of
 * sitting there forever.
 *
 * Scope is the three directories the tooling lives in. `apps/*​/tests` is not
 * scanned: the two live tests that start Chrome
 * (`apps/iris/tests/shell-csp-live.test.ts`,
 * `apps/iris-web/tests/frame-bootstrap-live.test.ts`) already remove their
 * profile and data dir with retries in an `after` hook, and both were measured
 * at zero abandoned directories. They are noted here so a reader does not read
 * the scope as a claim that nothing else starts a browser.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The directories whose tools this rule governs. */
const ROOTS = ['qa', 'apps/iris-web/tools', 'scripts']

/** The helper every one of them must go through. */
const HELPER = 'qa/chrome-profile.mjs'

/**
 * Files that mention the call forms but are not creators, each with the reason.
 *
 * The `scripts/` probes are the interesting group. They do call `mkdtemp`, but
 * under a scratch root the operator names (`IRIS_PROBE_SCRATCH`), they already
 * remove it in a `finally`, and `--keep` preserving a run for inspection is a
 * deliberate feature rather than the leak this test is about. Measured on
 * 2026-09-19: zero `iris-cache-*` directories left in `%TEMP%`, against 321
 * abandoned Chrome profiles. Routing them through the helper would have
 * changed the `--keep` contract to fix something that was not broken.
 */
const allowed = new Map([
  [HELPER, 'is the helper'],
  ['scripts/cache-friendly-probe.mjs', 'run dir under the operator-named IRIS_PROBE_SCRATCH root, removed in a finally unless --keep'],
  ['scripts/cache-history-probe.mjs', 'run dir under the operator-named IRIS_PROBE_SCRATCH root, removed in a finally unless --keep'],
  ['scripts/cache-prefix-probe.mjs', 'run dir under the operator-named IRIS_PROBE_SCRATCH root, removed in a finally unless --keep'],
  ['scripts/script-context-probe.mjs', 'run dir under the operator-named IRIS_PROBE_SCRATCH root, removed in a finally unless --keep'],
  ['scripts/lib/cache-host.mjs', 'run dir under the scratch root its caller passes and its caller removes'],
])

/** Every source file under `ROOTS`, as repo-relative posix paths. */
function sources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = posix.join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (/\.(mjs|cjs|js|ts|tsx)$/.test(entry.name)) found.push(child)
    }
  }
  for (const dir of ROOTS) walk(dir)
  return found.sort()
}

/** The call forms that mean "this file makes a temporary directory". */
function creates(text: string): boolean {
  return text.includes('--user-data-dir') || /\bmkdtemp(Sync)?\s*\(/.test(text)
}

/** Whether `text` imports the shared helper, however deep the relative path. */
function importsHelper(text: string): boolean {
  return /from\s+'(\.{1,2}\/)+(qa\/)?chrome-profile\.mjs'/.test(text)
}

const files = sources().map(path => ({ path, text: readFileSync(join(ROOT, path.split(posix.sep).join(sep)), 'utf8') }))

test('every temp-directory creator under qa/, tools/ and scripts/ goes through qa/chrome-profile.mjs', () => {
  // The scan must have found the tree. A walk that silently returns nothing
  // passes every assertion below it, which is the failure mode this floor is
  // here to make impossible — `qa/` alone held 40 files when this was written.
  assert.ok(files.length >= 50, `scanned only ${String(files.length)} files under ${ROOTS.join(', ')}; the walk is not reaching the tree`)

  const creators = files.filter(file => creates(file.text))
  assert.ok(creators.length >= 20, `only ${String(creators.length)} creators found; 24 were converted, so the match forms have stopped matching`)

  const offenders = creators
    .filter(file => !allowed.has(file.path))
    .filter(file => !importsHelper(file.text))
    .map(file => file.path)

  assert.deepEqual(offenders, [],
    `these make a temporary directory without the shared helper, so nothing removes it when the script exits:\n  ${offenders.join('\n  ')}\n` +
    `Import { chromeProfile } (or tempDir / dataCopy) from ${HELPER} and pass \`profile.dir\` to --user-data-dir.`)
})

test('no --user-data-dir is built from an inline temp path', () => {
  // The second failure shape: a file that imports the helper for one browser
  // and still hand-rolls the path for another. Matched on the argument rather
  // than on the import, so it catches the case the first test cannot see.
  const inline = files
    .filter(file => file.path !== HELPER)
    .filter(file => /--user-data-dir=[^\n'"`]*(process\.env\.TEMP|tmpdir\(\)|Date\.now\(\))/.test(file.text)
      || /'--user-data-dir='\s*\+\s*(process\.env\.TEMP|tmpdir\(\))/.test(file.text))
    .map(file => file.path)

  assert.deepEqual(inline, [],
    `these build a Chrome profile path inline instead of taking one from ${HELPER}:\n  ${inline.join('\n  ')}`)
})

test('every named allowance is still a file that still needs allowing', () => {
  // An allowance that has outlived its file, or its reason, is a hole nobody
  // is looking at. Both directions: the file must exist, and it must still
  // match the creator forms — otherwise the line should simply be deleted.
  const byPath = new Map(files.map(file => [file.path, file.text]))
  for (const [path, reason] of allowed) {
    const text = byPath.get(path)
    assert.ok(text !== undefined, `allowance for ${path} (${reason}) names a file that is not under ${ROOTS.join(', ')} any more`)
    assert.ok(creates(text), `${path} no longer makes a temporary directory, so its allowance (${reason}) should be deleted`)
  }
})

test('the helper removes rather than renames a directory holding key material', () => {
  // Ruling 3: a data-dir copy carries connections.json. The rename-aside
  // fallback that is right for an inert Chrome profile would leave key
  // material on disk under a different name, so the helper must distinguish
  // the two. Pinned in source because the branch only runs when a removal
  // fails, which no test can arrange reliably on Windows.
  const helper = readFileSync(join(ROOT, 'qa', 'chrome-profile.mjs'), 'utf8')
  assert.match(helper, /if \(!entry\.secret\)/, 'the rename-aside fallback is no longer guarded by the secret flag')
  assert.match(helper, /export function dataCopy\(/, 'dataCopy is the documented way to get a removed-not-renamed directory')
  assert.match(helper, /secret: true/, 'dataCopy no longer marks its directory as holding key material')
})
