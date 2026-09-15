/**
 * The installer orchestrator: source -> staging -> validation -> hash ->
 * atomic promotion -> installed (and disabled).
 *
 * Invariants this file exists to keep:
 *  - All writes land in staging first; the only thing that ever touches the
 *    installed tree is one rename plus the lock write.
 *  - The lock is written after the rename and marks completeness; a target
 *    directory without a lock is not an install (recovery removes it).
 *  - Nothing from the artifact executes here — not install scripts, not build
 *    scripts, not git hooks, nothing. The installer never sets enabled:true;
 *    installation and activation are different systems' decisions.
 *  - Failure at any phase leaves the target untouched (or, during promoting,
 *    recoverable to untouched by the recovery scan).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { auditContainment, extractZipSafely } from './archive.ts'
import { ST_EXTENSION_ARTIFACT_CONTRACT, type ArtifactContract } from './artifact-contract.ts'
import { hashTree, type TreeHash } from './hash.ts'
import { buildLock, isValidExtensionId, LOCK_FILE_NAME, parseLock, writeLock } from './lock.ts'
import { recoverInstallations, type RecoveryAction } from './recovery.ts'
import { acquireClaim, createLayout, ensureLayout, InstallClaimBusyError, releaseClaim, type InstallerLayout } from './staging.ts'
import { materializeSource, SourceError, validateExtensionSource, type ExtensionSource, type SourceOptions } from './source.ts'
import { atomicWriteJson, type ExtensionInstallTransaction } from './transaction.ts'

export type { InstalledExtensionLock } from './lock.ts'

export interface InstallOptions {
  expectedCommit?: string
  maxArchiveBytes?: number
  allowLocalGit?: boolean
  signal?: AbortSignal
  onPhase?: (phase: string, info: { transactionId: string; artifactSha256?: string }) => void
  /**
   * What the staged tree must contain to be promotable. Defaults to the
   * SillyTavern extension format, which is what every caller of this method
   * meant before the gate became injectable — see `artifact-contract.ts` for
   * why the default is a compatibility statement rather than a coupling.
   */
  artifactContract?: ArtifactContract
}

export interface StageOptions extends InstallOptions {
  /**
   * The id the tree will be promoted under, when the caller already knows it.
   *
   * Absent means "the tree will tell us": the transaction begins under
   * `PROVISIONAL_EXTENSION_ID` and is retargeted in `promote`.
   */
  extensionId?: string
}

/**
 * The id a transaction carries while it is still nameless.
 *
 * It is a *valid* extension id on purpose, so that a crash between `begin` and
 * `promote` reads to the recovery scan as an ordinary rolled-back staging
 * directory rather than as an untrusted record — `deriveTargetPath`
 * (`recovery.ts:60`) returns null for a malformed id and reports
 * `untrusted-transaction`, which is a louder outcome than the facts deserve.
 * Nothing is ever promoted under this name: `promote` retargets first, and a
 * target directory by this name would have no lock and be removed as a
 * lockless target.
 */
export const PROVISIONAL_EXTENSION_ID = 'pending-install'

/** A staged, validated, hashed tree parked at the `hashed` phase. */
export interface StagedInstall {
  transactionId: string
  stagingPath: string
  /** Where the tree lives inside staging, until `promote` renames it away. */
  contentPath: string
  source: ExtensionSource
  tree: TreeHash
  /** git only: the commit `rev-parse HEAD` proved, which equals the pin. */
  resolvedCommit?: string
  /**
   * The live transaction record. Held rather than re-read so a promotion
   * compares against the phase this process actually drove, not against a file
   * another process could have rewritten underneath it.
   */
  txn: ExtensionInstallTransaction
}

export interface InstallResult {
  transactionId: string
  extensionId: string
  targetPath: string
  artifactSha256: string
  resolvedCommit?: string
  lock: import('./lock.ts').InstalledExtensionLock
}

export class Installer {
  readonly layout: InstallerLayout
  private constructor(layout: InstallerLayout) {
    this.layout = layout
  }

  static async create(root: string): Promise<Installer> {
    const layout = createLayout(root)
    await ensureLayout(layout)
    return new Installer(layout)
  }

  recover(): Promise<RecoveryAction[]> {
    return recoverInstallations(this.layout.root)
  }

  async readLock(extensionId: string): Promise<import('./lock.ts').InstalledExtensionLock | null> {
    return parseLock(this.layout.store.targetPath(extensionId))
  }

