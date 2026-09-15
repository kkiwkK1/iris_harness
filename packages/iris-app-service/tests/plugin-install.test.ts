/**
 * The system-plugin install path, end to end and against real bytes.
 *
 * Every test here drives a *real* package tree on disk — a `package.json` with
 * an `iris.plugin` block, a `host.js` that actually gets imported and actually
 * provides a capability, a `client.js` that actually lands under the asset
 * root — through the real installer transaction. The git tests fetch from a
 * real local git repository over `file://`, built by the installer suite's own
 * fixture helper, so nothing here touches the network and nothing here mocks
 * the part that would fail.
 *
 * The one thing that is faked is `apps/iris-web`: the browser member scan
 * (`scanPluginMemberNames`) belongs to the frame and is not reachable from
 * this package, so what is asserted about `client.js` here is that the bytes
 * reach the one path the asset face serves from, and nothing about what the
 * frame makes of them.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { hashTree, LOCK_FILE_NAME } from '@iris/extension-installer'
import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'

import { buildGitFixture, writeTree } from '../../iris-extension-installer/tests/fixtures/helpers.ts'
import { PLUGIN_TREE_LIMITS, SystemPluginInstallService, type PluginInstallSource } from '../src/plugins/install.ts'
import { MVU_PLUGIN_ID, TAVERN_HELPER_PLUGIN_ID } from '../src/plugins/builtins.ts'
import { SystemPluginRuntime, type SystemPluginDefinition } from '../src/system-plugins.ts'

const PLUGIN_ID = 'demo-plugin'

/**
 * The fixture package's `host.js`.
 *
 * It writes a marker file **at module scope**, before anything else, because
 * several tests assert that a plugin's code was never imported. A marker
 * written inside `activate` would only prove activation did not happen, and
 * "the tree was not imported" is the stronger claim §9 #12 and #14 both make.
 */
function hostSource(options: { id?: string, apiVersion?: number, throwOnActivate?: boolean, throwOnLoad?: boolean } = {}): string {
  const id = options.id ?? PLUGIN_ID
  const apiVersion = options.apiVersion ?? 1
  return [
    `import { appendFileSync } from 'node:fs'`,
    `if (process.env.IRIS_TEST_PLUGIN_MARKER) appendFileSync(process.env.IRIS_TEST_PLUGIN_MARKER, 'imported\\n')`,
    options.throwOnLoad === true ? `throw new Error('this module explodes at import time')` : '',
    `export default {`,
    `  id: ${JSON.stringify(id)},`,
    `  name: 'Demo Plugin',`,
    `  description: 'A self-authored fixture plugin.',`,
    `  version: '1.0.0',`,
    `  apiVersion: ${String(apiVersion)},`,
    `  dependencies: [],`,
    `  activate(scope) {`,
    options.throwOnActivate === true ? `    throw new Error('activate refused on purpose')` : '',
    `    return scope.provide('demo.state', { id: ${JSON.stringify(id)}, revision: scope.revision })`,
    `  },`,
    `}`,
    '',
  ].filter(line => line !== '').join('\n')
}

const CLIENT_SOURCE = `registerPluginMembers('${PLUGIN_ID}', { demoState: () => 1 })\n`

interface PackageOverrides {
  id?: string
  apiVersion?: number | string
  host?: string
  client?: string | null
  permissions?: unknown
  capabilities?: string[]
  dependencies?: string[]
  hostSource?: string
  extraFiles?: Record<string, string>
  dropIrisBlock?: boolean
}

/** A minimal, real system-plugin package as a path → bytes map. */
function pluginPackage(overrides: PackageOverrides = {}): Map<string, string> {
  const id = overrides.id ?? PLUGIN_ID
  const block: Record<string, unknown> = {
    id,
    apiVersion: overrides.apiVersion ?? 1,
    host: overrides.host ?? 'host.js',
    displayName: 'Demo Plugin',
    description: 'A self-authored fixture plugin, never fetched from anywhere.',
    capabilities: overrides.capabilities ?? ['demo.state'],
    permissions: overrides.permissions ?? ['provide-capability'],
    dependencies: overrides.dependencies ?? [],
  }
  if (overrides.client !== null) block['client'] = overrides.client ?? 'client.js'
  // `"type": "module"` because host.js is ESM and the host imports it by URL:
  // without it Node reparses the file after failing to read it as CommonJS,
  // which works but is a warning on every single import.
  const manifest: Record<string, unknown> = { name: `iris-plugin-${id}`, version: '1.0.0', type: 'module' }
  if (overrides.dropIrisBlock !== true) manifest['iris'] = { plugin: block }

  const files = new Map<string, string>([
    ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['host.js', overrides.hostSource ?? hostSource({ id })],
    // buildGitFixture's second commit rewrites dist/index.js, so the tree has
    // a dist/ for it to land in. The pinned (older) commit is this map exactly.
    ['dist/noop.js', 'export const noop = 0\n'],
    ['README.md', '# demo plugin\n'],
  ])
  if (overrides.client !== null) files.set(overrides.client ?? 'client.js', CLIENT_SOURCE)
  for (const [rel, body] of Object.entries(overrides.extraFiles ?? {})) files.set(rel, body)
  return files
}

