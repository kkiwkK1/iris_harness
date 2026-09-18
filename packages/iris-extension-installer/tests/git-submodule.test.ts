import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { test, type TestContext } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { Installer, LOCK_FILE_NAME, hashTree } from '../src/index.ts'
import { demoFileMap, writeTree } from './fixtures/helpers.ts'
import { tempDir } from '../../iris-app-service/tests/support/temp-dir.ts'

/**
 * §9 #5 — git never brings submodule content into the installed tree.
 *
 * This suite existed as a gap for exactly one round: `docs/SYSTEM-PLUGIN-INSTALL.md`
 * §9 recorded the invariant as the one row of its table with no test anywhere in
 * the tree. What the fixture proves, and what it deliberately does not:
 *
 * - The invariant "no submodule content in the installed tree" is held by the
 *   argv **not containing `git submodule update`** — not by the
 *   `--no-recurse-submodules` flag. Measured on git 2.33.0.windows.2: this path
 *   is `fetch --depth 1` + `checkout --detach FETCH_HEAD`, and it never runs
 *   `submodule update`, so no submodule object can reach a working tree at all.
 *   Deleting the flag, or even replacing it with `--recurse-submodules`, leaves
 *   the working tree byte-identical (measured). The behaviour assertions below
 *   redden when someone adds `submodule update`; the flag is pinned by its own
 *   source-text assertion in the last test of this file.
 * - What checkout leaves at the gitlink's path is an existing **empty
 *   directory** (measured on 2.33.0.windows.2), not an absent one. Both shapes
 *   are accepted, because which of the two a checkout produces is git's
 *   business and has varied across versions; the invariant is about content.
 * - `.gitmodules` is an ordinary tracked file: it **stays** in the tree and
 *   contributes to the artifact hash. It is pinned as present, so a future
 *   "tidy up" that filters it reds an assertion and reads why.
 */

interface SubmoduleFixture {
  repoUrl: string
  commit: string
}

/**
 * Builds a real repository carrying a real gitlink (index mode 160000) at
 * `sub`, with a `.gitmodules` beside it — **without `git submodule add`**.
 *
 * Since git 2.38.1 the `file://` submodule transport is refused by default
 * (`protocol.file.allow`), so a fixture built through `submodule add` would
 * make this suite's green/red depend on the CI's git version. Writing the
 * index entry directly (`update-index --add --cacheinfo 160000,<sha>,sub`)
 * touches no transport layer and behaves identically everywhere; it produces
 * the same tree a real `submodule add` would have committed.
 */
async function buildSubmoduleFixture(base: string, files: Map<string, Buffer | string>): Promise<SubmoduleFixture> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  const run = (cwd: string, args: string[]): string => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr)}`)
    return String(r.stdout)
  }

  // The inner repository holds the one file a recursion would leak.
  const inner = path.join(base, 'inner')
  fs.mkdirSync(inner, { recursive: true })
  run(inner, ['init', '-q', '-b', 'main', '.'])
  await fsp.writeFile(path.join(inner, 'secret.txt'), 'submodule payload, never wanted in the tree\n', 'utf8')
  run(inner, ['add', '-A'])
  run(inner, ['commit', '-q', '-m', 'inner'])
  const innerCommit = run(inner, ['rev-parse', 'HEAD']).trim()

  // The outer repository is the extension itself: the demo tree, a real
  // .gitmodules, and the gitlink recorded straight into the index.
  const outer = path.join(base, 'outer')
  fs.mkdirSync(outer, { recursive: true })
  run(outer, ['init', '-q', '-b', 'main', '.'])
  await writeTree(outer, files)
  await fsp.writeFile(
    path.join(outer, '.gitmodules'),
    `[submodule "sub"]\n\tpath = sub\n\turl = file://${inner.replace(/\\/gu, '/')}\n`,
    'utf8',
  )
  run(outer, ['add', '-A'])
  run(outer, ['update-index', '--add', '--cacheinfo', `160000,${innerCommit},sub`])
  run(outer, ['commit', '-q', '-m', 'outer with a gitlink'])
  const commit = run(outer, ['rev-parse', 'HEAD']).trim()

  // Guard the guard. Every assertion below asserts *absence*, and absence is
  // exactly what a fixture degraded into a plain directory would trivially
  // produce — so the index is required to carry the gitlink, or the suite
  // would stay green while proving nothing.
  const ls = run(outer, ['ls-files', '-s'])
  assert.ok(
    ls.split('\n').some(line => line.startsWith('160000 ') && line.trimEnd().endsWith('\tsub')),
    `fixture sanity: the index must carry a gitlink at sub, saw:\n${ls}`,
  )
  return { repoUrl: `file://${outer.replace(/\\/gu, '/')}`, commit }
}

