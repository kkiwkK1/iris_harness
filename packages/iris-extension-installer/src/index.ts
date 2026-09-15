/**
 * The installer barrel: everything re-exports from the module that owns it,
 * so imports either come from `@iris/extension-installer` or from the owning
 * module directly — never both spellings.
 */

export {
  auditContainment,
  copyTreeGuarded,
  ArchiveSecurityError,
  DEFAULT_EXTRACT_LIMITS,
  extractZipSafely,
  guardEntryName,
  type ExtractLimits,
} from './archive.ts'
export { ST_EXTENSION_ARTIFACT_CONTRACT, type ArtifactContract } from './artifact-contract.ts'
export { hashTree, sha256File, type TreeHash } from './hash.ts'
export { buildLock, parseLock, writeLock, isValidExtensionId, LOCK_FILE_NAME, type InstalledExtensionLock } from './lock.ts'
export {
  Installer,
  PROVISIONAL_EXTENSION_ID,
  type InstallOptions,
  type InstallResult,
  type StagedInstall,
  type StageOptions,
} from './installer.ts'
export { recoverInstallations, type RecoveryAction, type RecoveryOutcome } from './recovery.ts'
export { createLayout, ensureLayout, acquireClaim, releaseClaim, InstallClaimBusyError, type InstallerLayout } from './staging.ts'
export {
  assertPinnedCommit,
  materializeSource,
  SourceError,
  validateExtensionSource,
  type ExtensionSource,
  type SourceOptions,
} from './source.ts'
export {
  atomicWriteJson,
  TransactionStore,
  type ExtensionInstallTransaction,
  type InstallPhase,
} from './transaction.ts'