interface Harness {
  dir: string
  catalogFile: string
  installRoot: string
  assetRoot: string
  marker: string
  runtime: SystemPluginRuntime
  installer: SystemPluginInstallService
  /** Tear down this generation and boot a fresh one over the same profile. */
  reboot: () => Promise<Harness>
}

async function harness(
  t: TestContext,
  options: { dir?: string, limits?: { maxBytes: number, maxFiles: number } } = {},
): Promise<Harness> {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'iris-plugin-install-'))
  if (options.dir === undefined) {
    t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  }
  const catalogFile = join(dir, 'system-plugins.json')
  const installRoot = join(dir, 'system-plugins')
  const assetRoot = join(dir, 'assets', 'system-plugins')
  const marker = join(dir, 'host-imported.log')
  process.env.IRIS_TEST_PLUGIN_MARKER = marker

  const context = new Context()
  const runtime = new SystemPluginRuntime({
    context,
    file: catalogFile,
    definitions: builtinStubs(),
    defaultEnabled: [],
  })
  await runtime.initialize()
  const installer = new SystemPluginInstallService({
    runtime,
    installRoot,
    clientAssetRoot: assetRoot,
    allowLocalGit: true,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  })
  await installer.scanInstalled()
  const value: Harness = {
    dir,
    catalogFile,
    installRoot,
    assetRoot,
    marker,
    runtime,
    installer,
    reboot: async () => {
      await runtime.dispose()
      return await harness(t, { dir, ...(options.limits !== undefined ? { limits: options.limits } : {}) })
    },
  }
  t.after(async () => { await runtime.dispose() })
  return value
}

/**
 * Two builtin ids with trivial bodies.
 *
 * Real ones would drag the whole TH/MVU capability graph into a test about
 * directories and hashes; what these tests need from a builtin is only that
 * the id is taken, which is the exact thing §12 ruling 5 is about.
 */
function builtinStubs(): SystemPluginDefinition[] {
  return [TAVERN_HELPER_PLUGIN_ID, MVU_PLUGIN_ID].map(id => ({
    id,
    name: id,
    description: `${id} stub`,
    version: '0.0.0',
    apiVersion: 1 as const,
    dependencies: [],
    activate: () => undefined,
  }))
}

function row(snapshot: SystemPluginSnapshot, id: string): SystemPluginView {
  const found = snapshot.plugins.find(plugin => plugin.id === id)
  assert.ok(found !== undefined, `no catalog row for "${id}"`)
  return found
}

function missing(snapshot: SystemPluginSnapshot, id: string): boolean {
  return !snapshot.plugins.some(plugin => plugin.id === id)
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}

/** preview → confirm, echoing exactly what the preview said. */
async function install(value: Harness, source: PluginInstallSource): Promise<SystemPluginSnapshot> {
  const preview = await value.installer.preview(source)
  return await value.installer.confirm({
    previewToken: preview.previewToken,
    id: preview.id,
    commit: preview.commit ?? null,
    treeHash: preview.treeHash,
  })
}

async function devSource(value: Harness, overrides: PackageOverrides = {}, name = 'dev-tree'): Promise<PluginInstallSource> {
  const root = join(value.dir, name)
  await writeTree(root, pluginPackage(overrides))
  return { kind: 'dev', path: root }
}

async function gitSource(value: Harness, overrides: PackageOverrides = {}, name = 'git-src'): Promise<PluginInstallSource & { kind: 'git' }> {
  const base = join(value.dir, name)
  await mkdir(base, { recursive: true })
  const fixture = await buildGitFixture(base, pluginPackage(overrides))
  return { kind: 'git', remote: fixture.repoUrl, commit: fixture.olderCommit }
}

// ---------------------------------------------------------------------------
// The end-to-end lifecycles
// ---------------------------------------------------------------------------

