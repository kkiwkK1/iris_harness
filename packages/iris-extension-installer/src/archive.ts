/**
 * Safe extraction and tree copying.
 *
 * The threat model is the archive author: the archive is untrusted bytes and
 * its names, attributes and geometry are all hostile until proven otherwise.
 * Every refusal here is an affirmative rejection with a named reason — this
 * module never "fixes" a hostile name by stripping or re-rooting, because a
 * mangled install is a second attack surface; the archive is simply refused.
 *
 * Refused outright: absolute paths, Windows drive letters and UNC names,
 * backslashes, `..` segments, NUL/control characters, Windows reserved device
 * names, duplicate entry names, case-insensitive collisions (the staging
 * volume is NTFS by default; two entries that NTFS cannot hold apart are a
 * collision even if the zip thinks otherwise), symlink entries, entries whose
 * uncompressed geometry breaks the declared limits (zip bombs), and any
 * compression method other than store/deflate.
 *
 * After any materialization, `auditContainment` re-walks the tree with lstat:
 * nothing may be a symlink (junctions report as symlinks through libuv on
 * Windows, so a junction planted in a source directory is refused by the same
 * check), and every resolved path must be inside the staging root.
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

export class ArchiveSecurityError extends Error {
  readonly code: string
  readonly entry: string | undefined
  constructor(message: string, code: string, entry?: string) {
    super(message)
    this.code = code
    this.entry = entry
  }
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

export interface ExtractLimits {
  maxEntries: number
  maxTotalUncompressed: number
  maxFileUncompressed: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 50_000,
  maxTotalUncompressed: 1024 * 1024 * 1024,
  maxFileUncompressed: 256 * 1024 * 1024,
}

// --- name guards -----------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Refuses one archive entry name. Returns the POSIX segments it resolves to. */
export function guardEntryName(name: string): string[] {
  if (name.length === 0) {
    throw new ArchiveSecurityError('empty entry name', 'bad-name')
  }
  if (name.includes('\\')) {
    throw new ArchiveSecurityError(`entry name contains a backslash — Windows path separator used to smuggle a tree position: refused`, 'bad-name', name)
  }
  if (name.startsWith('//') || name.startsWith('\\')) {
    throw new ArchiveSecurityError(`entry name is a UNC/network path: refused`, 'unc-path', name)
  }
  if (name.startsWith('/') || name.startsWith('\\')) {
    throw new ArchiveSecurityError(`entry name is an absolute path: refused`, 'absolute-path', name)
  }
  if (/^[a-zA-Z]:/u.test(name)) {
    throw new ArchiveSecurityError(`entry name carries a Windows drive letter: refused`, 'drive-letter', name)
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ArchiveSecurityError(`entry name contains control characters: refused`, 'bad-name', name)
  }
  if (name.length > 400) {
    throw new ArchiveSecurityError(`entry name exceeds 400 characters: refused`, 'bad-name', name)
  }
  const segments = name.split('/')
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    if (segment === '') {
      // Only a single trailing slash (a directory marker) is acceptable.
      if (i === segments.length - 1 && i > 0) continue
      throw new ArchiveSecurityError(`entry name has an empty segment: refused`, 'bad-name', name)
    }
    if (segment === '.' || segment === '..') {
      throw new ArchiveSecurityError(`entry name contains a ${segment} segment — path traversal: refused`, 'traversal', name)
    }
    if (segment.includes(':')) {
      throw new ArchiveSecurityError(`entry segment contains a colon (alternate data stream / drive syntax): refused`, 'bad-name', name)
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new ArchiveSecurityError(`entry segment is a Windows reserved device name (${segment}): refused`, 'reserved-name', name)
    }
  }
  return segments.filter(s => s !== '')
}

// --- zip reader ------------------------------------------------------------

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  externalAttributes: number
  flags: number
}

