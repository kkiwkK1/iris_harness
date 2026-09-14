import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
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

// --- 缺陷二：来源无关的合同 ---------------------------------------------

test('a git repository without a manifest is refused by the same gate as any other source', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'src')
  await fsp.mkdir(base, { recursive: true })
  // The fixture writes dist/index.js etc. but no manifest.json.
  const files = demoFileMap()
  files.delete('manifest.json')
  const fixture = await buildGitFixture(base, files)

  const installer = await Installer.create(path.join(root, 'store'))
  await assert.rejects(
    installer.installAs('demo-ext', { kind: 'git', repository: fixture.repoUrl, commit: fixture.olderCommit }, { allowLocalGit: true }),
    /manifest/,
  )
  // Nothing was promoted; the failed transaction cleaned its own staging.
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'staging')), [])
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [])
})

test('different clone metadata, identical working tree: the same artifact hash, and no .git in the installed tree', async () => {
  const root = await tempRoot()
  const base = path.join(root, 'src')
  await fsp.mkdir(base, { recursive: true })

  // Two independent repositories holding byte-identical working trees but
  // different clone metadata (author dates far apart, different messages) —
  // therefore different commit SHAs. The artifact hash must be the hash of
  // the working tree, not of the transport baggage around it.
  const mkRepo = async (name: string, date: string, message: string): Promise<{ repoUrl: string; commit: string }> => {
    const repo = path.join(base, name)
    fs.mkdirSync(repo, { recursive: true })
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }
    const run = (args: string[]): void => {
      const r = spawnSync('git', ['-C', repo, ...args], { env })
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr)}`)
    }
    run(['init', '-q', '-b', 'main', '.'])
    for (const [rel, data] of demoFileMap()) {
      const target = path.join(repo, ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data)
    }
    run(['add', '-A'])
    run(['commit', '-q', '-m', message])
    const commit = String(spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout).trim()
    return { repoUrl: `file://${repo.split(path.sep).join('/')}`, commit }
  }
  const a = await mkRepo('repo-a', '2020-01-01T00:00:00Z', 'release 2020')
  const b = await mkRepo('repo-b', '2026-09-13T00:00:00Z', 'rebuilt from scratch')
  assert.notEqual(a.commit, b.commit, 'fixture sanity: different metadata must mean different commits')

  const installer = await Installer.create(path.join(root, 'store'))
  const fromA = await installer.installAs('demo-ext-a', { kind: 'git', repository: a.repoUrl, commit: a.commit }, { allowLocalGit: true })
  const fromB = await installer.installAs('demo-ext-b', { kind: 'git', repository: b.repoUrl, commit: b.commit }, { allowLocalGit: true })
  assert.equal(fromA.artifactSha256, fromB.artifactSha256, 'the lock hash means the working tree, not the clone')

  // And the installed tree carries no clone metadata at all.
  const installedEntries = await fsp.readdir(fromA.targetPath)
  assert.ok(!installedEntries.includes('.git'), '.git must be gone before hashing and promotion')
  assert.ok(installedEntries.includes('manifest.json'))
})