  /**
   * Runs one install transaction to completion. Throws on any refusal or
   * interruption; the transaction is marked failed and staging removed before
   * the error propagates, so a throw never leaves a half-open claim behind.
   */
  async installAs(extensionId: string, source: ExtensionSource, options: InstallOptions = {}): Promise<InstallResult> {
    validateExtensionSource(source, options)
    if (!isValidExtensionId(extensionId)) {
      throw new SourceError(`extensionId ${JSON.stringify(extensionId)} is not a [a-z0-9][a-z0-9._-]{0,63} slug — the id becomes a directory name, so it is validated before it ever touches the filesystem`, 'bad-extension-id')
    }
    if (options.expectedCommit !== undefined && source.kind === 'git' && options.expectedCommit !== source.commit) {
      throw new SourceError('expectedCommit disagrees with the source\u2019s pinned commit — refusing to install under two opinions of what was analyzed', 'commit-mismatch')
    }
    const existing = await this.readLock(extensionId)
    if (existing) {
      throw new SourceError(`extension ${extensionId} is already installed (artifact ${existing.artifactSha256}) — updates go through the update transaction, not a silent overwrite`, 'already-installed')
    }
    const staged = await this.stage(source, { ...options, extensionId })
    return await this.promote(staged, extensionId, options)
  }

