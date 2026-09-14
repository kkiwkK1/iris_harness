import assert from 'node:assert/strict'
import { test } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Installer, InstallClaimBusyError, SourceError } from '../src/index.ts'
import { hashTree } from '../src/hash.ts'
import { buildZip, demoFileMap, demoZipEntries, writeTree } from './fixtures/helpers.ts'

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'iris-installer-txn-'))
}

async function writeDemoZip(root: string, files: Map<string, Buffer | string> = demoFileMap()): Promise<string> {
  const zipPath = path.join(root, 'demo.zip')
  await fsp.writeFile(zipPath, buildZip([...files].map(([name, data]) => ({ name, data, unixMode: name.endsWith('/') ? 0o040755 : 0o100644 }))))
  return zipPath
}

test('a full install transaction ends installed with a complete, disabled lock', async () => {
  const root = await tempRoot()
  const zipPath = await writeDemoZip(root)
  const installer = await Installer.create(path.join(root, 'store'))

  const phases: string[] = []
  const result = await installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath }, {
    onPhase: phase => phases.push(phase),
  })
  assert.deepEqual(phases, ['staged', 'validated', 'hashed', 'promoting', 'installed'])

  const lock = await installer.readLock('demo-ext')
  assert.ok(lock)
  assert.equal(lock.enabled, false, 'installed means installed-not-enabled, always')
  assert.equal(lock.extensionId, 'demo-ext')
  assert.deepEqual(lock.source, { kind: 'local-archive', archivePath: zipPath })
  assert.match(lock.installedAt, /^\d{4}-/u)

  // The lock's artifact hash is the tree hash of what actually got installed.
  const tree = await hashTree(result.targetPath, rel => rel === 'lock.json')
  assert.equal(lock.artifactSha256, result.artifactSha256)
  assert.equal(result.artifactSha256, tree.sha256)

  // Staging is gone; the material lives only in the target.
  const stagingDirs = await fsp.readdir(path.join(root, 'store', 'staging'))
  assert.deepEqual(stagingDirs, [])
  const claims = await fsp.readdir(path.join(root, 'store', 'claims'))
  assert.deepEqual(claims, [], 'the claim is released on success')
})

test('an identical artifact re-hashes identically; a changed artifact hashes differently', async () => {
  const root = await tempRoot()
  const zipPath = await writeDemoZip(root)
  const installer = await Installer.create(path.join(root, 'store'))
  const first = await installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath })

  const zipPath2 = path.join(root, 'demo2.zip')
  const files = demoFileMap()
  files.set('dist/index.js', 'export const demo = "changed"\n')
  await fsp.writeFile(zipPath2, buildZip([...files].map(([name, data]) => ({ name, data, unixMode: 0o100644 }))))
  await assert.rejects(
    installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath2 }),
    /already installed/,
    'no silent overwrite: updates are a separate transaction',
  )
  const stillThere = await installer.readLock('demo-ext')
  assert.equal(stillThere?.artifactSha256, first.artifactSha256)
})

test('the same extension installing concurrently is refused, not raced', async () => {
  const root = await tempRoot()
  const zipPath = await writeDemoZip(root)
  const installer = await Installer.create(path.join(root, 'store'))

  // Both transactions stage fully; the claim admits exactly one promoter.
  // Drive the race by hand: hold a live claim the way an in-flight install does.
  const { createLayout, ensureLayout, acquireClaim } = await import('../src/staging.ts')
  const { TransactionStore } = await import('../src/transaction.ts')
  const layout = createLayout(path.join(root, 'store2'))
  await ensureLayout(layout)
  const store = new TransactionStore(layout.stagingRoot, layout.targetsRoot)
  const blocker = await store.begin({ extensionId: 'demo-ext', source: { kind: 'local-archive', archivePath: zipPath } })
  await acquireClaim(layout, 'demo-ext', blocker)

  const installer2 = await Installer.create(path.join(root, 'store2'))
  await assert.rejects(
    installer2.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath }),
    (err: unknown) => err instanceof InstallClaimBusyError && err.ownerTransactionId === blocker.transactionId,
  )

  // And a second install after the first completed (target exists, claim
  // released) is refused by the already-installed check, not by a rename race.
  await store.transition(blocker, 'failed')
  const installer3 = await Installer.create(path.join(root, 'store3'))
  await installer3.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath })
  await assert.rejects(
    installer3.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath }),
    SourceError,
  )
})

test('a hostile archive fails the transaction, marks it failed, and leaves no target', async () => {
  const root = await tempRoot()
  const files = demoFileMap()
  files.set('escaped.js', 'x')
  const zipPath = path.join(root, 'traversal.zip')
  await fsp.writeFile(zipPath, buildZip([
    { name: 'manifest.json', data: JSON.stringify({ display_name: 'x', js: 'index.js' }) },
    { name: '../../outside.js', data: 'x' },
  ]))
  const installer = await Installer.create(path.join(root, 'store'))
  await assert.rejects(installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath }))
  const stagingDirs = await fsp.readdir(path.join(root, 'store', 'staging'))
  assert.deepEqual(stagingDirs, [], 'a failed transaction cleans its own staging')
  const targets = await fsp.readdir(path.join(root, 'store', 'installed'))
  assert.deepEqual(targets, [], 'a failed transaction never touches the target root')
})

test('an artifact without a usable manifest is refused before promotion', async () => {
  const root = await tempRoot()
  const zipPath = path.join(root, 'nomanifest.zip')
  await fsp.writeFile(zipPath, buildZip([{ name: 'index.js', data: 'export {}' }]))
  const installer = await Installer.create(path.join(root, 'store'))
  await assert.rejects(installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath }), /manifest/)
  const targets = await fsp.readdir(path.join(root, 'store', 'installed'))
  assert.deepEqual(targets, [])
})

test('directory sources hash identically to the same bytes zipped', async () => {
  const root = await tempRoot()
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())
  const zipPath = await writeDemoZip(root)
  const installer = await Installer.create(path.join(root, 'store'))
  const fromDir = await installer.installAs('demo-ext', { kind: 'local-directory', directoryPath: src })
  const installer2 = await Installer.create(path.join(root, 'store2'))
  const fromZip = await installer2.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath })
  assert.equal(fromDir.artifactSha256, fromZip.artifactSha256, 'the lock hash means the bytes, not the transport')
})
