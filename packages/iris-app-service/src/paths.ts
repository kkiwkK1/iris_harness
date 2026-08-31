/**
 * Identity and the files behind it.
 *
 * Every id in the protocol reaches this process from a browser, and every id
 * here becomes a path. That makes this module a security boundary, not a
 * formatting helper: `chatId` is checked against a whitelist pattern *and* the
 * resolved path is checked to still be inside its directory, because one guard
 * alone is one bug away from `../../`.
 *
 * @module @iris/app-service/paths
 */

import { resolve, sep } from 'node:path'

import { invalid } from './errors.ts'

/**
 * Characters an id may contain.
 *
 * Unicode letters are allowed on purpose — a Chinese character card should keep
 * its name in its filename — while everything Windows or POSIX treats specially
 * is not. `.` is permitted inside but a bare `.` or `..` is rejected below.
 */
const SAFE_ID = /^[\p{L}\p{N}._-]{1,120}$/u

/** Windows reserves these device names in every directory, extension or not. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Whether an id may be turned into a filename.
 * @param id - the candidate, straight off the wire.
 * @returns true when it names a file and nothing else.
 */
export function isSafeId(id: string): boolean {
  if (!SAFE_ID.test(id)) return false
  if (id === '.' || id === '..') return false
  if (RESERVED.test(id.split('.')[0] ?? '')) return false
  return true
}

/**
 * Turn a human name into an id.
 * @param name - a character name, a filename, or anything else user-authored.
 * @returns a safe id, never empty.
 */
export function toId(name: string): string {
  // Only a real trailing extension is stripped: a path-shaped name like
  // `../../etc/passwd` must keep its segments so the filter below can flatten
  // them, rather than being cut back to `..` and silently becoming `unnamed`.
  const stem = name.replace(/\.[^./\\]+$/, '')
  const cleaned = stem
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\s]+/gu, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 100)
  if (cleaned.length === 0 || !isSafeId(cleaned)) return 'unnamed'
  return cleaned
}

/**
 * Derive an id nothing has claimed yet.
 * @param base - the preferred id.
 * @param taken - reports whether an id is in use.
 * @returns `base`, or `base-2`, `base-3`, … until one is free.
 */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`
    if (!taken(candidate)) return candidate
  }
}

/**
 * Resolve one id to a file inside a directory, refusing anything that escapes.
 * @param dir - the directory that owns the file.
 * @param id - the id from the request.
 * @param extension - the file extension, dot included.
 * @returns the absolute path.
 * @throws {AppError} `invalid-request` when the id would leave `dir`.
 */
export function fileFor(dir: string, id: string, extension: string): string {
  if (!isSafeId(id)) throw invalid(`"${id}" is not a valid identifier`)
  const root = resolve(dir)
  const path = resolve(root, `${id}${extension}`)
  // Belt and braces: the pattern above already forbids separators, and this
  // catches whatever the pattern one day fails to.
  if (path !== root && !path.startsWith(root + sep)) {
    throw invalid(`"${id}" is not a valid identifier`)
  }
  return path
}