test('a dev package: preview, confirm, enable, disable, uninstall — and the user’s directory is never touched', async (t) => {
  const value = await harness(t)
  const source = await devSource(value)

  const preview = await value.installer.preview(source)
  assert.equal(preview.id, PLUGIN_ID)
  assert.equal(preview.displayName, 'Demo Plugin')
  assert.equal(preview.source, 'dev')
  assert.equal(preview.path, (source as { path: string }).path)
  assert.equal(preview.commit, undefined)
  assert.equal(preview.apiVersion, '1.0')
  assert.equal(preview.compatible, true)
  assert.deepEqual(preview.capabilities, ['demo.state'])
  assert.deepEqual(preview.permissions, ['provide-capability'])
  assert.equal(preview.hasClient, true)
  assert.match(preview.treeHash, /^[0-9a-f]{64}$/u)
  assert.ok(preview.fileCount >= 4, `expected the fixture's files to be counted, saw ${String(preview.fileCount)}`)
  assert.ok(preview.sizeBytes > 0)
  assert.equal(await exists(value.marker), false, 'preview must not import host.js')

  const installed = await value.installer.confirm({
    previewToken: preview.previewToken,
    id: preview.id,
    commit: null,
    treeHash: preview.treeHash,
  })
  const afterConfirm = row(installed, PLUGIN_ID)
  assert.equal(afterConfirm.installed, true)
  assert.equal(afterConfirm.enabled, false, 'installing is not enabling')
  assert.equal(afterConfirm.status, 'disabled')
  assert.equal(afterConfirm.source, 'dev')
  assert.equal(afterConfirm.provenance?.path, (source as { path: string }).path)
  assert.equal(afterConfirm.provenance?.treeHash, preview.treeHash)
  assert.equal(await exists(value.marker), false, 'confirm must not import host.js either')

  // The browser bundle reached the one place the asset face serves from.
  assert.equal(
    await readFile(join(value.assetRoot, PLUGIN_ID, 'client', 'client.js'), 'utf8'),
    CLIENT_SOURCE,
  )
  // A dev package is loaded in place: nothing was promoted into the install root.
  assert.equal(await exists(value.installer.installedDir(PLUGIN_ID)), false)

  await value.runtime.enable(PLUGIN_ID)
  assert.equal(row(value.runtime.snapshot(), PLUGIN_ID).status, 'enabled')
  assert.deepEqual(
    value.runtime.capability(PLUGIN_ID, 'demo.state'),
    { id: PLUGIN_ID, revision: value.runtime.snapshot().revision },
  )
  assert.equal(await exists(value.marker), true, 'enable is when host.js is first imported')

  await value.runtime.disable(PLUGIN_ID)
  assert.equal(row(value.runtime.snapshot(), PLUGIN_ID).status, 'disabled')
  assert.equal(value.runtime.capability(PLUGIN_ID, 'demo.state'), undefined)

  const afterUninstall = await value.installer.uninstall(PLUGIN_ID)
  assert.ok(missing(afterUninstall, PLUGIN_ID), 'the catalog row goes with the uninstall')
  assert.equal(
    await exists(join((source as { path: string }).path, 'package.json')),
    true,
    'a dev uninstall must never delete the user’s own working directory',
  )
})

test('a git package: promoted, locked, hashed, and the tree is deleted on uninstall', async (t) => {
  const value = await harness(t)
  const source = await gitSource(value)

  const preview = await value.installer.preview(source)
  assert.equal(preview.source, 'git')
  assert.equal(preview.remote, source.remote)
  assert.equal(preview.commit, source.commit)
  assert.equal(preview.path, undefined)

  const snapshot = await value.installer.confirm({
    previewToken: preview.previewToken,
    id: preview.id,
    commit: preview.commit ?? null,
    treeHash: preview.treeHash,
  })
  const installed = row(snapshot, PLUGIN_ID)
  assert.equal(installed.source, 'git')
  assert.equal(installed.provenance?.remote, source.remote)
  assert.equal(installed.provenance?.commit, source.commit)
  assert.equal(installed.provenance?.treeHash, preview.treeHash)
  assert.ok(installed.provenance?.installedAt !== undefined)

  const tree = value.installer.installedDir(PLUGIN_ID)
  assert.equal(await exists(join(tree, 'host.js')), true)
  assert.equal(await exists(join(tree, LOCK_FILE_NAME)), true)
  assert.equal(await exists(join(tree, '.git')), false, 'clone metadata is never promoted')
  const lock = JSON.parse(await readFile(join(tree, LOCK_FILE_NAME), 'utf8')) as { enabled: unknown, artifactSha256: string }
  assert.equal(lock.enabled, false, 'the installer never enables')
  assert.equal(lock.artifactSha256, preview.treeHash)

  await value.runtime.enable(PLUGIN_ID)
  assert.equal(row(value.runtime.snapshot(), PLUGIN_ID).status, 'enabled')

  const afterUninstall = await value.installer.uninstall(PLUGIN_ID)
  assert.ok(missing(afterUninstall, PLUGIN_ID))
  assert.equal(await exists(tree), false, 'a git uninstall deletes the installed tree (§6)')
  assert.equal(await exists(join(value.assetRoot, PLUGIN_ID)), false, 'and takes the served bundle with it')
})

// ---------------------------------------------------------------------------
// Consent: the echo has to match the record
// ---------------------------------------------------------------------------

