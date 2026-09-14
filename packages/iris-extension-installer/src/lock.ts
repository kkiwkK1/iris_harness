/**
 * The installed-extension lock record: the one unambiguous statement of what
 * is on disk. A lock file exists only in an installed extension directory and
 * only after its bytes were fully materialized and hashed — `parseLock` is
 * deliberately strict (every field type-checked, `enabled` must be exactly
 * false) so a partial or foreign file can never be mistaken for a lock.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type ExtensionSource = import('./source.ts').ExtensionSource

export interface InstalledExtensionLock {
  extensionId: string
  source: ExtensionSource
  resolvedCommit?: string
  artifactSha256: string
  installedAt: string
  enabled: false
}

export const LOCK_FILE_NAME = 'lock.json'

const SOURCE_KINDS = new Set(['local-archive', 'local-directory', 'git'])
const SHA256_RE = /^[0-9a-f]{64}$/
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isValidExtensionId(extensionId: string): boolean {
  return typeof extensionId === 'string' && EXTENSION_ID_RE.test(extensionId)
}

/** Strict parse: returns the lock, or null if the file is absent, or throws with the reason if present-but-invalid. */
export async function parseLock(dir: string): Promise<InstalledExtensionLock | null> {
  let raw: string
  try {
    raw = await fsp.readFile(path.join(dir, LOCK_FILE_NAME), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const value: unknown = JSON.parse(raw)
  return assertLockShape(value)
}

export function assertLockShape(value: unknown): InstalledExtensionLock {
  if (typeof value !== 'object' || value === null) throw new Error('lock record is not an object')
  const lock = value as Record<string, unknown>
  if (typeof lock.extensionId !== 'string' || !isValidExtensionId(lock.extensionId)) {
    throw new Error(`lock extensionId is not a valid id: ${JSON.stringify(lock.extensionId)}`)
  }
  const source = lock.source as Record<string, unknown> | undefined
  if (typeof source !== 'object' || source === null || typeof source.kind !== 'string' || !SOURCE_KINDS.has(source.kind)) {
    throw new Error('lock source is not a valid ExtensionSource')
  }
  if (source.kind === 'git') {
    if (typeof source.repository !== 'string' || typeof source.commit !== 'string') {
      throw new Error('lock git source is missing repository/commit')
    }
    if (lock.resolvedCommit !== undefined && typeof lock.resolvedCommit !== 'string') {
      throw new Error('lock resolvedCommit is not a string')
    }
  }
  if (typeof lock.artifactSha256 !== 'string' || !SHA256_RE.test(lock.artifactSha256)) {
    throw new Error('lock artifactSha256 is not a 64-hex sha256')
  }
  if (typeof lock.installedAt !== 'string' || Number.isNaN(Date.parse(lock.installedAt))) {
    throw new Error('lock installedAt is not an ISO date')
  }
  if (lock.enabled !== false) {
    throw new Error('lock enabled must be exactly false — the installer never enables; enabling is the runtime\u2019s decision, not the installer\u2019s')
  }
  return value as unknown as InstalledExtensionLock
}

export function buildLock(input: {
  extensionId: string
  source: ExtensionSource
  resolvedCommit?: string
  artifactSha256: string
  installedAt?: string
}): InstalledExtensionLock {
  const lock: InstalledExtensionLock = {
    extensionId: input.extensionId,
    source: input.source,
    ...(input.resolvedCommit !== undefined ? { resolvedCommit: input.resolvedCommit } : {}),
    artifactSha256: input.artifactSha256,
    installedAt: input.installedAt ?? new Date().toISOString(),
    enabled: false,
  }
  // Built and then re-checked: the writer holds itself to the parser's bar.
  assertLockShape(lock)
  return lock
}

/** Writes the lock atomically (temp file in the same directory, then rename). */
export async function writeLock(dir: string, lock: InstalledExtensionLock): Promise<void> {
  assertLockShape(lock)
  const temp = path.join(dir, `.lock.json.${process.pid}.${Date.now()}.tmp`)
  await fsp.writeFile(temp, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' })
  try {
    fs.renameSync(temp, path.join(dir, LOCK_FILE_NAME))
  } catch (err) {
    await fsp.rm(temp, { force: true })
    throw err
  }
}
