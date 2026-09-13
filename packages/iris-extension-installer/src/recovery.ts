/**
 * Crash recovery. The scan reads only durable evidence — staging dirs and
 * their txn.json, targets and their lock.json, claims and their owners — and
 * every case has one interpretation:
 *
 * | evidence                                        | action                          |
 * | ----------------------------------------------- | ------------------------------- |
 * | staging dir, txn phase downloading..hashed      | delete staging, rolled-back     |
 * | staging dir, txn phase failed                   | delete staging, already-failed  |
 * | staging dir, txn phase installed (leftover)     | delete staging, completed       |
 * | staging dir, txn phase promoting, lock valid    | delete staging, completed       |
 * | staging dir, txn promoting, no/invalid lock     | delete target + staging, rolled-back |
 * | staging dir without a readable txn.json         | delete staging, orphaned        |
 * | target dir without a valid lock.json            | delete target, lockless-target  |
 * | claim whose owner txn is gone/terminal          | delete claim, stale-claim       |
 *
 * Nothing is ever auto-enabled: recovery only removes or completes; the
 * "installed" state it may confirm is still enabled:false in the lock.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { parseLock } from './lock.ts'
import { createLayout, type InstallerLayout } from './staging.ts'

export type RecoveryOutcome = 'completed' | 'rolled-back' | 'already-failed' | 'orphaned' | 'lockless-target' | 'stale-claim'

export interface RecoveryAction {
  transactionId?: string
  extensionId?: string
  path: string
  outcome: RecoveryOutcome
}

export async function recoverInstallations(root: string): Promise<RecoveryAction[]> {
  const layout = createLayout(root)
  const actions: RecoveryAction[] = []
  await recoverStaging(layout, actions)
  await recoverTargets(layout, actions)
  await recoverClaims(layout, actions)
  return actions
}

async function recoverStaging(layout: InstallerLayout, actions: RecoveryAction[]): Promise<void> {
  let dirs: string[]
  try {
    dirs = await fsp.readdir(layout.stagingRoot)
  } catch {
    return
  }
  for (const dir of dirs.sort()) {
    const stagingPath = path.join(layout.stagingRoot, dir)
    const txn = await layout.store.read(stagingPath)
    if (!txn) {
      await fsp.rm(stagingPath, { recursive: true, force: true })
      actions.push({ path: stagingPath, outcome: 'orphaned' })
      continue
    }
    switch (txn.phase) {
      case 'downloading':
      case 'staged':
      case 'validated':
      case 'hashed': {
        // The install never reached promotion: the target (if any) was never
        // created by this transaction, so only staging needs to go.
        await fsp.rm(stagingPath, { recursive: true, force: true })
        actions.push({ transactionId: txn.transactionId, extensionId: txn.extensionId, path: stagingPath, outcome: 'rolled-back' })
        break
      }
      case 'promoting': {
        // The two promotion sub-steps are rename-then-lock. Decide by the
        // target's own evidence, not the txn's claim of where it got to.
        const lock = await parseLock(txn.targetPath).catch(() => null)
        if (lock && lock.extensionId === txn.extensionId) {
          // Rename happened and the lock landed: the install is complete.
          await fsp.rm(stagingPath, { recursive: true, force: true })
          actions.push({ transactionId: txn.transactionId, extensionId: txn.extensionId, path: txn.targetPath, outcome: 'completed' })
        } else {
          // Lock missing or foreign: the target is not an installed extension.
          // It may be the renamed material (lock not yet written) — remove it.
          await fsp.rm(txn.targetPath, { recursive: true, force: true })
          await fsp.rm(stagingPath, { recursive: true, force: true })
          actions.push({ transactionId: txn.transactionId, extensionId: txn.extensionId, path: stagingPath, outcome: 'rolled-back' })
        }
        break
      }
      case 'installed': {
        await fsp.rm(stagingPath, { recursive: true, force: true })
        actions.push({ transactionId: txn.transactionId, extensionId: txn.extensionId, path: stagingPath, outcome: 'completed' })
        break
      }
      case 'failed': {
        await fsp.rm(stagingPath, { recursive: true, force: true })
        actions.push({ transactionId: txn.transactionId, extensionId: txn.extensionId, path: stagingPath, outcome: 'already-failed' })
        break
      }
    }
  }
}

async function recoverTargets(layout: InstallerLayout, actions: RecoveryAction[]): Promise<void> {
  let dirs: string[]
  try {
    dirs = await fsp.readdir(layout.targetsRoot)
  } catch {
    return
  }
  for (const dir of dirs.sort()) {
    const targetPath = path.join(layout.targetsRoot, dir)
    const lock = await parseLock(targetPath).catch(() => null)
    if (!lock) {
      // A directory the installer owns without a valid lock was never
      // installed. It must not be served, listed, or enabled — remove it.
      await fsp.rm(targetPath, { recursive: true, force: true })
      actions.push({ extensionId: dir, path: targetPath, outcome: 'lockless-target' })
    }
  }
}

async function recoverClaims(layout: InstallerLayout, actions: RecoveryAction[]): Promise<void> {
  let files: string[]
  try {
    files = await fsp.readdir(layout.claimsRoot)
  } catch {
    return
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.lock')) continue
    const claimPath = path.join(layout.claimsRoot, file)
    let owner: string | null = null
    try {
      owner = (JSON.parse(await fsp.readFile(claimPath, 'utf8')) as { transactionId?: string }).transactionId ?? null
    } catch {
      owner = null
    }
    const alive = owner
      ? await layout.store.read(layout.store.stagingPath(owner)).then(txn => txn !== null && txn.phase !== 'installed' && txn.phase !== 'failed').catch(() => false)
      : false
    if (!alive) {
      await fsp.rm(claimPath, { force: true })
      actions.push({ ...(owner !== null ? { transactionId: owner } : {}), extensionId: file.slice(0, -'.lock'.length), path: claimPath, outcome: 'stale-claim' })
    }
  }
}