test('a confirmation that echoes a different treeHash is refused, and nothing is promoted', async (t) => {
  const value = await harness(t)
  const preview = await value.installer.preview(await gitSource(value))
  await assert.rejects(
    () => value.installer.confirm({
      previewToken: preview.previewToken,
      id: preview.id,
      commit: preview.commit ?? null,
      treeHash: 'a'.repeat(64),
    }),
    /install-failed[\s\S]*treeHash/u,
  )
  assert.equal(await exists(value.installer.installedDir(PLUGIN_ID)), false)
  assert.ok(missing(value.runtime.snapshot(), PLUGIN_ID))
  assert.deepEqual(await readdir(join(value.installRoot, 'staging')), [], 'the refused transaction cleaned its staging')
})

test('a confirmation that echoes a different id, or a different commit, is refused', async (t) => {
  const value = await harness(t)
  const first = await value.installer.preview(await gitSource(value, {}, 'git-a'))
  await assert.rejects(
    () => value.installer.confirm({
      previewToken: first.previewToken,
      id: 'something-else',
      commit: first.commit ?? null,
      treeHash: first.treeHash,
    }),
    /install-failed[\s\S]*something-else/u,
  )

  const second = await value.installer.preview(await gitSource(value, {}, 'git-b'))
  await assert.rejects(
    () => value.installer.confirm({
      previewToken: second.previewToken,
      id: second.id,
      commit: 'b'.repeat(40),
      treeHash: second.treeHash,
    }),
    /install-failed[\s\S]*commit/u,
  )
  assert.ok(missing(value.runtime.snapshot(), PLUGIN_ID))
})

test('a stale preview cannot approve a tree that moved: the second preview is the one that can be confirmed', async (t) => {
  const value = await harness(t)
  const root = join(value.dir, 'moving-tree')
  await writeTree(root, pluginPackage())
  const stale = await value.installer.preview({ kind: 'dev', path: root })

  // The source tree changes after the user was shown the first preview.
  await writeFile(join(root, 'README.md'), '# demo plugin, edited after the consent page rendered\n')
  const fresh = await value.installer.preview({ kind: 'dev', path: root })
  assert.notEqual(fresh.treeHash, stale.treeHash, 'fixture sanity: the edit must change the hash')

  // The stale token still names the bytes it staged, so confirming it with the
  // *new* hash is refused — which is what stops a consent page that rendered
  // the old tree from approving the new one.
  await assert.rejects(
    () => value.installer.confirm({
      previewToken: stale.previewToken,
      id: stale.id,
      commit: null,
      treeHash: fresh.treeHash,
    }),
    /install-failed[\s\S]*treeHash/u,
  )
  await value.installer.confirm({
    previewToken: fresh.previewToken,
    id: fresh.id,
    commit: null,
    treeHash: fresh.treeHash,
  })
  assert.equal(row(value.runtime.snapshot(), PLUGIN_ID).installed, true)
})

test('cancel discards the staging, and the cancelled token cannot be confirmed', async (t) => {
  const value = await harness(t)
  const preview = await value.installer.preview(await gitSource(value))
  assert.equal((await readdir(join(value.installRoot, 'staging'))).length, 1, 'a preview holds a staging directory')

  await value.installer.cancel(preview.previewToken)
  assert.deepEqual(await readdir(join(value.installRoot, 'staging')), [])

  await assert.rejects(
    () => value.installer.confirm({
      previewToken: preview.previewToken,
      id: preview.id,
      commit: preview.commit ?? null,
      treeHash: preview.treeHash,
    }),
    /install-failed[\s\S]*no staged install/u,
  )
  assert.ok(missing(value.runtime.snapshot(), PLUGIN_ID))
})

// ---------------------------------------------------------------------------
// Ruling 5: a taken id
// ---------------------------------------------------------------------------

test('confirming under a builtin id is refused as install-failed, id 已被占用', async (t) => {
  const value = await harness(t)
  const preview = await value.installer.preview(
    await devSource(value, { id: TAVERN_HELPER_PLUGIN_ID, hostSource: hostSource({ id: TAVERN_HELPER_PLUGIN_ID }) }),
  )
  assert.equal(preview.id, TAVERN_HELPER_PLUGIN_ID)
  assert.ok(
    preview.warnings.some(warning => warning.includes('已被占用')),
    `the preview warns before the click: ${preview.warnings.join(' | ')}`,
  )
  await assert.rejects(
    () => value.installer.confirm({
      previewToken: preview.previewToken,
      id: preview.id,
      commit: null,
      treeHash: preview.treeHash,
    }),
    /install-failed[\s\S]*已被占用/u,
  )
  // The builtin row is untouched — no shadowing, no second row.
  assert.equal(
    value.runtime.snapshot().plugins.filter(plugin => plugin.id === TAVERN_HELPER_PLUGIN_ID).length,
    1,
  )
  assert.equal(row(value.runtime.snapshot(), TAVERN_HELPER_PLUGIN_ID).source, 'builtin')
})

// ---------------------------------------------------------------------------
// Boot re-verification
// ---------------------------------------------------------------------------