function u16(b: Buffer, o: number): number { return b.readUInt16LE(o) }
function u32(b: Buffer, o: number): number { return b.readUInt32LE(o) }

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 65_536)
  for (let o = buf.length - 22; o >= min; o--) {
    if (u32(buf, o) === EOCD_SIG) return o
  }
  throw new ArchiveSecurityError('not a zip archive (no end-of-central-directory record)', 'not-zip')
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  const count = u16(buf, eocd + 10)
  if (count > DEFAULT_EXTRACT_LIMITS.maxEntries) {
    throw new ArchiveSecurityError(`archive declares ${count} entries, over the ${DEFAULT_EXTRACT_LIMITS.maxEntries}-entry limit`, 'too-many-entries')
  }
  let offset = u32(buf, eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || u32(buf, offset) !== CEN_SIG) {
      throw new ArchiveSecurityError(`central directory entry ${i} is corrupt or out of bounds`, 'corrupt')
    }
    const flags = u16(buf, offset + 8)
    if (flags & 0x0001) {
      throw new ArchiveSecurityError('archive entries are encrypted: refused', 'encrypted')
    }
    const method = u16(buf, offset + 10)
    if (method !== 0 && method !== 8) {
      throw new ArchiveSecurityError(`entry uses unsupported compression method ${method} (only store/deflate are accepted)`, 'bad-method')
    }
    const nameBytes = buf.subarray(offset + 46, offset + 46 + u16(buf, offset + 28))
    const name = (flags & 0x0800) !== 0 ? nameBytes.toString('utf8') : nameBytes.toString('latin1')
    entries.push({
      name,
      method,
      compressedSize: u32(buf, offset + 20),
      uncompressedSize: u32(buf, offset + 24),
      localHeaderOffset: u32(buf, offset + 42),
      externalAttributes: u32(buf, offset + 38),
      flags,
    })
    offset += 46 + u16(buf, offset + 28) + u16(buf, offset + 30) + u16(buf, offset + 32)
  }
  return entries
}

function decodeEntry(buf: Buffer, entry: ZipEntry, limits: ExtractLimits): Buffer {
  const loc = entry.localHeaderOffset
  if (loc + 30 > buf.length || u32(buf, loc) !== LOC_SIG) {
    throw new ArchiveSecurityError(`local header for ${entry.name} is corrupt or out of bounds`, 'corrupt', entry.name)
  }
  const nameLen = u16(buf, loc + 26)
  const extraLen = u16(buf, loc + 28)
  const dataStart = loc + 30 + nameLen + extraLen
  if (dataStart + entry.compressedSize > buf.length) {
    throw new ArchiveSecurityError(`data for ${entry.name} runs past the end of the archive`, 'corrupt', entry.name)
  }
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  const out = inflateRawSync(raw, { maxOutputLength: limits.maxFileUncompressed + 1 })
  if (out.length > limits.maxFileUncompressed) {
    throw new ArchiveSecurityError(`entry ${entry.name} decompresses past the ${limits.maxFileUncompressed}-byte limit — zip bomb shape`, 'zip-bomb', entry.name)
  }
  return out
}

function symlinkEntry(entry: ZipEntry): boolean {
  // Unix-flavored archives carry the file mode in the high 16 bits of the
  // external attributes; anything marked S_IFLNK is refused before creation.
  return (entry.externalAttributes >>> 16) !== 0 && ((entry.externalAttributes >>> 16) & S_IFMT) === S_IFLNK
}

/**
 * Extracts `zipPath` into `dest`. Directory entries create directories; file
 * entries create files; everything else (symlinks, unknown types) is refused.
 * No entry is executed, none is written outside `dest`, and the collision
 * checks run on a case-folded key so NTFS cannot be raced into overwriting.
 */
