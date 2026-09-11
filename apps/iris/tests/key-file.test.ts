import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * No source file reads a key out of a file on disk.
 *
 * `CONTRIBUTING.md` has said "`key.txt` is never read or printed by tooling
 * either" since the secrets list was written, and on 2026-09-11 the sentence
 * was false in three places: `apps/iris/demo/mvu-roleplay.ts`,
 * `apps/iris/tests/live-provider.test.ts` and
 * `apps/iris/tests/live-generation-kinds.test.ts` each fell back to reading the
 * repository root's `key.txt` when `DEEPSEEK_API_KEY` was unset (audit L-9,
 * `审计报告-网络安全工程.md` §5). A plaintext key on disk is a fact about the
 * machine; a *reader* for it in the tree is what turns that fact into a habit —
 * it makes the file worth keeping, and every path that reads a secret is one
 * `console.log` away from printing one.
 *
 * So the readers are gone and this is the pin. It is a grep in a test, in the
 * same shape as the repository's other source pins, because the property is
 * about what the tree contains rather than about what any one function returns:
 * a unit test on `apiKey()` would go green the moment somebody added a fourth
 * reader somewhere else.
 *
 * **What this does not do**: it never opens `key.txt`, never reports whether
 * one exists and never names a path that could be one. The file belongs to
 * whoever runs this, and the only thing the repository has an opinion about is
 * whether its own sources reach for it.
 *
 * Scope is `apps/`, `packages/` and `scripts/` — the three roots that hold code
 * this repository runs. `.gitignore` names the file on purpose (that is the
 * point of an ignore list) and `CONTRIBUTING.md` / `README.md` describe the
 * rule in prose; neither is a reader. This file is the one allowed occurrence
 * inside the scanned roots, and it is excluded by path rather than by spelling
 * the needle in pieces, because a needle assembled at runtime is a needle the
 * next reader cannot grep for.
 */

// `fileURLToPath`, not `.pathname`: this repository's own path contains
// non-ASCII characters, which a URL percent-encodes.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The literal this check is about, and the only reason it may appear below. */
const NEEDLE = 'key.txt'

/** Path of this file, repo-relative and posix-slashed — the one exception. */
const SELF = 'apps/iris/tests/key-file.test.ts'

/**
 * Tracked files plus untracked-but-not-ignored ones, under the three roots.
 *
 * From git rather than from a directory walk for the reason
 * `md-references.test.ts` gives: `node_modules/`, `dist/` and the built
 * `apps/iris-web/public/sandbox/` are ignored and must not be scanned, and a
 * file written this turn and not yet staged is still this repository's source.
 * `--cached` reads the index, so a file deleted this turn and not yet staged is
 * still listed; filtered against the filesystem here so the scan cannot die of
 * `ENOENT` over a tree that is fine.
 */
function sources(): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'scripts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return listed
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .filter(path => {
      const full = join(ROOT, path)
      return existsSync(full) && statSync(full).isFile()
    })
}

test('no source under apps/, packages/ or scripts/ reads a key file', () => {
  const files = sources()

  // A floor on the population, because the expensive failure of a scan is the
  // one where it scanned nothing: a changed `git ls-files` invocation, a
  // pathspec typo or a cwd surprise all produce an empty list and a green test
  // that has checked no source at all. 731 files were listed on 2026-09-11;
  // 400 is a floor with room for a package to be split out.
  assert.ok(files.length >= 400, `expected to scan the source tree, listed ${files.length} files`)

  const offenders: string[] = []
  let scanned = 0
  for (const path of files) {
    if (path === SELF) continue
    const text = readFileSync(join(ROOT, path), 'utf8')
    scanned += 1
    if (text.toLowerCase().includes(NEEDLE)) offenders.push(path)
  }

  // The same floor again, one layer in: the loop above has a `continue`, and a
  // `continue` that grew a condition is how a check comes to skip its own
  // sample while still reporting a pass.
  assert.ok(scanned >= files.length - 1, `expected to read every listed file, read ${scanned} of ${files.length}`)

  assert.deepEqual(
    offenders,
    [],
    `${NEEDLE} is referenced by ${offenders.length} source file(s): ${offenders.join(', ')}. ` +
      'A provider key reaches this repository through an environment variable only — see CONTRIBUTING.md.',
  )
})

test('this check sees its own needle, and CONTRIBUTING.md still makes the promise', () => {
  // The teeth of the check above: the needle is a real string that a real read
  // of a real file finds. Without this, the scan would be indistinguishable
  // from one whose `includes` argument had been mistyped.
  const self = readFileSync(join(ROOT, SELF), 'utf8')
  assert.ok(self.toLowerCase().includes(NEEDLE), 'this file must contain the literal it searches for')

  // And the sentence the scan exists to make true. If somebody deletes the
  // promise from CONTRIBUTING.md the pin above becomes a rule nobody asked
  // for, which is worth noticing rather than enforcing silently.
  // Whitespace-collapsed, because the promise is a wrapped sentence and a
  // reflow of the paragraph is not a change to what it says (nor is a
  // checkout that gave the file CRLF line endings).
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8').replace(/\s+/g, ' ')
  assert.ok(
    contributing.includes('`key.txt` is never read or printed by tooling either'),
    'CONTRIBUTING.md must still promise that no tooling reads the key file',
  )
})