test('a tampered git tree is listed as tampered, is never imported, and cannot be enabled', async (t) => {
  let value = await harness(t)
  await install(value, await gitSource(value))
  const tree = value.installer.installedDir(PLUGIN_ID)

  // One byte, in a file that is not host.js: the hash is over the whole tree.
  await writeFile(join(tree, 'README.md'), '# demo plugin, modified on disk\n')
  await rm(value.marker, { force: true })

  value = await value.reboot()
  const tampered = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(tampered.failure?.state, 'tampered')
  assert.match(tampered.failure?.reason ?? '', /与安装时记录的不符|hash to/u)
  assert.equal(tampered.enabled, false)
  assert.equal(tampered.status, 'error')
  assert.equal(tampered.provenance?.remote !== undefined, true, 'the remote survives, so a reinstall can be driven')
  assert.equal(await exists(value.marker), false, 'host.js must never be imported for a tampered tree')

  await assert.rejects(
    () => value.runtime.enable(PLUGIN_ID),
    (error: unknown) => {
      // `unsupported`, not `internal`: the enable is refused **before** the
      // dependency ordering runs, by the recorded verdict — it is not an
      // activation that happened to fail. Both refuse, so the code is what
      // tells the two apart, and it is the difference between "this row is
      // tampered" and "something went wrong starting it".
      assert.equal((error as { code?: string }).code, 'unsupported')
      assert.match(String((error as Error).message), /tampered/u)
      return true
    },
  )
  assert.equal(await exists(value.marker), false)
})

test('a dev row skips the hash check: its tree is expected to be edited', async (t) => {
  let value = await harness(t)
  const source = await devSource(value)
  await install(value, source)
  await value.runtime.enable(PLUGIN_ID)

  await writeFile(join((source as { path: string }).path, 'README.md'), '# edited while developing\n')
  value = await value.reboot()
  const after = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(after.failure, undefined, 'a dev row is never tampered — ruling 1 accepted exactly this cost')
  assert.equal(after.source, 'dev')
  assert.equal(after.status, 'enabled', 'and the persisted enabled flag survives the restart')
})

test('a git row that survives a reboot unchanged comes back enabled, with its provenance intact', async (t) => {
  let value = await harness(t)
  const source = await gitSource(value)
  await install(value, source)
  await value.runtime.enable(PLUGIN_ID)

  value = await value.reboot()
  const after = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(after.status, 'enabled')
  assert.equal(after.failure, undefined)
  assert.equal(after.provenance?.commit, source.commit)
  assert.deepEqual(
    value.runtime.capability(PLUGIN_ID, 'demo.state'),
    { id: PLUGIN_ID, revision: value.runtime.snapshot().revision },
  )
})

test('ruling 3: tamper, boot, then reinstall from the recorded remote and commit through the full consent', async (t) => {
  let value = await harness(t)
  const source = await gitSource(value)
  await install(value, source)

  await writeFile(join(value.installer.installedDir(PLUGIN_ID), 'host.js'), hostSource() + '\n// patched by hand\n')
  value = await value.reboot()
  const tampered = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(tampered.failure?.state, 'tampered')

  // Everything the reinstall needs is on the row the user is looking at.
  const remote = tampered.provenance?.remote
  const commit = tampered.provenance?.commit
  assert.ok(remote !== undefined && commit !== undefined)

  // The round's update path is "uninstall, then install again" (§1 non-goals),
  // and ruling 5 is what forces the order: the id is taken until the row goes.
  await value.installer.uninstall(PLUGIN_ID)
  assert.ok(missing(value.runtime.snapshot(), PLUGIN_ID))

  const preview = await value.installer.preview({ kind: 'git', remote, commit })
  assert.equal(preview.commit, commit)
  await value.installer.confirm({
    previewToken: preview.previewToken,
    id: preview.id,
    commit: preview.commit ?? null,
    treeHash: preview.treeHash,
  })
  await value.runtime.enable(PLUGIN_ID)
  const healed = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(healed.status, 'enabled')
  assert.equal(healed.failure, undefined)
  assert.equal(healed.provenance?.commit, commit)
})

// ---------------------------------------------------------------------------
// One test per failure state
// ---------------------------------------------------------------------------

test('install-failed: a non-https remote, an unpinned commit, and a remote carrying credentials', async (t) => {
  const value = await harness(t)
  for (const source of [
    { kind: 'git' as const, remote: 'git://host/repo.git', commit: 'f'.repeat(40) },
    { kind: 'git' as const, remote: 'https://host/repo; rm -rf /', commit: 'f'.repeat(40) },
  ]) {
    await assert.rejects(() => value.installer.preview(source), /install-failed/u, source.remote)
  }
  await assert.rejects(
    () => value.installer.preview({ kind: 'git', remote: 'https://user:token@example.invalid/x.git', commit: 'f'.repeat(40) }),
    /install-failed[\s\S]*credentials/u,
  )
  // The layout root exists (creating it is how the installer opens), but no
  // transaction was ever begun: the refusal happens before git runs.
  assert.deepEqual(await readdir(join(value.installRoot, 'staging')), [])
  assert.deepEqual(await readdir(join(value.installRoot, 'installed')), [])
})