export async function extractZipSafely(zipPath: string, dest: string, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Promise<string[]> {
  const buf = await fsp.readFile(zipPath)
  const entries = readCentralDirectory(buf)
  if (entries.length > limits.maxEntries) {
    throw new ArchiveSecurityError(`archive holds ${entries.length} entries, over the ${limits.maxEntries}-entry limit`, 'too-many-entries')
  }
  const written: string[] = []
  const seenExact = new Set<string>()
  const seenFolded = new Map<string, string>()
  let totalUncompressed = 0
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of entries) {
    if (symlinkEntry(entry)) {
      throw new ArchiveSecurityError(`entry ${entry.name} is a symbolic link: archives never create links — refused`, 'symlink', entry.name)
    }
    const segments = guardEntryName(entry.name)
    const target = path.join(dest, ...segments)
    const rel = segments.join('/')
    if (seenExact.has(rel)) {
      throw new ArchiveSecurityError(`duplicate entry name ${rel}: refused`, 'duplicate-entry', rel)
    }
    const folded = rel.toLowerCase()
    const prior = seenFolded.get(folded)
    if (prior !== undefined) {
      throw new ArchiveSecurityError(`entries ${prior} and ${rel} collide case-insensitively on the target volume: refused`, 'case-collision', rel)
    }
    seenExact.add(rel)
    seenFolded.set(folded, rel)
    if (totalUncompressed + entry.uncompressedSize > limits.maxTotalUncompressed) {
      throw new ArchiveSecurityError(`archive expands past the ${limits.maxTotalUncompressed}-byte total limit — zip bomb shape`, 'zip-bomb', rel)
    }
    totalUncompressed += entry.uncompressedSize
    if (rel.endsWith('/')) {
      await fsp.mkdir(target, { recursive: true })
      continue
    }
    if (entry.uncompressedSize === 0 && entry.method === 0) {
      // Zero-length store entries: a directory marker without the trailing
      // slash, or a genuinely empty file — both land as a file unless the
      // central directory's unix mode says directory.
      const unixMode = entry.externalAttributes >>> 16
      if (unixMode !== 0 && (unixMode & S_IFMT) === 0o040000) {
        await fsp.mkdir(target, { recursive: true })
        continue
      }
    }
    const data = decodeEntry(buf, entry, limits)
    if (data.length !== entry.uncompressedSize) {
      throw new ArchiveSecurityError(`entry ${rel} decoded to ${data.length} bytes but declares ${entry.uncompressedSize}: refused`, 'corrupt', rel)
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, data, { flag: 'wx' })
    written.push(rel)
  }
  return written
}

// --- guarded tree copy (local-directory source) ----------------------------

/**
 * Copies `src` into `dest` under the same guards as archive extraction: the
 * walk is lstat-first, so a symlink or junction anywhere in the source tree
 * (including one planted after listing — the audit re-walk covers it) is
 * refused instead of followed.
 */
export async function copyTreeGuarded(src: string, dest: string): Promise<string[]> {
  const rootStat = await fsp.lstat(src).catch(() => null)
  if (!rootStat) throw new ArchiveSecurityError(`source directory does not exist: ${src}`, 'missing-source')
  if (rootStat.isSymbolicLink()) throw new ArchiveSecurityError('source directory is a symlink/junction: refused', 'symlink')
  if (!rootStat.isDirectory()) throw new ArchiveSecurityError(`source is not a directory: ${src}`, 'not-a-directory')
  await fsp.mkdir(dest, { recursive: true })
  const copied: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of items) {
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`
      const childPath = path.join(dir, item.name)
      // readdir's Dirent type is cached; lstat is the honest check — and a
      // junction on Windows reports isSymbolicLink() here, same as a symlink.
      const st = await fsp.lstat(childPath)
      if (st.isSymbolicLink()) {
        throw new ArchiveSecurityError(`source entry ${childRel} is a symlink/junction: refused`, 'symlink', childRel)
      }
      if (st.isDirectory()) {
        await fsp.mkdir(path.join(dest, childRel), { recursive: true })
        await walk(childPath, childRel)
      } else if (st.isFile()) {
        await fsp.copyFile(childPath, path.join(dest, childRel))
        copied.push(childRel)
      } else {
        throw new ArchiveSecurityError(`source entry ${childRel} is neither a file nor a directory: refused`, 'bad-type', childRel)
      }
    }
  }
  await walk(src, '')
  return copied
}

// --- containment audit -----------------------------------------------------

/**
 * Re-walks a materialized tree and refuses it if anything escaped `root` or
 * is a symlink/junction. This is the post-extraction backstop: the name
 * guards decide before writing, the audit decides after, and the two run on
 * independent evidence (the audit sees what the filesystem actually holds).
 */
export async function auditContainment(root: string): Promise<string[]> {
  const entries: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const item of items) {
      const childRel = rel === '' ? item.name : `${rel}/${item.name}`
      const childPath = path.join(dir, item.name)
      // The resolved path must stay inside the root: with all name guards in
      // place this cannot fire from an archive name, and that is the point —
      // it fires only if reality diverged from the guards' assumptions.
      const resolved = path.resolve(childPath)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new ArchiveSecurityError(`materialized path escaped the staging root: refused`, 'escape', childRel)
      }
      const st = await fs.lstatSync(childPath)
      if (st.isSymbolicLink()) {
        throw new ArchiveSecurityError(`entry ${childRel} is a symlink/junction in the staged tree: refused`, 'symlink', childRel)
      }
      if (st.isDirectory()) await walk(childPath, childRel)
      else entries.push(childRel)
    }
  }
  await walk(root, '')
  return entries
}
