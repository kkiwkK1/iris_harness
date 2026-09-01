import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every test file on disk is actually collected by `npm test`.
 *
 * The failure this guards against is the quietest one available: a test file
 * that no glob matches never runs, and `node --test` reports success. "No test
 * went red" and "no test ran" are the same observation from outside the
 * process, so nothing downstream — a green tree, a passing CI job, a rising
 * test count — can tell them apart. Someone adding
 * `packages/foo/src/bar.test.ts` today would get a green tree forever and no
 * signal at all.
 *
 * **This guard has a self-referential boundary, and it is worth stating.** A
 * guard that checks collection must itself be collected. If the glob broke
 * badly enough to miss *this* file, it would not fail — it would be absent, and
 * absence looks exactly like success. So what it can catch is the case where it
 * is collected and something else is not: a new file in an uncovered location,
 * a renamed directory, a `.spec.ts` where the glob wants `.test.ts`. What it
 * cannot catch is someone breaking the shared prefix out from under it.
 *
 * That is why the first assertion is that this file is in the collection. It
 * does not close the hole above — nothing here can — but it puts "the guard
 * ran" into the record, so a reader is not left inferring liveness from the
 * absence of red.
 *
 * Lives at the composition root for the same reason `architecture.test.ts`
 * does: it is the only place entitled to know the whole tree exists.
 */

// `fileURLToPath`, not `.pathname`: this repository's own path contains
// non-ASCII characters, which a URL percent-encodes.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const slash = (path: string): string => path.split('\\').join('/')

/** The globs `npm test` actually passes to `node --test`, read from the manifest. */
async function collectionPatterns(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = manifest.scripts?.['test']
  assert.ok(script, 'the root manifest has no `test` script')
  const patterns = [...script.matchAll(/"([^"]+)"/g)].map(match => match[1] as string)
  assert.ok(patterns.length > 0, `no quoted globs found in the test script: ${script}`)
  return patterns
}

/**
 * Everything that looks like a test, from the repository root.
 *
 * Deliberately wider than the collection globs — a file only counts as an
 * orphan if this sees it and the collection does not, so this side has to be
 * able to see into places the collection cannot reach. `.reference/` holds
 * vendored upstream trees (gitignored, with their own runners) and is not ours
 * to run.
 */
function testLookingFiles(): string[] {
  return globSync('{packages,apps}/**/*.{test,spec}.{ts,tsx,mts,mjs,js}', { cwd: ROOT })
    .map(slash)
    .filter(path => !path.includes('node_modules/') && !path.startsWith('.reference/'))
}

test('this guard is itself collected', async () => {
  const collected = new Set(
    (await collectionPatterns()).flatMap(pattern => globSync(pattern, { cwd: ROOT })).map(slash),
  )
  assert.ok(
    collected.has('apps/iris/tests/test-collection.test.ts'),
    'the collection guard is not in the collection it checks; renaming or moving it silences it',
  )
})

test('every test file on disk is collected by `npm test`', async () => {
  const collected = new Set(
    (await collectionPatterns()).flatMap(pattern => globSync(pattern, { cwd: ROOT })).map(slash),
  )
  const orphans = testLookingFiles().filter(path => !collected.has(path))
  assert.deepEqual(
    orphans,
    [],
    `these test files exist but no glob in \`npm test\` matches them, so they never run:\n  ${orphans.join('\n  ')}`,
  )
})

/**
 * The caliper can see a miss.
 *
 * Without this, "0 orphans" is equally consistent with a correct collection and
 * with a comparison that cannot detect anything — the same ambiguity the test
 * above exists to remove, one level down. So: hand it a pattern known to be
 * wrong (`test/`, singular, is not what these directories are called) and
 * confirm the comparison reports the miss rather than shrugging.
 */
test('a wrong pattern is reported as a miss', () => {
  const wrong = new Set(globSync('packages/*/test/**/*.test.ts', { cwd: ROOT }).map(slash))
  const files = testLookingFiles()
  assert.ok(files.length > 0, 'no test files found at all — the disk side of the comparison is blind')
  assert.equal(wrong.size, 0, 'the deliberately wrong pattern matched something; it is no longer wrong')
  assert.ok(
    files.filter(path => !wrong.has(path)).length === files.length,
    'the comparison failed to report files a broken pattern misses',
  )
})
