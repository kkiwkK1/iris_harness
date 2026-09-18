/**
 * `stage` / `promote` / `discard`: the install transaction, driven as two
 * halves with a decision in between.
 *
 * `installAs` is still the whole thing and its behaviour is unchanged — the
 * suites beside this one prove that, unedited. What is new is that a caller
 * may stop at `hashed`, show a human what it staged, and only then promote.
 * The properties that matter are therefore: the halt really halts (nothing
 * outside staging exists yet), the promotion really uses the record (a handle
 * that is no longer staged cannot promote), and an abandoned stage really goes
 * away rather than waiting for the crash-recovery scan.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { test, type TestContext } from 'node:test'

import { Installer, PROVISIONAL_EXTENSION_ID, SourceError } from '../src/index.ts'
import { demoFileMap, writeTree } from './fixtures/helpers.ts'
import { tempDir } from '../../iris-app-service/tests/support/temp-dir.ts'

async function tempRoot(t: TestContext): Promise<string> {
  return await tempDir(t, 'iris-installer-staged-')
}

async function exists(target: string): Promise<boolean> {
  return await fsp.stat(target).then(() => true, () => false)
}

test('stage halts at hashed: the tree is in staging, the target does not exist, and no claim was taken', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const installer = await Installer.create(path.join(root, 'store'))

  const staged = await installer.stage({ kind: 'local-directory', directoryPath: src })
  assert.equal(staged.txn.phase, 'hashed')
  assert.match(staged.tree.sha256, /^[0-9a-f]{64}$/u)
  assert.ok(staged.tree.files > 0)
  assert.equal(await exists(path.join(staged.contentPath, 'manifest.json')), true)
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [], 'nothing is promoted by staging')
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'claims')), [], 'the claim is taken at promotion, not before')

  // A transaction that has not learned its id yet carries the provisional one,
  // and it is a *valid* extension id so the recovery scan reads an abandoned
  // stage as an ordinary rollback rather than as an untrusted record.
  assert.equal(staged.txn.extensionId, PROVISIONAL_EXTENSION_ID)
})

test('promote learns the id, and the installed tree and lock carry it', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const installer = await Installer.create(path.join(root, 'store'))

  const staged = await installer.stage({ kind: 'local-directory', directoryPath: src })
  const result = await installer.promote(staged, 'late-named')
  assert.equal(result.extensionId, 'late-named')
  assert.equal(result.artifactSha256, staged.tree.sha256, 'the promotion uses the hash staging recorded')
  assert.equal(path.basename(result.targetPath), 'late-named')
  assert.equal((await installer.readLock('late-named'))?.extensionId, 'late-named')
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [], 'a promoted transaction cleans its staging')
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'claims')), [], 'and releases its claim')
})

test('a handle that is no longer staged cannot promote, and the refusal names the phase', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const installer = await Installer.create(path.join(root, 'store'))

  const staged = await installer.stage({ kind: 'local-directory', directoryPath: src })
  await installer.discard(staged)
  assert.equal(staged.txn.phase, 'failed')

  // `not-staged` rather than a phase-transition error: this is the guard that
  // keeps "promote what was staged" from degrading into "promote whatever the
  // record happens to say now", and a caller switching on `SourceError.code`
  // has to be able to tell it from a transition it merely got wrong.
  await assert.rejects(
    () => installer.promote(staged, 'never-installed'),
    (error: unknown) => {
      assert.ok(error instanceof SourceError, `expected a SourceError, got ${String(error)}`)
      assert.equal((error as SourceError).code, 'not-staged')
      assert.match((error as Error).message, /not hashed/u)
      return true
    },
  )
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [])
})

test('discard removes the staging tree and is safe to repeat', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const installer = await Installer.create(path.join(root, 'store'))

  const staged = await installer.stage({ kind: 'local-directory', directoryPath: src })
  assert.equal((await fsp.readdir(path.join(root, 'store', 'staging'))).length, 1)
  await installer.discard(staged)
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [])
  // A cancel that threw on a second call would leave a caller holding a token
  // it cannot retire, so the second one must be a no-op rather than an error.
  await installer.discard(staged)
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [])
})

test('promote refuses an id that is already installed, exactly as installAs does', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const installer = await Installer.create(path.join(root, 'store'))
  await installer.installAs('taken', { kind: 'local-directory', directoryPath: src })

  const staged = await installer.stage({ kind: 'local-directory', directoryPath: src })
  await assert.rejects(
    () => installer.promote(staged, 'taken'),
    (error: unknown) => {
      assert.equal((error as SourceError).code, 'already-installed')
      return true
    },
  )
  // The refused promotion took its staging with it and left the existing
  // install untouched.
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [])
  assert.equal((await installer.readLock('taken'))?.extensionId, 'taken')
})

test('a staged tree that never promotes leaves nothing the recovery scan calls untrusted', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const installer = await Installer.create(path.join(root, 'store'))
  await installer.stage({ kind: 'local-directory', directoryPath: src })

  const actions = await installer.recover()
  assert.equal(actions.length, 1)
  assert.equal(
    actions[0]?.outcome,
    'rolled-back',
    'the provisional id must parse as a valid extension id, or this reads as "untrusted-transaction" — '
    + 'a louder outcome than an abandoned preview deserves',
  )
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [])
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [])
})
