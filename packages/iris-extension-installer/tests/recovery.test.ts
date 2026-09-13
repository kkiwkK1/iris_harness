import assert from 'node:assert/strict'
import { test } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Installer, SourceError } from '../src/index.ts'
import { recoverInstallations } from '../src/recovery.ts'
import { TransactionStore, type ExtensionInstallTransaction } from '../src/transaction.ts'
import { buildZip, demoFileMap, writeTree } from './fixtures/helpers.ts'

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'iris-installer-recovery-'))
}

async function writeDemoZip(root: string): Promise<string> {
  const zipPath = path.join(root, 'demo.zip')
  await fsp.writeFile(zipPath, buildZip([...demoFileMap()].map(([name, data]) => ({ name, data, unixMode: 0o100644 }))))
  return zipPath
}

const PHASE_LADDER = ['staged', 'validated', 'hashed', 'promoting'] as const

/** Builds a crashed transaction by hand: a real staging dir with a txn.json at the given phase. */
async function stageCrashedTxn(root: string, phase: ExtensionInstallTransaction['phase'], extensionId = 'demo-ext'): Promise<{ store: TransactionStore; txn: ExtensionInstallTransaction; storeRoot: string }> {
  const storeRoot = path.join(root, 'store')
  await fsp.mkdir(path.join(storeRoot, 'installed'), { recursive: true })
  const store = new TransactionStore(path.join(storeRoot, 'staging'), path.join(storeRoot, 'installed'))
  const txn = await store.begin({ extensionId, source: { kind: 'local-directory', directoryPath: path.join(root, 'unused-src') } })
  const index = phase === 'failed' ? 3 : PHASE_LADDER.indexOf(phase as (typeof PHASE_LADDER)[number])
  for (let i = 0; i <= Math.min(index, PHASE_LADDER.length - 1); i++) {
    const next = PHASE_LADDER[i]!
    await store.transition(txn, next, next === 'hashed' ? { artifactSha256: 'f'.repeat(64) } : {})
  }
  if (phase === 'failed') await store.transition(txn, 'failed')
  return { store, txn, storeRoot }
}

const PHASES_BEFORE_PROMOTION = ['downloading', 'staged', 'validated', 'hashed'] as const

for (const phase of PHASES_BEFORE_PROMOTION) {
  test(`crash during ${phase}: recovery rolls the transaction back and touches nothing installed`, async () => {
    const root = await tempRoot()
    const { txn, storeRoot } = await stageCrashedTxn(root, phase)
    const actions = await recoverInstallations(storeRoot)
    const mine = actions.filter(a => a.transactionId === txn.transactionId)
    assert.equal(mine.length, 1)
    assert.equal(mine[0]!.outcome, 'rolled-back')
    assert.equal(mine[0]!.extensionId, 'demo-ext')
    const stagingDirs = await fsp.readdir(path.join(storeRoot, 'staging'))
    assert.deepEqual(stagingDirs, [], 'staging is empty after recovery')
    const targets = await fsp.readdir(path.join(storeRoot, 'installed'))
    assert.deepEqual(targets, [], 'nothing was ever promoted, so the target root stays empty')
  })
}

test('crash after rename but before lock: recovery removes the lockless target and rolls back', async () => {
  const root = await tempRoot()
  const { txn, storeRoot } = await stageCrashedTxn(root, 'promoting')
  // Simulate the exact window: the material was renamed to the target, the
  // lock write never happened.
  await fsp.mkdir(txn.targetPath, { recursive: true })
  await writeTree(txn.targetPath, demoFileMap())
  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.transactionId === txn.transactionId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.outcome, 'rolled-back')
  const targets = await fsp.readdir(path.join(storeRoot, 'installed'))
  assert.deepEqual(targets, [], 'a lockless target is not an install; recovery removes it')
  const stagingDirs = await fsp.readdir(path.join(storeRoot, 'staging'))
  assert.deepEqual(stagingDirs, [])
})

test('crash after lock but before staging cleanup: recovery confirms the install, clears staging', async () => {
  const root = await tempRoot()
  const zipPath = await writeDemoZip(root)
  const storeRoot = path.join(root, 'store')
  const installer = await Installer.create(storeRoot)
  const result = await installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath })
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])

  // Now the second crash shape: txn.json still sitting in staging because the
  // process died between the installed transition and the staging delete. The
  // installed dir and lock are real; recovery must NOT undo a good install.
  await fsp.mkdir(path.join(storeRoot, 'installed'), { recursive: true })
  const store = new TransactionStore(path.join(storeRoot, 'staging'), path.join(storeRoot, 'installed'))
  const txn = await store.begin({ extensionId: 'demo-ext-2', source: { kind: 'local-archive', archivePath: zipPath } })
  await store.transition(txn, 'staged')
  await store.transition(txn, 'validated')
  await store.transition(txn, 'hashed', { artifactSha256: result.artifactSha256 })
  await store.transition(txn, 'promoting')
  await store.transition(txn, 'installed')
  // Give the fake txn a target that really exists with a valid lock? No: the
  // promoting branch checks the target; the installed branch does not need to.
  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.transactionId === txn.transactionId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.outcome, 'completed')
  const stillInstalled = await installer.readLock('demo-ext')
  assert.equal(stillInstalled?.artifactSha256, result.artifactSha256, 'a completed install is never undone by recovery')
})

