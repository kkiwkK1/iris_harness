import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { ArchiveSecurityError, extractZipSafely, guardEntryName } from '../src/archive.ts'
import { buildZip, demoZipEntries, type ZipInputEntry } from './fixtures/helpers.ts'
import { tempDir } from '../../iris-app-service/tests/support/temp-dir.ts'

async function tempRoot(t: TestContext): Promise<string> {
  return await tempDir(t, 'iris-installer-archive-')
}

async function extract(t: TestContext, entries: ZipInputEntry[]): Promise<string> {
  const root = await tempRoot(t)
  const zipPath = path.join(root, 'attack.zip')
  await fsp.writeFile(zipPath, buildZip(entries))
  const dest = path.join(root, 'out')
  const written = await extractZipSafely(zipPath, dest)
  return path.join(dest, ...written)
}

test('the named traversal attacks are each refused with their own reason', async (t: TestContext) => {
  const attacks: { name: string; code: string }[] = [
    { name: '../../outside.js', code: 'traversal' },
    { name: 'a/../../outside.js', code: 'traversal' },
    { name: '/absolute/path.js', code: 'absolute-path' },
    { name: 'C:\\evil.js', code: 'bad-name' }, // backslash refused before drive syntax matters
    { name: 'C:/evil.js', code: 'drive-letter' },
    { name: 'C:evil.js', code: 'drive-letter' },
    { name: '//server/share/x.js', code: 'unc-path' }, // empty leading segment
    { name: 'a/./b.js', code: 'traversal' },
    { name: 'a//b.js', code: 'bad-name' },
    { name: 'a/CON', code: 'reserved-name' },
    { name: 'a/NUL.txt', code: 'reserved-name' },
    { name: 'stream:hidden.js', code: 'bad-name' }, // colon: ADS / drive syntax
  ]
  for (const { name, code } of attacks) {
    assert.throws(() => guardEntryName(name), (err: ArchiveSecurityError) => err.code === code, name)
    await assert.rejects(
      extract(t, [{ name: 'manifest.json', data: '{}' }, { name, data: 'x' }]),
      (err: ArchiveSecurityError) => err.code === code,
      name,
    )
  }
})

test('zip case collisions and duplicate names are refused before the volume can be raced', async (t: TestContext) => {
  await assert.rejects(
    extract(t, [
      { name: 'dist/index.js', data: 'a' },
      { name: 'dist/INDEX.js', data: 'b' },
    ]),
    (err: ArchiveSecurityError) => err.code === 'case-collision',
  )
  await assert.rejects(
    extract(t, [
      { name: 'dist/index.js', data: 'a' },
      { name: 'dist/index.js', data: 'b' },
    ]),
    (err: ArchiveSecurityError) => err.code === 'duplicate-entry',
  )
})

test('symlink entries are refused without creation', async (t: TestContext) => {
  const root = await tempRoot(t)
  const zipPath = path.join(root, 'symlink.zip')
  await fsp.writeFile(zipPath, buildZip([
    { name: 'manifest.json', data: '{}' },
    { name: 'link', data: '/etc/passwd', unixMode: 0o120777 },
  ]))
  await assert.rejects(
    extractZipSafely(zipPath, path.join(root, 'out')),
    (err: ArchiveSecurityError) => err.code === 'symlink',
  )
  const out = await fsp.readdir(path.join(root, 'out')).catch((): string[] => [])
  assert.ok(!out.includes('link'), 'the symlink must never be created, even dead')
})

test('a hostile archive cannot place a file outside staging (containment audit backstop)', async (t: TestContext) => {
  // The guards refuse traversal names up front; this test drives a legal-named
  // archive to completion and audits that reality agrees — nothing landed
  // outside `out` even though the temp root sits right next to it.
  const root = await tempRoot(t)
  const zipPath = path.join(root, 'ok.zip')
  await fsp.writeFile(zipPath, buildZip(demoZipEntries()))
  const dest = path.join(root, 'out')
  const written = await extractZipSafely(zipPath, dest)
  assert.ok(written.includes('manifest.json'))
  const outside = await fsp.readdir(root)
  assert.deepEqual(outside.filter(n => n !== 'ok.zip' && n !== 'out'), [])
})

test('zip bomb geometry is refused: a declared size that the data cannot satisfy is caught', async (t: TestContext) => {
  const root = await tempRoot(t)
  const zipPath = path.join(root, 'bomb.zip')
  // A small deflate entry whose central directory claims 300 MB uncompressed —
  // the classic geometry lie. The decode must refuse it, not allocate it.
  const declared = buildZip([
    { name: 'manifest.json', data: '{}' },
    { name: 'big.bin', data: Buffer.alloc(64), method: 8 },
  ])
  const eocdOffset = declared.length - 22
  const centralStart = declared.readUInt32LE(eocdOffset + 16)
  // Collect central-directory headers and flip the second entry's declared size.
  const centers: number[] = []
  for (let o = centralStart; o < declared.length - 22; o++) {
    if (declared.readUInt32LE(o) === 0x02014b50) centers.push(o)
  }
  const second = centers[1]!
  assert.ok(second > 0, 'fixture must locate the second central header')
  declared.writeUInt32LE(300 * 1024 * 1024, second + 24)
  await fsp.writeFile(zipPath, declared)
  await assert.rejects(
    extractZipSafely(zipPath, path.join(root, 'out')),
    (err: ArchiveSecurityError) => err.code === 'corrupt' || err.code === 'zip-bomb',
  )
})

test('non-zip bytes and encrypted entries are refused, not guessed at', async (t: TestContext) => {
  const root = await tempRoot(t)
  await fsp.writeFile(path.join(root, 'x.zip'), Buffer.from('this is not a zip file'))
  await assert.rejects(
    extractZipSafely(path.join(root, 'x.zip'), path.join(root, 'out')),
    (err: ArchiveSecurityError) => err.code === 'not-zip',
  )
})
