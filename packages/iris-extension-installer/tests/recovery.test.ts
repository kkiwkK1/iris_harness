import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { Installer, SourceError } from '../src/index.ts'
import { recoverInstallations } from '../src/recovery.ts'
import { TransactionStore, type ExtensionInstallTransaction } from '../src/transaction.ts'
import { buildZip, demoFileMap, writeTree } from './fixtures/helpers.ts'
import { tempDir } from '../../iris-app-service/tests/support/temp-dir.ts'

async function tempRoot(t: TestContext): Promise<string> {
  return await tempDir(t, 'iris-installer-recovery-')
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
  test(`crash during ${phase}: recovery rolls the transaction back and touches nothing installed`, async (t: TestContext) => {
    const root = await tempRoot(t)
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

test('crash after rename but before lock: recovery removes the lockless target and rolls back', async (t: TestContext) => {
  const root = await tempRoot(t)
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

test('crash after lock but before staging cleanup: recovery confirms the install, clears staging', async (t: TestContext) => {
  const root = await tempRoot(t)
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

test('crash where the promotion fully landed (lock valid) but the txn still says promoting: recovery completes it', async (t: TestContext) => {
  const root = await tempRoot(t)
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

test('orphaned staging (no readable txn.json) is removed, never adopted', async (t: TestContext) => {
  const root = await tempRoot(t)
  const storeRoot = path.join(root, 'store')
  const stagingDir = path.join(storeRoot, 'staging', 'some-crashed-txn')
  await fsp.mkdir(stagingDir, { recursive: true })
  await fsp.writeFile(path.join(stagingDir, 'txn.json'), '{not json at all')
  const actions = await recoverInstallations(storeRoot)
  assert.equal(actions[0]?.outcome, 'orphaned')
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])
})

test('a failed transaction\u2019s leftover staging is cleaned, marked already-failed', async (t: TestContext) => {
  const root = await tempRoot(t)
  const { txn, storeRoot } = await stageCrashedTxn(root, 'failed')
  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.transactionId === txn.transactionId)
  assert.equal(mine[0]?.outcome, 'already-failed')
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])
})

test('a lockless target with no transaction is removed; a lockful target is left alone', async (t: TestContext) => {
  const root = await tempRoot(t)
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

test('a stale claim (owner staging gone) is recovered so the extension is not wedged forever', async (t: TestContext) => {
  const root = await tempRoot(t)
  const storeRoot = path.join(root, 'store')
  const claimsDir = path.join(storeRoot, 'claims')
  await fsp.mkdir(claimsDir, { recursive: true })
  await fsp.writeFile(path.join(claimsDir, 'demo-ext.lock'), JSON.stringify({ transactionId: 'gone-txn', acquiredAt: new Date().toISOString() }))
  const actions = await recoverInstallations(storeRoot)
  const stale = actions.find(a => a.outcome === 'stale-claim')
  assert.equal(stale?.extensionId, 'demo-ext')
  assert.deepEqual(await fsp.readdir(claimsDir), [])
})

test('after recovery cleans a crashed claim, the extension installs again', async (t: TestContext) => {
  const root = await tempRoot(t)
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

test('an aborted download fails the transaction and leaves nothing behind', async (t: TestContext) => {
  const root = await tempRoot(t)
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

// --- 恶意 txn.json 夹具：恢复绝不跟随事务记录里的路径 ------------------------
//
// txn.json 是磁盘上可被篡改的输入。一个伪造的 promoting 事务把 targetPath 指
// 向安装根之外的目录，而恢复扫描恰好会删除"无 lock 的目标"——如果恢复信任记
// 录里的路径，这就是一个删除任意目录的原始武器。恢复必须只用 layout + 合法
// extensionId 重新推导的路径。

/** 手写一个伪造（或被篡改）的 promoting 事务。 */
async function plantMaliciousTxn(options: {
  storeRoot: string
  extensionId: string
  targetPath: string
  stagingPath: string
  transactionId?: string
}): Promise<string> {
  const txnDir = path.join(options.storeRoot, 'staging', options.transactionId ?? 'forged-txn-id')
  await fsp.mkdir(path.join(txnDir, 'material', 'content'), { recursive: true })
  const txn = {
    transactionId: options.transactionId ?? 'forged-txn-id',
    extensionId: options.extensionId,
    source: { kind: 'local-directory', directoryPath: 'C:\does-not-exist' },
    stagingPath: options.stagingPath,
    targetPath: options.targetPath,
    phase: 'promoting',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await fsp.writeFile(path.join(txnDir, 'txn.json'), JSON.stringify(txn, null, 2))
  return txnDir
}

test('a forged txn.json pointing targetPath outside the install root: the sentinel survives, only staging is cleaned', async (t: TestContext) => {
  const root = await tempRoot(t)
  const storeRoot = path.join(root, 'store')
  await fsp.mkdir(path.join(storeRoot, 'installed'), { recursive: true })

  // The victim lives outside the install root and holds a sentinel file.
  const victim = path.join(root, 'outside-victim')
  const sentinel = path.join(victim, 'sentinel.txt')
  await fsp.mkdir(victim, { recursive: true })
  await fsp.writeFile(sentinel, 'must survive recovery')

  const forgedDir = await plantMaliciousTxn({
    storeRoot,
    extensionId: 'demo-ext',
    stagingPath: path.join(root, 'also-outside-staging'),
    targetPath: victim, // the lie: "the material was renamed here"
  })

  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.path === forgedDir)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.outcome, 'untrusted-transaction', 'the forged embedded paths disagree with the layout, so only staging is quarantined')
  assert.equal(mine[0]!.extensionId, 'demo-ext')

  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'must survive recovery', 'the sentinel must exist after recovery — the root-外的目录绝不能被跟随或删除')
  const victimEntries = await fsp.readdir(victim)
  assert.deepEqual(victimEntries, ['sentinel.txt'])
  assert.ok(!await fsp.stat(path.join(root, 'also-outside-staging')).then(() => true).catch(() => false), 'txn.stagingPath 之外的伪造 staging 指针也不被使用')

  const stagingDirs = await fsp.readdir(path.join(storeRoot, 'staging'))
  assert.deepEqual(stagingDirs, [], 'only the real staging dir is removed')
  const targets = await fsp.readdir(path.join(storeRoot, 'installed'))
  assert.deepEqual(targets, [], 'and the derived target (installed/demo-ext) never existed, so nothing else was touched')
})

test('a forged txn.json with an invalid extensionId is quarantined, not followed', async (t: TestContext) => {
  const root = await tempRoot(t)
  const storeRoot = path.join(root, 'store')
  await fsp.mkdir(path.join(storeRoot, 'installed'), { recursive: true })

  const victim = path.join(root, 'outside-victim-2')
  const sentinel = path.join(victim, 'sentinel.txt')
  await fsp.mkdir(victim, { recursive: true })
  await fsp.writeFile(sentinel, 'must survive')

  const forgedDir = await plantMaliciousTxn({
    storeRoot,
    extensionId: '../evil', // 穿越 id：不能作为目录名，更不能派生任何目标
    stagingPath: path.join(storeRoot, 'staging', 'forged-txn-id'),
    targetPath: victim,
  })

  const actions = await recoverInstallations(storeRoot)
  const mine = actions.filter(a => a.path === forgedDir)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.outcome, 'untrusted-transaction', 'invalid id: recovery refuses to derive any target from it')
  assert.equal(await fsp.stat(sentinel).then(() => true).catch(() => false), true)
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])
})

test('a forged promoting txn cannot have a lock-外目录 confirmed as an install', async (t: TestContext) => {
  const root = await tempRoot(t)
  const storeRoot = path.join(root, 'store')
  await fsp.mkdir(path.join(storeRoot, 'installed'), { recursive: true })

  // The attacker plants a valid-looking lock OUTSIDE the root and points the
  // forged txn's targetPath at it, hoping recovery confirms "completed" and
  // blesses a directory the installer never created.
  const victim = path.join(root, 'outside-plantation')
  await fsp.mkdir(victim, { recursive: true })
  const { buildLock, writeLock } = await import('../src/lock.ts')
  await writeLock(victim, buildLock({
    extensionId: 'demo-ext',
    source: { kind: 'local-directory', directoryPath: root },
    artifactSha256: 'c'.repeat(64),
  }))

  await plantMaliciousTxn({
    storeRoot,
    extensionId: 'demo-ext',
    stagingPath: path.join(storeRoot, 'staging', 'forged-txn-id'),
    targetPath: victim,
  })

  const actions = await recoverInstallations(storeRoot)
  const promoting = actions.find(a => a.outcome === 'completed')
  assert.equal(promoting, undefined, 'confirmation happens only at the layout-derived target, never the txn\u2019s pointer')
  assert.equal(actions.find(a => a.extensionId === 'demo-ext')?.outcome, 'untrusted-transaction')
  const derived = path.join(storeRoot, 'installed', 'demo-ext')
  assert.equal(await fsp.stat(derived).then(() => true).catch(() => false), false, 'the derived target has no lock, so nothing was completed there either')
  const lockSurvives = await fsp.stat(path.join(victim, 'lock.json')).then(() => true).catch(() => false)
  assert.equal(lockSurvives, true, 'the planted outside directory is left exactly as it was — recovery never follows the pointer')
  assert.deepEqual(await fsp.readdir(path.join(storeRoot, 'staging')), [])
})
