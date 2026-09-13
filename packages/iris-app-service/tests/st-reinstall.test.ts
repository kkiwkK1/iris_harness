import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { installedTreePresent } from '../src/st-reinstall.ts'

/**
 * The reinstall predicate. The uninstall rule keeps an extension's installed
 * tree (the artifact and the stored settings are the user's data), so a
 * directory install of the same id must re-adopt instead of tripping the
 * installer's already-installed refusal. The tree's presence is read from its
 * lock — the one file the installer writes last, so a half-open transaction
 * never reads as an installed tree.
 */

async function treeWithLock(t: TestContext, withLock: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'iris-st-reinstall-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const dir = join(root, 'installed', 'prompt-template')
  await mkdir(dir, { recursive: true })
  if (withLock) await writeFile(join(dir, 'lock.json'), '{"artifactSha256":"a".repeat(64)}\n', 'utf8')
  return root
}

test('a lock under the extensions root means the tree is present for re-adoption', async (t) => {
  const withLock = await treeWithLock(t, true)
  assert.equal(installedTreePresent(withLock, 'prompt-template'), true)
})

test('a tree without a lock (half-open transaction) is not an installed tree', async (t) => {
  const withoutLock = await treeWithLock(t, false)
  assert.equal(installedTreePresent(withoutLock, 'prompt-template'), false)
})

test('an extensions root that does not exist yet installs fresh', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'iris-st-reinstall-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  assert.equal(installedTreePresent(root, 'prompt-template'), false)
})
