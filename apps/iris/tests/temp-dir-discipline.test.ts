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
 * The tooling's three directories are the first scope. The **unit tests** are
 * the second, added on the same day and measured the same way, and they get
 * their own block at the bottom of this file because they go through a
 * different helper: `qa/chrome-profile.mjs` installs process-wide signal
 * handlers for a flat script that ends in `process.exit()`, which is not what
 * a `node:test` file needs or can use. See
 * `packages/iris-app-service/tests/support/temp-dir.ts` for why the two are
 * mirrored rather than shared.
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

// --------------------------------------------------------------------------
// The second population: the unit tests.
// --------------------------------------------------------------------------

/**
 * The test trees this rule governs, and the helper they go through.
 *
 * Measured 2026-09-19, the same day as the Chrome profiles above and by the
 * same method: `%TEMP%` held about **45 000 directories** made by these tests'
 * `mkdtemp` calls and never removed — `iris-wb-write-` 10 457, `iris-src-`
 * 8 553, `iris-persona-` 6 499, `iris-sandbox-cors-` 3 348 and a long tail.
 * Each is 0.2–1.1 KB, so the 30 MB is nothing; two `npm test` runs adding 519
 * entries to a folder that already holds tens of thousands is the cost, and it
 * is paid by every tool that lists that folder.
 *
 * This population is not the scripts' population and its numbers say so: 24 of
 * 203 call sites leaked, not all of them. Ninety-five files already wrote the
 * `t.after` removal by hand and the other twenty-four simply did not — which
 * is exactly why the rule is "go through the helper" rather than "remember the
 * second line". A missing line is invisible in review.
 */
const TEST_HELPER = 'packages/iris-app-service/tests/support/temp-dir.ts'

/** Every source file under a test tree, as repo-relative posix paths. */
function testSources(): string[] {
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
  // `packages/*/tests`, `apps/*/tests`, and the repo-level `tests/` — the three
  // shapes the root `npm test` glob covers, plus the fixtures beside them.
  for (const group of ['packages', 'apps']) {
    let entries
    try {
      entries = readdirSync(join(ROOT, group), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      walk(posix.join(group, entry.name, 'tests'))
    }
  }
  walk('tests')
  return found.sort()
}

/**
 * Test files that call `mkdtemp` and are allowed to, each with the reason.
 *
 * One entry. This file is not among them and does not need to be: it names the
 * call forms only inside regular expressions, where the word-boundary escape
 * that opens each pattern sits against a word character in the source text and
 * so stops the pattern from matching its own spelling.
 */
const testAllowed = new Map([
  [TEST_HELPER, 'is the helper'],
])

/** Whether `text` imports the shared test helper, however deep the path. */
function importsTestHelper(text: string): boolean {
  return /from\s+'(\.{1,2}\/)[^']*support\/temp-dir\.ts'/.test(text)
}

const testFiles = testSources()
  .map(path => ({ path, text: readFileSync(join(ROOT, path.split(posix.sep).join(sep)), 'utf8') }))

test('no unit test reaches mkdtemp directly; they all go through the test temp-dir helper', () => {
  // The same floor as above, for the same reason: a walk that returns nothing
  // satisfies every assertion under it. 391 `.ts` files lived under these trees
  // when this was written, in 14 packages and 2 apps.
  assert.ok(testFiles.length >= 300,
    `scanned only ${String(testFiles.length)} files under the test trees; the walk is not reaching them`)

  // And the positive control the floor above cannot give: the helper has to be
  // reached by most of the tree, not merely not-violated by an empty one. 122
  // files imported it when this was written.
  const users = testFiles.filter(file => importsTestHelper(file.text))
  assert.ok(users.length >= 100,
    `only ${String(users.length)} test files import ${TEST_HELPER}; 122 did when this rule was written, so either the import form or the scan has moved`)

  const offenders = testFiles
    .filter(file => !testAllowed.has(file.path))
    .filter(file => /\bmkdtemp(Sync)?\s*\(/.test(file.text))
    .map(file => file.path)

  assert.deepEqual(offenders, [],
    `these unit tests make a temporary directory without the shared helper, so nothing is guaranteed to remove it:\n  ${offenders.join('\n  ')}\n` +
    `Take it from { tempDir } in ${TEST_HELPER} — \`const dir = await tempDir(t, 'iris-x-')\` — which registers the removal on \`t.after\` at the moment it hands the directory over.`)
})

test('the owned form stays rare, and every file using it says why', () => {
  // `tempDirOwned` is the escape hatch: it makes a directory and removes
  // nothing, leaving the caller to call `removeTempDir` at the right moment.
  // It is right for the two shapes `t.after` cannot serve — a directory made in
  // a file-level `before()`, and one a spawned host or browser is still running
  // out of, where a `t.after` removal registered at creation time would run
  // *before* the thing holding it has been stopped.
  //
  // It is also the shape that would silently become the norm again, so it is
  // counted rather than merely allowed, and each file has to carry a comment
  // saying which of the two cases it is.
  const owners = testFiles
    .filter(file => file.path !== TEST_HELPER)
    .filter(file => /\btempDirOwned\s*\(/.test(file.text))

  assert.ok(owners.length <= 20,
    `${String(owners.length)} files use tempDirOwned; 13 did when this rule was written. The removal is the caller's, so each one is a place the leak can come back — if a new one is genuinely needed, raise this number in the same commit that adds it.`)

  const unexplained = owners
    .filter(file => !/`tempDirOwned`, not `tempDir`|tempDirOwned`, not/.test(file.text))
    .map(file => file.path)
  assert.deepEqual(unexplained, [],
    `these take the owned form without saying why it is not \`tempDir\`:\n  ${unexplained.join('\n  ')}`)

  // And what makes the escape hatch safe: every one of them must also call the
  // shared removal. A `tempDirOwned` with no `removeTempDir` anywhere in the
  // file is precisely the 2026-09-19 leak, reintroduced under a new name.
  const abandoned = owners
    .filter(file => !/\bremoveTempDir\s*\(/.test(file.text))
    .map(file => file.path)
  assert.deepEqual(abandoned, [],
    `these make an owned temporary directory and never remove it:\n  ${abandoned.join('\n  ')}`)
})

test('every named test-tree allowance is still a file that still needs allowing', () => {
  const byPath = new Map(testFiles.map(file => [file.path, file.text]))
  for (const [path, reason] of testAllowed) {
    const text = byPath.get(path)
    assert.ok(text !== undefined, `allowance for ${path} (${reason}) names a file that is not under a test tree any more`)
    assert.ok(/\bmkdtemp(Sync)?\s*\(/.test(text),
      `${path} no longer names a temp-directory call form, so its allowance (${reason}) should be deleted`)
  }
})

test('the test helper registers its removal on the context it was handed', () => {
  // The whole claim of `tempDir(t, prefix)` is that the caller cannot forget
  // the second line, because there is no second line. Pinned in source because
  // a test that asserted it at runtime would be asserting that node's own
  // `t.after` works.
  const helper = readFileSync(join(ROOT, TEST_HELPER.split(posix.sep).join(sep)), 'utf8')
  assert.match(helper, /t\.after\(async \(\) => \{ await removeTempDir\(dir\) \}\)/,
    'tempDir no longer registers the removal itself, which is the only thing it is for')
  assert.match(helper, /maxRetries: 30, retryDelay: 200/,
    'the removal retry budget no longer matches qa/chrome-profile.mjs, where the number was measured')
  assert.match(helper, /export async function tempDirOwned\(/,
    'the documented escape hatch for a directory that must outlive the test is gone')
})