test('manifest-invalid: the field is named, and a host path pointing out of the tree is one of the ways', async (t) => {
  const value = await harness(t)
  await assert.rejects(
    async () => await value.installer.preview(await devSource(value, { dropIrisBlock: true }, 'no-block')),
    /manifest-invalid[\s\S]*iris/u,
  )
  await assert.rejects(
    async () => await value.installer.preview(await devSource(value, { host: '../outside.js' }, 'escaping-host')),
    /manifest-invalid[\s\S]*host/u,
  )
  await assert.rejects(
    async () => await value.installer.preview(await devSource(value, { permissions: ['network-access'] }, 'bad-permission')),
    /manifest-invalid[\s\S]*permissions\[0\]/u,
  )
})

test('incompatible: a package for another apiVersion is refused at install, not half-installed', async (t) => {
  const value = await harness(t)
  await assert.rejects(
    async () => await value.installer.preview(await devSource(value, { apiVersion: 2, hostSource: hostSource({ apiVersion: 2 }) }, 'future')),
    /incompatible[\s\S]*apiVersion/u,
  )
  assert.ok(missing(value.runtime.snapshot(), PLUGIN_ID))
})

test('load-failed: the default export is checked against the manifest before activate is called', async (t) => {
  const value = await harness(t)
  await install(value, await devSource(value, { hostSource: hostSource({ id: 'a-different-id' }) }, 'lying-host'))
  await assert.rejects(() => value.runtime.enable(PLUGIN_ID), /load-failed|failed/u)
  const failed = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(failed.failure?.state, 'load-failed')
  assert.equal(failed.failure?.field, 'id')
  assert.equal(failed.status, 'error')
  assert.equal(failed.enabled, false)
})

test('load-failed: a host module that throws at import time is named at its own field, not as an activate failure', async (t) => {
  const value = await harness(t)
  await install(value, await devSource(value, { hostSource: hostSource({ throwOnLoad: true }) }, 'exploding-import'))
  await assert.rejects(() => value.runtime.enable(PLUGIN_ID))
  const failed = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(failed.failure?.state, 'load-failed')
  assert.equal(failed.failure?.field, 'host')
})

test('activate-failed: the plugin’s own activate throwing is its own state, and a retry is allowed', async (t) => {
  const value = await harness(t)
  await install(value, await devSource(value, { hostSource: hostSource({ throwOnActivate: true }) }, 'refusing-activate'))
  await assert.rejects(() => value.runtime.enable(PLUGIN_ID))
  const failed = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(failed.failure?.state, 'activate-failed')
  // Unlike tampered/incompatible, this one is retryable: the author fixes the
  // file and tries again, so the second enable must reach activation rather
  // than be refused by the recorded verdict.
  await assert.rejects(() => value.runtime.enable(PLUGIN_ID), /activate refused on purpose/u)
})

test('install-failed at boot: a recorded row whose tree is gone is listed, not forgotten', async (t) => {
  let value = await harness(t)
  await install(value, await gitSource(value))
  await rm(value.installer.installedDir(PLUGIN_ID), { recursive: true, force: true })

  value = await value.reboot()
  const gone = row(value.runtime.snapshot(), PLUGIN_ID)
  assert.equal(gone.failure?.state, 'install-failed')
  assert.equal(gone.status, 'error')
  await assert.rejects(() => value.runtime.enable(PLUGIN_ID), /install-failed/u)
  // And it can still be uninstalled, which is the whole reason the row stays.
  assert.ok(missing(await value.installer.uninstall(PLUGIN_ID), PLUGIN_ID))
})

// ---------------------------------------------------------------------------
// The tree limits (§9 #9, #10)
// ---------------------------------------------------------------------------

test('the shipped tree limits are the measured ones: 256 MiB and 20,000 files', () => {
  assert.equal(PLUGIN_TREE_LIMITS.maxBytes, 256 * 1024 * 1024)
  assert.equal(PLUGIN_TREE_LIMITS.maxFiles, 20_000)
  // The ST pilot tree (notes/st-compat/pilot-lock.md §2) is 415 files /
  // 102,374,704 bytes, and it is the only real sample this path has ever had.
  assert.ok(PLUGIN_TREE_LIMITS.maxFiles > 415, 'the file ceiling must admit the one measured real tree')
  assert.ok(PLUGIN_TREE_LIMITS.maxBytes > 102_374_704, 'so must the byte ceiling')
})

