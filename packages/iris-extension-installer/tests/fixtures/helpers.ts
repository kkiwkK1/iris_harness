/**
 * Test helpers: a minimal zip writer (store + deflate via node:zlib) so
 * attack fixtures are built in-test from explicit entry lists — no binary
 * fixtures, no third-party dependency — plus a tiny self-authored extension
 * tree and a local Git fixture builder.
 *
 * The writer is fixture-only code: it always writes well-formed local
 * headers and a central directory, and lets tests choose names, modes and
 * methods freely, including the hostile ones a real archiver would refuse.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'

export interface ZipInputEntry {
  name: string
  data?: Buffer | string
  /** Unix mode placed in the high 16 bits of external attributes. */
  unixMode?: number
  method?: 0 | 8
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c | 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]!) & 0xff]!
  return (c ^ -1) >>> 0
}

const UTF8_FLAG = 0x0800

export function buildZip(entries: ZipInputEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(entry.name, 'utf8')
    const unixMode = entry.unixMode ?? 0
    const externalAttributes = (unixMode << 16) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(UTF8_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt32LE(externalAttributes, 38)
    central.writeUInt32LE(offset, 42)
    central.writeUInt16LE(name.length, 28)
    centrals.push(central, name)

    offset += 30 + name.length + payload.length
  }
  const centralStart = offset
  let centralSize = 0
  for (const b of centrals) centralSize += b.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, ...centrals, eocd])
}

// --- fixture trees ----------------------------------------------------------

export const DEMO_MANIFEST = {
  display_name: 'Demo Extension',
  js: 'dist/index.js',
  version: '1.0.0',
}

export function demoFileMap(): Map<string, string> {
  return new Map([
    ['manifest.json', JSON.stringify(DEMO_MANIFEST, null, 2)],
    ['dist/index.js', 'export const demo = "self-authored fixture, never executed"\n'],
    ['dist/lib.js', 'export const lib = 1\n'],
    ['README.md', '# demo extension\n'],
  ])
}

export async function writeTree(dir: string, files: Map<string, Buffer | string>): Promise<void> {
  for (const [rel, data] of files) {
    const target = path.join(dir, ...rel.split('/'))
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
  }
}

export function zipEntriesFrom(files: Map<string, Buffer | string>, unixMode = 0o100644): ZipInputEntry[] {
  return [...files].map(([name, data]) => ({ name, data, unixMode }))
}

export function demoZipEntries(): ZipInputEntry[] {
  return [
    { name: 'manifest.json', data: JSON.stringify(DEMO_MANIFEST, null, 2), unixMode: 0o100644 },
    { name: 'dist/', unixMode: 0o040755 },
    { name: 'dist/index.js', data: 'export const demo = "self-authored fixture, never executed"\n', unixMode: 0o100644 },
    { name: 'dist/lib.js', data: 'export const lib = 1\n', unixMode: 0o100644 },
    { name: 'README.md', data: '# demo extension\n', unixMode: 0o100644 },
  ]
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

// --- git fixture ------------------------------------------------------------

export interface GitFixture {
  repoUrl: string
  head: string
  olderCommit: string
}

/**
 * Builds a real local Git repository with two commits on main, so tests cover
 * the pinned-commit path against a HEAD that has moved past the pin.
 */
export async function buildGitFixture(base: string, files: Map<string, Buffer | string>): Promise<GitFixture> {
  const repo = path.join(base, 'fixture-repo.git')
  fs.mkdirSync(repo, { recursive: true })
  const run = (args: string[]): void => {
    const r = spawnSync('git', ['-C', repo, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    })
    if (r.status !== 0) throw new Error(`git fixture ${args[0]} failed: ${String(r.stderr)}`)
  }
  run(['init', '-q', '-b', 'main', '.'])
  await writeTree(repo, files)
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'older'])
  const olderCommit = String(spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout).trim()
  await fsp.writeFile(path.join(repo, 'dist', 'index.js'), 'export const demo = "newer HEAD, not the pin"\n')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'newer'])
  const head = String(spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout).trim()
  return { repoUrl: `file://${repo.replace(/\\/gu, '/')}`, head, olderCommit }
}