test('a gitlink in the fetched commit brings no submodule content into the tree, and .gitmodules itself stays and hashes', async (t: TestContext) => {
  const root = await tempDir(t, 'iris-installer-submodule-')
  const fixture = await buildSubmoduleFixture(path.join(root, 'src'), demoFileMap())

  const installer = await Installer.create(path.join(root, 'store'))
  const result = await installer.installAs(
    'demo-ext',
    { kind: 'git', repository: fixture.repoUrl, commit: fixture.commit },
    { allowLocalGit: true },
  )
  const tree = result.targetPath

  // (1) The gitlink's path holds no content: an existing empty directory (what
  // this git leaves) or no directory at all are both accepted, because the
  // invariant is about content, not about which empty shell the checkout draws.
  const sub = path.join(tree, 'sub')
  const subEntries = await fsp.readdir(sub).then(
    entries => entries,
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException)?.code, 'ENOENT',
        'reading the submodule path failed for a reason other than its absence')
      return null
    },
  )
  assert.ok(
    subEntries === null || subEntries.length === 0,
    `the submodule path must hold no content, saw ${subEntries === null ? 'an absent directory' : `${String(subEntries.length)} entr(ies)`}`,
  )

  // (2) The content is nowhere in the installed tree — not flattened under
  // another name either, which (1) alone would not catch.
  const leaks: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && entry.name === 'secret.txt') leaks.push(child)
    }
  }
  await walk(tree)
  assert.deepEqual(leaks, [], 'submodule content reached the installed tree')

  // (3) The hash counts exactly the outer tree's own files — the four demo
  // files, .gitmodules, and the lock written after promotion. An equality,
  // not a "does not contain": an inequality is vacuously true for empty
  // directories and would have no teeth.
  const hashed = await hashTree(tree)
  assert.equal(
    hashed.files,
    demoFileMap().size + 1 + 1,
    `the installed tree must hold exactly the outer repository's own files (demo tree + .gitmodules + ${LOCK_FILE_NAME}), saw ${String(hashed.files)}`,
  )

  // (4) .gitmodules is in the tree AND contributes to the hash: drop it from
  // the walk and the aggregate must change. A filter added anywhere between
  // fetch and lock reds this line with its reason attached above.
  const modules = await fsp.readFile(path.join(tree, '.gitmodules'), 'utf8')
  assert.match(modules, /\[submodule "sub"\]/, '.gitmodules did not survive into the installed tree')
  const withoutModules = await hashTree(tree, rel => rel === '.gitmodules')
  assert.notEqual(
    hashed.sha256,
    withoutModules.sha256,
    '.gitmodules contributes nothing to the artifact hash, so a filter would not be caught by the counts alone',
  )
})

test('the fetch argv still carries --no-recurse-submodules, on purpose', () => {
  // A SOURCE-TEXT assertion, the same shape as app-service's "never spawns
  // anything but git". It does not claim behaviour coverage and must not be
  // read as if it did: measured on git 2.33.0.windows.2, deleting the flag —
  // or replacing it with --recurse-submodules — leaves the working tree
  // byte-identical, because this path is fetch + checkout --detach and never
  // runs `git submodule update`, and the behaviour suite above is what reds
  // when someone adds that command. The flag is kept as a saved network round
  // trip and as the place the intent is declared; this line is what notices
  // its removal.
  const text = fs.readFileSync(new URL('../src/source.ts', import.meta.url), 'utf8')
  assert.ok(
    text.includes(`'--no-recurse-submodules'`),
    "materializeGit's fetch argv dropped --no-recurse-submodules — harmless to the tree (see this file's docblock) but the intent is no longer declared where the argv is built",
  )
})