test('crash where the promotion fully landed (lock valid) but the txn still says promoting: recovery completes it', async () => {
  const root = await tempRoot()
  const storeRoot = path.join(root, 'store')
  const { store, txn } = await stageCrashedTxn(root, 'promoting', 'demo-ext')
  void store
  // The real promotion result: a target directory with a valid lock.
  await fsp.mkdir(txn.targetPath, { recursive: true })
  await writeTree(txn.targetPath, demoFileMap())
  const { buildLock, writeLock } = await import('../src/lock.ts')
  await writeLock(txn.targetPath, buildLock({
    extensionId: 'demo-ext',
    source: { kind: 'local-directory', directoryPath: path.join(root, 'unused-src') },
    artifactSha256: 'a'.repeat(64),
  }))
  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.transactionId === txn.transactionId)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.outcome, 'completed')
  const targets = await fsp.readdir(path.join(storeRoot, 'installed'))
  assert.deepEqual(targets, ['demo-ext'], 'the fully-locked install survives recovery')
})

test('orphaned staging (no readable txn.json) is removed, never adopted', async () => {
  const root = await tempRoot()
  const storeRoot = path.join(root, 'store')
  const stagingDir = path.join(storeRoot, 'staging', 'some-crashed-txn')
  await fsp.mkdir(stagingDir, { recursive: true })
  await fsp.writeFile(path.join(stagingDir, 'txn.json'), '{not json at all')
  const actions = await recoverInstallations(storeRoot)
  assert.equal(actions[0]?.outcome, 'orphaned')
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])
})

test('a failed transaction\u2019s leftover staging is cleaned, marked already-failed', async () => {
  const root = await tempRoot()
  const { txn, storeRoot } = await stageCrashedTxn(root, 'failed')
  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.transactionId === txn.transactionId)
  assert.equal(mine[0]?.outcome, 'already-failed')
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])
})

test('a lockless target with no transaction is removed; a lockful target is left alone', async () => {
  const root = await tempRoot()
  const storeRoot = path.join(root, 'store')
  await fsp.mkdir(path.join(storeRoot, 'installed', 'ghost-ext'), { recursive: true })
  await fsp.writeFile(path.join(storeRoot, 'installed', 'ghost-ext', 'index.js'), 'not installed, just bytes')
  await fsp.mkdir(path.join(storeRoot, 'installed', 'real-ext'), { recursive: true })
  const { buildLock, writeLock } = await import('../src/lock.ts')
  await writeLock(path.join(storeRoot, 'installed', 'real-ext'), buildLock({
    extensionId: 'real-ext',
    source: { kind: 'local-directory', directoryPath: root },
    artifactSha256: 'b'.repeat(64),
  }))
  const actions = await recoverInstallations(storeRoot)
  const ghost = actions.find(a => a.extensionId === 'ghost-ext')
  assert.equal(ghost?.outcome, 'lockless-target')
  const targets = await fsp.readdir(path.join(storeRoot, 'installed'))
  assert.deepEqual(targets, ['real-ext'])
})

test('a stale claim (owner staging gone) is recovered so the extension is not wedged forever', async () => {
  const root = await tempRoot()
  const storeRoot = path.join(root, 'store')
  const claimsDir = path.join(storeRoot, 'claims')
  await fsp.mkdir(claimsDir, { recursive: true })
  await fsp.writeFile(path.join(claimsDir, 'demo-ext.lock'), JSON.stringify({ transactionId: 'gone-txn', acquiredAt: new Date().toISOString() }))
  const actions = await recoverInstallations(storeRoot)
  const stale = actions.find(a => a.outcome === 'stale-claim')
  assert.equal(stale?.extensionId, 'demo-ext')
  assert.deepEqual(await fsp.readdir(claimsDir), [])
})

test('after recovery cleans a crashed claim, the extension installs again', async () => {
  const root = await tempRoot()
  const zipPath = await writeDemoZip(root)
  const storeRoot = path.join(root, 'store')
  const claimsDir = path.join(storeRoot, 'claims')
  await fsp.mkdir(claimsDir, { recursive: true })
  await fsp.writeFile(path.join(claimsDir, 'demo-ext.lock'), JSON.stringify({ transactionId: 'dead-txn', acquiredAt: new Date().toISOString() }))
  await recoverInstallations(storeRoot)
  const installer = await Installer.create(storeRoot)
  const result = await installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath })
  assert.equal(result.extensionId, 'demo-ext')
})

test('an aborted download fails the transaction and leaves nothing behind', async () => {
  const root = await tempRoot()
  const zipPath = await writeDemoZip(root)
  const installer = await Installer.create(path.join(root, 'store'))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    installer.installAs('demo-ext', { kind: 'local-archive', archivePath: zipPath }, { signal: controller.signal }),
    SourceError,
  )
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [])
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [])
})