test('a package over the file or byte ceiling is refused as install-failed', async (t) => {
  const tight = await harness(t, { limits: { maxBytes: 64 * 1024, maxFiles: 3 } })
  await assert.rejects(
    async () => await tight.installer.preview(await devSource(tight, {}, 'too-many-files')),
    /install-failed[\s\S]*3-file limit/u,
  )
  const roomy = await harness(t, { limits: { maxBytes: 16, maxFiles: 20_000 } })
  await assert.rejects(
    async () => await roomy.installer.preview(await devSource(roomy, {}, 'too-many-bytes')),
    /install-failed[\s\S]*16-byte limit/u,
  )
})

test('a package that ships node_modules is refused, and the reason says why the failure would be silent', async (t) => {
  const value = await harness(t)
  await assert.rejects(
    async () => await value.installer.preview(await devSource(value, {
      extraFiles: { 'node_modules/cordis/index.js': 'export const second = "instance"\n' },
    }, 'vendored')),
    /install-failed[\s\S]*node_modules[\s\S]*no symptom/u,
  )
})

// ---------------------------------------------------------------------------
// Persistence: v1 → v2
// ---------------------------------------------------------------------------

test('a v1 catalog upgrades in place: enabled flags survive, the revision does not go backwards, and the file becomes v2', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-v1-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await writeFile(join(dir, 'system-plugins.json'), `${JSON.stringify({
    version: 1,
    revision: 7,
    plugins: {
      [TAVERN_HELPER_PLUGIN_ID]: { installed: true, enabled: true },
      [MVU_PLUGIN_ID]: { installed: true, enabled: false },
    },
  }, null, 2)}\n`)

  const value = await harness(t, { dir })
  assert.ok(value.runtime.snapshot().revision >= 7, 'the revision must never go backwards across an upgrade')
  assert.equal(row(value.runtime.snapshot(), TAVERN_HELPER_PLUGIN_ID).enabled, true)
  assert.equal(row(value.runtime.snapshot(), MVU_PLUGIN_ID).enabled, false)
  assert.equal(row(value.runtime.snapshot(), TAVERN_HELPER_PLUGIN_ID).source, 'builtin')

  const stored = JSON.parse(await readFile(value.catalogFile, 'utf8')) as {
    version: number
    revision: number
    plugins: Record<string, { installed: boolean, enabled: boolean, source?: string }>
  }
  assert.equal(stored.version, 2)
  assert.ok(stored.revision >= 7)
  assert.equal(stored.plugins[TAVERN_HELPER_PLUGIN_ID]?.enabled, true)
  assert.equal(stored.plugins[TAVERN_HELPER_PLUGIN_ID]?.source, 'builtin')
})

test('a catalog version this build does not know is retained and everything fails closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-v9-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  // The same branch a v1-only reader takes when handed this build's v2 file:
  // `parseStored` accepts a closed set of versions and everything else is an
  // unreadable file. That direction is the one this tree can still execute —
  // the v1 reader itself is gone — and it is the one the ruling is about:
  // an unknown version disables everything and keeps the bytes.
  const bytes = `${JSON.stringify({ version: 9, revision: 3, plugins: {} }, null, 2)}\n`
  await writeFile(join(dir, 'system-plugins.json'), bytes)

  const value = await harness(t, { dir })
  assert.equal(await readFile(value.catalogFile, 'utf8'), bytes, 'the unreadable file is retained, not replaced')
  for (const plugin of value.runtime.snapshot().plugins) {
    assert.equal(plugin.status, 'error', plugin.id)
    assert.equal(plugin.enabled, false, plugin.id)
  }
  await assert.rejects(() => value.runtime.enable(TAVERN_HELPER_PLUGIN_ID), /file was retained/u)
})

test('a lifecycle transition never erases provenance', async (t) => {
  const value = await harness(t)
  const source = await gitSource(value)
  await install(value, source)
  await value.runtime.enable(PLUGIN_ID)
  await value.runtime.disable(PLUGIN_ID)

  const stored = JSON.parse(await readFile(value.catalogFile, 'utf8')) as {
    plugins: Record<string, { source?: string, remote?: string, commit?: string, treeHash?: string }>
  }
  assert.equal(stored.plugins[PLUGIN_ID]?.source, 'git')
  assert.equal(stored.plugins[PLUGIN_ID]?.remote, source.remote)
  assert.equal(stored.plugins[PLUGIN_ID]?.commit, source.commit)
  assert.match(stored.plugins[PLUGIN_ID]?.treeHash ?? '', /^[0-9a-f]{64}$/u)
})

// ---------------------------------------------------------------------------
// The invariants the installer already owns, reached through this path
// ---------------------------------------------------------------------------

