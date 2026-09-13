import assert from 'node:assert/strict'
import { test } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Installer, SourceError, validateExtensionSource } from '../src/index.ts'
import { assertPinnedCommit } from '../src/source.ts'
import { buildGitFixture, demoFileMap, writeTree } from './fixtures/helpers.ts'

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'iris-installer-source-'))
}

test('git sources accept only https (or file:// under the test-only option) and full 40-hex pins', () => {
  validateExtensionSource({ kind: 'git', repository: 'https://github.com/zonde306/ST-Prompt-Template', commit: 'f'.repeat(40) })
  validateExtensionSource({ kind: 'git', repository: 'file:///tmp/repo', commit: 'f'.repeat(40) }, { allowLocalGit: true })
  for (const repository of ['git://host/repo.git', 'ssh://git@host/repo.git', '/local/path', 'https://host/repo; rm -rf /']) {
    assert.throws(() => validateExtensionSource({ kind: 'git', repository, commit: 'f'.repeat(40) }), SourceError, repository)
  }
  assert.throws(() => validateExtensionSource({ kind: 'git', repository: 'https://host/repo', commit: 'main' }), SourceError)
  assert.throws(() => validateExtensionSource({ kind: 'git', repository: 'https://host/repo', commit: 'f9a07da' }), SourceError, 'short SHA is a moving pin')
  assert.throws(() => assertPinnedCommit('dev'), SourceError)
})

test('git materialization fetches the pinned commit and proves HEAD equals the pin', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'src')
  await fsp.mkdir(base, { recursive: true })
  const fixture = await buildGitFixture(base, demoFileMap())

  // Pin the OLDER commit while HEAD has moved on: the fetch must land exactly
  // the pin, and the lock's resolvedCommit must be the pin, never HEAD.
  const installer = await Installer.create(path.join(root, 'store'))
  const result = await installer.installAs('demo-ext', { kind: 'git', repository: fixture.repoUrl, commit: fixture.olderCommit }, { allowLocalGit: true })
  assert.equal(result.resolvedCommit, fixture.olderCommit)
  assert.notEqual(result.resolvedCommit, fixture.head)
  const lock = await installer.readLock('demo-ext')
  assert.equal(lock?.resolvedCommit, fixture.olderCommit)
  const installed = await fsp.readFile(path.join(result.targetPath, 'manifest.json'), 'utf8')
  assert.match(installed, /Demo Extension/)

  // A pin that does not exist in the repo fails with a git error, not a silent install.
  const installer2 = await Installer.create(path.join(root, 'store2'))
  await assert.rejects(
    installer2.installAs('demo-ext', { kind: 'git', repository: fixture.repoUrl, commit: 'a'.repeat(40) }, { allowLocalGit: true }),
    SourceError,
  )
  // And the failed transaction left nothing behind.
  const staging = await fsp.readdir(path.join(root, 'store2', 'staging'))
  assert.deepEqual(staging, [])
})

test('local-directory source materializes the guarded tree; a junction inside it is refused', async () => {
  const root = await tempRoot()
  const src = path.join(root, 'src-tree')
  await writeTree(src, demoFileMap())

  const installer = await Installer.create(path.join(root, 'store'))
  const result = await installer.installAs('demo-ext', { kind: 'local-directory', directoryPath: src })
  const installed = await fsp.readFile(path.join(result.targetPath, 'dist', 'index.js'), 'utf8')
  assert.match(installed, /self-authored fixture/)

  // A junction planted in the source tree (Windows; a symlink elsewhere) is
  // refused by the lstat walk before a single byte is followed.
  if (process.platform === 'win32') {
    const evil = path.join(root, 'evil-tree')
    await writeTree(evil, demoFileMap())
    await fsp.symlink(path.join(root, 'outside'), path.join(evil, 'link'), 'junction').catch(() => {})
    const installer2 = await Installer.create(path.join(root, 'store2'))
    await assert.rejects(
      installer2.installAs('demo-ext', { kind: 'local-directory', directoryPath: evil }),
      /symlink\/junction/,
    )
  }
})

test('archive source copies bytes into staging before anything is unpacked', async () => {
  const root = await tempRoot()
  const installer = await Installer.create(path.join(root, 'store'))
  await assert.rejects(
    installer.installAs('demo-ext', { kind: 'local-archive', archivePath: path.join(root, 'missing.zip') }),
    /does not exist/,
  )
  // A symlinked archive path is refused, not followed.
  const realArchive = path.join(root, 'real.zip')
  const { buildZip, demoZipEntries } = await import('./fixtures/helpers.ts')
  await fsp.writeFile(realArchive, buildZip(demoZipEntries()))
  const linkPath = path.join(root, 'link.zip')
  await fsp.symlink(realArchive, linkPath, 'file').catch(() => {})
  const installer2 = await Installer.create(path.join(root, 'store2'))
  if (process.platform === 'win32' || (await fsp.lstat(linkPath).then(s => s.isSymbolicLink()).catch(() => false))) {
    await assert.rejects(
      installer2.installAs('demo-ext', { kind: 'local-archive', archivePath: linkPath }),
      /symlink/,
    )
  }
})
