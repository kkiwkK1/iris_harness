/**
 * Install transactions: the durable state machine the recovery scan reads.
 *
 * The record lives inside the staging directory it describes (staging/<txnId>/
 * txn.json), written atomically on every phase transition. That placement is
 * the crash story: anything the scan finds — a staging dir with a txn.json, a
 * staging dir without one, a target directory without a lock — has exactly
 * one interpretation, spelled out in recovery.ts.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ExtensionSource } from './source.ts'

export type InstallPhase =
  | 'downloading'
  | 'staged'
  | 'validated'
  | 'hashed'
  | 'promoting'
  | 'installed'
  | 'failed'

export interface ExtensionInstallTransaction {
  transactionId: string
  extensionId: string
  source: ExtensionSource
  expectedCommit?: string
  stagingPath: string
  targetPath: string
  phase: InstallPhase
  artifactSha256?: string
  startedAt: string
  updatedAt: string
}

export const TXN_FILE_NAME = 'txn.json'

const TRANSITIONS: Record<InstallPhase, InstallPhase[]> = {
  downloading: ['staged', 'failed'],
  staged: ['validated', 'failed'],
  validated: ['hashed', 'failed'],
  hashed: ['promoting', 'failed'],
  promoting: ['installed', 'failed', 'promoting'],
  installed: [],
  failed: [],
}

export class InvalidTransitionError extends Error {
  readonly from: InstallPhase
  readonly to: InstallPhase
  constructor(from: InstallPhase, to: InstallPhase) {
    super(`illegal transaction phase transition ${from} -> ${to}`)
    this.from = from
    this.to = to
  }
}

export class TransactionStore {
  readonly stagingRoot: string
  readonly targetsRoot: string
  constructor(stagingRoot: string, targetsRoot: string) {
    this.stagingRoot = stagingRoot
    this.targetsRoot = targetsRoot
  }

  stagingPath(transactionId: string): string {
    return path.join(this.stagingRoot, transactionId)
  }

  targetPath(extensionId: string): string {
    return path.join(this.targetsRoot, extensionId)
  }

  async begin(input: {
    extensionId: string
    source: ExtensionSource
    expectedCommit?: string
  }): Promise<ExtensionInstallTransaction> {
    const transactionId = randomUUID()
    const stagingPath = this.stagingPath(transactionId)
    await fsp.mkdir(path.join(stagingPath, 'material'), { recursive: true })
    const now = new Date().toISOString()
    const txn: ExtensionInstallTransaction = {
      transactionId,
      extensionId: input.extensionId,
      source: input.source,
      ...(input.expectedCommit !== undefined ? { expectedCommit: input.expectedCommit } : {}),
      stagingPath,
      targetPath: this.targetPath(input.extensionId),
      phase: 'downloading',
      startedAt: now,
      updatedAt: now,
    }
    await this.write(txn)
    return txn
  }

  async transition(txn: ExtensionInstallPhase, to: InstallPhase, patch: Partial<ExtensionInstallTransaction> = {}): Promise<ExtensionInstallPhase> {
    if (!TRANSITIONS[txn.phase].includes(to)) {
      throw new InvalidTransitionError(txn.phase, to)
    }
    const next: ExtensionInstallPhase = {
      ...txn,
      ...patch,
      phase: to,
      updatedAt: new Date().toISOString(),
    }
    await this.write(next)
    Object.assign(txn, next)
    return txn
  }

  /**
   * Point a staged transaction at the id it turned out to be for.
   *
   * A SillyTavern extension's id is derived before anything is fetched (it is
   * the slug of a `display_name` the caller already read), so `begin` has
   * always been told the id up front. A system-plugin package does not work
   * that way: its id lives in the `iris.plugin` block *inside* the tree, and
   * the tree only exists after materialization. So such a transaction begins
   * under a provisional id and learns the real one here, before it may leave
   * the `hashed` phase.
   *
   * Refused in any later phase: the claim, the target and the lock are all
   * keyed by the id, and a record that renamed itself mid-promotion would be
   * one recovery cannot interpret — `deriveTargetPath`
   * (`recovery.ts:60`) re-derives the target from `extensionId` and refuses a
   * record whose embedded `targetPath` disagrees, which is exactly the
   * inconsistency a late rename would create.
   */
  async retarget(txn: ExtensionInstallPhase, extensionId: string): Promise<ExtensionInstallPhase> {
    if (txn.phase !== 'downloading' && txn.phase !== 'staged' && txn.phase !== 'validated' && txn.phase !== 'hashed') {
      throw new Error(
        `a transaction may only learn its extension id before promotion, not in phase ${txn.phase}`,
      )
    }
    const next: ExtensionInstallPhase = {
      ...txn,
      extensionId,
      targetPath: this.targetPath(extensionId),
      updatedAt: new Date().toISOString(),
    }
    await this.write(next)
    Object.assign(txn, next)
    return txn
  }

  private async write(txn: ExtensionInstallTransaction): Promise<void> {
    await atomicWriteJson(path.join(txn.stagingPath, TXN_FILE_NAME), txn)
  }

  async read(stagingDir: string): Promise<ExtensionInstallTransaction | null> {
    let raw: string
    try {
      raw = await fsp.readFile(path.join(stagingDir, TXN_FILE_NAME), 'utf8')
    } catch {
      return null
    }
    try {
      const txn = JSON.parse(raw) as ExtensionInstallTransaction
      if (typeof txn.phase !== 'string' || !(txn.phase in TRANSITIONS)) return null
      return txn
    } catch {
      return null
    }
  }
}

// Alias name for readability at call sites: transitions mutate the live record.
export type ExtensionInstallPhase = ExtensionInstallTransaction

/**
 * Writes JSON so a reader never sees a torn file: temp file in the same
 * directory, flushed, then renamed. On Windows `rename` cannot clobber, so
 * the existing file is unlinked first — the window between the two calls is
 * covered by recovery (a missing or torn txn.json reads as null and the scan
 * quarantines the staging dir), never by luck.
 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  const body = JSON.stringify(value, null, 2) + '\n'
  const handle = await fsp.open(temp, 'wx')
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    fs.renameSync(temp, filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EEXIST') {
      await fsp.rm(filePath, { force: true })
      fs.renameSync(temp, filePath)
      return
    }
    await fsp.rm(temp, { force: true })
    throw err
  }
}