test('the boot hash is taken over the tree without its lock, so an untouched install verifies', async (t) => {
  const value = await harness(t)
  await install(value, await gitSource(value))
  const tree = value.installer.installedDir(PLUGIN_ID)
  const recorded = row(value.runtime.snapshot(), PLUGIN_ID).provenance?.treeHash
  const withoutLock = await hashTree(tree, rel => rel === LOCK_FILE_NAME)
  const withLock = await hashTree(tree)
  assert.equal(withoutLock.sha256, recorded)
  assert.notEqual(
    withLock.sha256,
    recorded,
    'fixture sanity: the lock is inside the tree, so a re-hash that included it would read as tampered on every boot',
  )
})

test('git hooks in the fixture repository never run during an install', async (t) => {
  const value = await harness(t)
  const base = join(value.dir, 'hooked')
  await mkdir(base, { recursive: true })
  const fixture = await buildGitFixture(base, pluginPackage())
  const repo = join(base, 'fixture-repo.git')
  const witness = join(value.dir, 'hook-ran.txt')
  const hook = process.platform === 'win32'
    ? `#!/bin/sh\necho ran > ${witness.replace(/\\/gu, '/')}\n`
    : `#!/bin/sh\necho ran > ${witness}\n`
  fs.writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), hook, { mode: 0o755 })

  await install(value, { kind: 'git', remote: fixture.repoUrl, commit: fixture.olderCommit })
  assert.equal(await exists(witness), false, 'core.hooksPath is emptied on every git invocation')
})

test('the installed tree is the pinned commit, not the branch head', async (t) => {
  const value = await harness(t)
  const base = join(value.dir, 'moving-head')
  await mkdir(base, { recursive: true })
  const fixture = await buildGitFixture(base, pluginPackage())
  assert.notEqual(fixture.head, fixture.olderCommit, 'fixture sanity: HEAD moved past the pin')

  await install(value, { kind: 'git', remote: fixture.repoUrl, commit: fixture.olderCommit })
  const tree = value.installer.installedDir(PLUGIN_ID)
  assert.equal(
    await exists(join(tree, 'dist', 'index.js')),
    false,
    'dist/index.js only exists in the newer commit; installing it would mean the pin was not honoured',
  )
  assert.equal(row(value.runtime.snapshot(), PLUGIN_ID).provenance?.commit, fixture.olderCommit)
})

test('a commit the remote does not have fails the install, and leaves nothing behind', async (t) => {
  const value = await harness(t)
  const source = await gitSource(value)
  await assert.rejects(
    () => value.installer.preview({ kind: 'git', remote: source.remote, commit: 'a'.repeat(40) }),
    /install-failed/u,
  )
  assert.deepEqual(await readdir(join(value.installRoot, 'staging')), [])
  assert.deepEqual(await readdir(join(value.installRoot, 'installed')), [])
})

test('the install path never spawns anything but git, with a fixed argv', () => {
  // The claim is structural and belongs to source.ts, whose own suite asserts
  // the refusals. What is asserted here is that this path added no second
  // spawn site: the install service's source text contains no child-process
  // import at all, so every process it can start is one source.ts started.
  const text = fs.readFileSync(new URL('../src/plugins/install.ts', import.meta.url), 'utf8')
  assert.ok(!/node:child_process/u.test(text), 'the install path must not spawn anything of its own')
  assert.ok(!/execSync|spawnSync|exec\(/u.test(text))
  const source = fs.readFileSync(new URL('../../iris-extension-installer/src/source.ts', import.meta.url), 'utf8')
  assert.ok(
    source.includes(`spawnSync('git'`),
    'git is still invoked by name with an argv array — no shell, and no interpolated command string',
  )
  assert.ok(!/shell:\s*true/u.test(source))
})

test('nothing on this path reads a key file or a connection store', () => {
  // §9 #16: the guarantee this round offers is "no new interface that reads a
  // credential", never "a plugin cannot reach one" — a system plugin is
  // same-privilege Node code and can open any file the host can. What is
  // assertable, and asserted here, is that the two modules this round added
  // name no credential source of their own.
  for (const file of ['../src/plugins/install.ts', '../src/plugins/manifest.ts']) {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(!/key\.txt/u.test(text), `${file} must not name the key file`)
    assert.ok(!/apiKey|apiKeyHeader/u.test(text), `${file} must not reach for a connection key`)
    assert.ok(!/connections\.ts|ConnectionStore/u.test(text), `${file} must not import the connection store`)
  }
})

test('a git fixture repository is real: the fixture builder makes two commits', async (t) => {
  // Guards the guard. Every git test above rests on `buildGitFixture` actually
  // producing a repository with a moved HEAD; a fixture that silently produced
  // one commit would make "the pin was honoured" unfalsifiable.
  const value = await harness(t)
  const base = join(value.dir, 'sanity')
  await mkdir(base, { recursive: true })
  const fixture = await buildGitFixture(base, pluginPackage())
  const log = spawnSync('git', ['-C', join(base, 'fixture-repo.git'), 'rev-list', '--count', 'HEAD'])
  assert.equal(String(log.stdout).trim(), '2')
  assert.match(fixture.repoUrl, /^file:\/\//u)
})
