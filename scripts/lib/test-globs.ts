import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The `node --test` globs, read from the one place they are declared: the
 * root `package.json` `scripts.test`.
 *
 * Why this module exists: on 2026-09-25 the globs were written out three
 * times, in `scripts.test`, in the old `verify` script, and as a `GLOBS`
 * constant in `scripts/check-corpus-skips.mjs`. CI runs only the third, while
 * `apps/iris/tests/test-collection.test.ts` (the guard that every test file on
 * disk is collected) read the first. The three strings happened to agree. If
 * someone had widened `scripts.test`, the collection guard would have gone
 * green while CI never ran the new files. Now all three readers go through
 * {@link testGlobsOf}, so there is one list.
 *
 * TypeScript rather than `.mjs` so that the root program checks it and the
 * tests can import it without a declaration file. Node runs it directly from
 * `.mjs` scripts through type stripping.
 *
 * @module scripts/lib/test-globs
 */

/**
 * The quoted globs in a `node --test` command line.
 *
 * Only double-quoted arguments count, because the globs must be quoted for
 * `node --test` to expand them itself (an unquoted glob is expanded by the
 * shell, differently on each platform). A script with none is a manifest this
 * reader does not understand, so it throws rather than answering an empty
 * list, which every consumer would read as "run nothing".
 *
 * @param script - the text of `scripts.test`.
 * @returns the globs, in order.
 */
export function testGlobsOf(script: string): string[] {
  const globs = [...script.matchAll(/"([^"]+)"/g)].map(match => match[1] as string)
  if (globs.length === 0) {
    throw new Error(`no quoted globs in the test script, so nothing would run: ${script}`)
  }
  return globs
}

/**
 * The globs declared by the root manifest.
 *
 * @param root - the repository root.
 * @returns the globs from `scripts.test`.
 */
export function readTestGlobs(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = manifest.scripts?.['test']
  if (script === undefined) throw new Error('the root manifest has no `test` script')
  return testGlobsOf(script)
}
