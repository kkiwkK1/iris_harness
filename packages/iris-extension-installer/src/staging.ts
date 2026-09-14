/**
 * Staging-area layout and the per-extension install claim.
 *
 * Layout under the installer root:
 *   staging/<txnId>/txn.json + material/   — in-flight transactions
 *   claims/<extensionId>.lock              — O_EXCL install mutex
 *   installed/<extensionId>/lock.json      — promoted, complete installs
 *
 * The claim is what makes two concurrent installs of the same extension a
 * refusal instead of a race: the second installer finds the claim alive
 * (its owner's staging dir still exists and its phase is not terminal) and
 * fails fast naming the owner. A claim whose owner is gone — crashed before
 * cleanup — is stale by evidence and re-acquired.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { TransactionStore, type ExtensionInstallTransaction } from './transaction.ts'

export interface InstallerLayout {
  root: string
  stagingRoot: string
  claimsRoot: string
  targetsRoot: string
  store: TransactionStore
}

export function createLayout(root: string): InstallerLayout {
  const stagingRoot = path.join(root, 'staging')
  const claimsRoot = path.join(root, 'claims')
  const targetsRoot = path.join(root, 'installed')
  return {
    root,
    stagingRoot,
    claimsRoot,
    targetsRoot,
    store: new TransactionStore(stagingRoot, targetsRoot),
  }
}

export async function ensureLayout(layout: InstallerLayout): Promise<void> {
  await Promise.all([
    fsp.mkdir(layout.stagingRoot, { recursive: true }),
    fsp.mkdir(layout.claimsRoot, { recursive: true }),
    fsp.mkdir(layout.targetsRoot, { recursive: true }),
  ])
}

const TERMINAL_PHASES = new Set(['installed', 'failed'])

export class InstallClaimBusyError extends Error {
  readonly extensionId: string
  readonly ownerTransactionId: string
  constructor(extensionId: string, ownerTransactionId: string) {
    super(
      `extension ${extensionId} is already being installed by transaction ${ownerTransactionId} — concurrent install of one extension is refused`,
    )
    this.extensionId = extensionId
    this.ownerTransactionId = ownerTransactionId
  }
}

/** Acquires the per-extension claim or throws naming the live owner. */
export async function acquireClaim(
  layout: InstallerLayout,
  extensionId: string,
  transaction: ExtensionInstallTransaction,
): Promise<void> {
  await fsp.mkdir(layout.claimsRoot, { recursive: true })
  const claimPath = path.join(layout.claimsRoot, `${extensionId}.lock`)
  const claim = JSON.stringify({ transactionId: transaction.transactionId, acquiredAt: new Date().toISOString() })
  let handle: fs.promises.FileHandle
  try {
    handle = await fsp.open(claimPath, 'wx')
  } catch {
    const owner = await readClaim(layout, extensionId)
    if (owner && (await claimOwnerAlive(layout, owner.transactionId))) {
      throw new InstallClaimBusyError(extensionId, owner.transactionId)
    }
    // No live owner: the claim is stale (crashed install, cleaned staging).
    // Take it over rather than wedging the extension forever.
    await fsp.rm(claimPath, { force: true })
    handle = await fsp.open(claimPath, 'wx')
  }
  try {
    await handle.writeFile(claim)
  } finally {
    await handle.close()
  }
}

export async function releaseClaim(layout: InstallerLayout, extensionId: string, transactionId: string): Promise<void> {
  const owner = await readClaim(layout, extensionId)
  if (owner?.transactionId === transactionId) {
    await fsp.rm(path.join(layout.claimsRoot, `${extensionId}.lock`), { force: true })
  }
}

async function readClaim(layout: InstallerLayout, extensionId: string): Promise<{ transactionId: string } | null> {
  try {
    const raw = await fsp.readFile(path.join(layout.claimsRoot, `${extensionId}.lock`), 'utf8')
    const parsed = JSON.parse(raw) as { transactionId?: unknown }
    return typeof parsed.transactionId === 'string' ? { transactionId: parsed.transactionId } : null
  } catch {
    return null
  }
}

async function claimOwnerAlive(layout: InstallerLayout, transactionId: string): Promise<boolean> {
  const txn = await layout.store.read(layout.store.stagingPath(transactionId))
  return txn !== null && !TERMINAL_PHASES.has(txn.phase)
}