  /**
   * The first half: materialize, validate, hash, and stop at `hashed`.
   *
   * Nothing from the artifact has executed and nothing outside staging has
   * been touched when this resolves, so the returned handle is safe to hold
   * across a user's decision. A handle that is never promoted must be handed
   * to `discard`; leaving it for `recoverInstallations` works, but that scan
   * is the crash mechanism and should not become a normal exit path.
   *
   * `options.extensionId` is optional because a system-plugin package's id
   * lives inside the tree this call is fetching (`iris.plugin.id`), and there
   * is no honest way to know it before the bytes are here. When it is absent
   * the transaction begins under a provisional id and `promote` retargets the
   * record before it takes a claim.
   */
  async stage(source: ExtensionSource, options: StageOptions = {}): Promise<StagedInstall> {
    validateExtensionSource(source, options)
    const store = this.layout.store
    const txn = await store.begin({
      extensionId: options.extensionId ?? PROVISIONAL_EXTENSION_ID,
      source,
      ...(options.expectedCommit !== undefined ? { expectedCommit: options.expectedCommit } : {}),
    })
    const material = path.join(txn.stagingPath, 'material')
    const content = path.join(material, 'content')
    const notify = (info: { artifactSha256?: string } = {}): void => {
      options.onPhase?.(txn.phase, { transactionId: txn.transactionId, ...info })
    }
    try {
      // Phase: downloading — bytes land in staging, nowhere else. Directory
      // and git sources materialize directly into content/; an archive's
      // bytes land in content/ first and are unpacked beside themselves in
      // the staged phase, then the downloaded copy is deleted.
      const outcome = await materializeSource(source, content, {
        ...(options.allowLocalGit !== undefined ? { allowLocalGit: options.allowLocalGit } : {}),
        ...(options.maxArchiveBytes !== undefined ? { maxArchiveBytes: options.maxArchiveBytes } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      if ('failure' in outcome) throw outcome.failure
      await store.transition(txn, 'staged')
      notify()

      // Phase: staged -> validated — unpack, guards, git metadata removal,
      // artifact contract. The contract gate is source-blind: a git checkout
      // is held to exactly the same contract as an unpacked archive or a
      // copied directory, because the contract is with the artifact, not the
      // transport. Which contract is the caller's to choose; that it runs
      // here, on every transport, is not.
      if (outcome.stagedArchive !== undefined) {
        await extractZipSafely(outcome.stagedArchive, content)
        await fsp.rm(outcome.stagedArchive, { force: true })
      }
      if (source.kind === 'git') {
        // Remove the clone's metadata before anything reads the tree: .git is
        // transport baggage, not artifact content. Left in, it would pollute
        // the artifact hash with clone-local data (its own commit objects,
        // timestamps, config), so two machines installing the same commit
        // could lock different sha256s for identical working trees — and it
        // must never be promoted into the installed tree.
        await fsp.rm(path.join(content, '.git'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
      await (options.artifactContract ?? ST_EXTENSION_ARTIFACT_CONTRACT).validate(content)
      await auditContainment(content)
      await store.transition(txn, 'validated')
      notify()

      // Phase: validated -> hashed.
      const tree = await hashTree(content)
      await store.transition(txn, 'hashed', { artifactSha256: tree.sha256 })
      notify({ artifactSha256: tree.sha256 })
      return {
        transactionId: txn.transactionId,
        stagingPath: txn.stagingPath,
        contentPath: content,
        source,
        tree,
        ...(outcome.resolvedCommit !== undefined ? { resolvedCommit: outcome.resolvedCommit } : {}),
        txn,
      }
    } catch (err) {
      await this.abandon(txn)
      throw err
    }
  }

  /**
   * The second half: claim, rename, lock, `installed`.
   *
   * The only thing this knows about the tree is what `stage` already wrote
   * into the transaction record and the staged bytes themselves. It does not
   * re-fetch, re-validate or re-hash: a promotion that re-derived its own
   * facts could promote bytes nobody was shown, which is precisely what the
   * two-step handshake exists to prevent.
   */
  async promote(staged: StagedInstall, extensionId: string, options: InstallOptions = {}): Promise<InstallResult> {
    const store = this.layout.store
    const txn = staged.txn
    const notify = (info: { artifactSha256?: string } = {}): void => {
      options.onPhase?.(txn.phase, { transactionId: txn.transactionId, ...info })
    }
    try {
      if (!isValidExtensionId(extensionId)) {
        throw new SourceError(`extensionId ${JSON.stringify(extensionId)} is not a [a-z0-9][a-z0-9._-]{0,63} slug — the id becomes a directory name, so it is validated before it ever touches the filesystem`, 'bad-extension-id')
      }
      if (txn.phase !== 'hashed') {
        throw new SourceError(`transaction ${txn.transactionId} is in phase ${txn.phase}, not hashed — only a staged, hashed tree may be promoted`, 'not-staged')
      }
      const existing = await this.readLock(extensionId)
      if (existing) {
        throw new SourceError(`extension ${extensionId} is already installed (artifact ${existing.artifactSha256}) — updates go through the update transaction, not a silent overwrite`, 'already-installed')
      }
      if (txn.extensionId !== extensionId) await store.retarget(txn, extensionId)

      // Phase: hashed -> promoting. The claim is taken only now, after the
      // expensive work: two concurrent installs both stage, but only one ever
      // reaches the target, and the loser never re-promotes over it.
      await acquireClaim(this.layout, extensionId, txn)
      let promoted = false
      let locked = false
      try {
        await store.transition(txn, 'promoting')
        notify()
        const target = txn.targetPath
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.rename(staged.contentPath, target) // atomic on-volume move; same root
        promoted = true
        const lock = buildLock({
          extensionId,
          source: staged.source,
          ...(staged.resolvedCommit !== undefined ? { resolvedCommit: staged.resolvedCommit } : {}),
          artifactSha256: staged.tree.sha256,
        })
        await writeLock(target, lock)
        locked = true
        await store.transition(txn, 'installed')
        await fsp.rm(txn.stagingPath, { recursive: true, force: true })
        notify({ artifactSha256: staged.tree.sha256 })
        return {
          transactionId: txn.transactionId,
          extensionId,
          targetPath: target,
          artifactSha256: staged.tree.sha256,
          ...(staged.resolvedCommit !== undefined ? { resolvedCommit: staged.resolvedCommit } : {}),
          lock,
        }
      } finally {
        // Normal control flow reaches here only via the throws above; both
        // flags tell the catch below exactly how far promotion got.
        if (!(promoted && locked)) {
          await this.recordFailure(txn, promoted, locked)
        }
        await releaseClaim(this.layout, extensionId, txn.transactionId)
      }
    } catch (err) {
      await this.abandon(txn)
      throw err
    }
  }

  /**
   * Throw away a staged tree nobody consented to.
   *
   * Idempotent and non-throwing: a cancel that failed would leave the caller
   * holding a token it cannot retire, and whatever this could not remove the
   * recovery scan removes at the next boot.
   */
  async discard(staged: StagedInstall): Promise<void> {
    await this.abandon(staged.txn)
  }

  /** Mark failed (unless already terminal) and delete the staging tree. */
  private async abandon(txn: ExtensionInstallTransaction): Promise<void> {
    if (txn.phase !== 'installed' && txn.phase !== 'failed') {
      await this.layout.store.transition(txn, 'failed').catch(() => {})
    }
    await fsp.rm(txn.stagingPath, { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Failure cleanup for a promotion that died mid-way. The rename-then-lock
   * pair is not atomic across both steps, so cleanup is evidence-driven —
   * the same rule recovery applies, applied eagerly by the live installer.
   */
  private async recordFailure(txn: { targetPath: string; stagingPath: string; transactionId: string }, promoted: boolean, locked: boolean): Promise<void> {
    if (promoted && !locked) {
      // The rename landed but the lock did not: this target is not an
      // installed extension. Move it back into the failed transaction's
      // staging so the evidence (txn.json says failed) and the bytes travel
      // together, then let the staging cleanup take both.
      await fsp.rename(txn.targetPath, path.join(txn.stagingPath, 'material', 'content')).catch(async () => {
        await fsp.rm(txn.targetPath, { recursive: true, force: true })
      })
      await atomicWriteJson(path.join(txn.stagingPath, 'promotion-failure.json'), {
        transactionId: txn.transactionId,
        reason: 'lock-write-failed-after-rename',
      })
    }
  }
}

export { LOCK_FILE_NAME }
