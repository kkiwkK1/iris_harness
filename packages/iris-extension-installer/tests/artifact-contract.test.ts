import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { Installer, ST_EXTENSION_ARTIFACT_CONTRACT, type ArtifactContract } from '../src/index.ts'
import { writeTree, demoFileMap } from './fixtures/helpers.ts'
import { tempDir } from '../../iris-app-service/tests/support/temp-dir.ts'

/**
 * The artifact gate is injected, and injecting it is the whole difference
 * between an installer and an *ST extension* installer.
 *
 * The property under test is a swap, not a widening: the same staged bytes
 * must be accepted under one contract and refused under the other, in both
 * directions. A test that only proved "a custom contract can refuse" would
 * pass against an implementation that ran the ST gate *as well*, which is the
 * failure this change exists to make impossible.
 *
 * The second contract here is synthetic rather than the real system-plugin one
 * (`SYSTEM_PLUGIN_ARTIFACT_CONTRACT`, `@iris/app-service`): this package must
 * not learn what a system plugin is, which is the point of the seam, so it
 * cannot import the consumer that does. The real one is driven through a real
 * `Installer` in `packages/iris-app-service/tests/plugin-manifest.test.ts`.
 */

async function tempRoot(t: TestContext): Promise<string> {
  return await tempDir(t, 'iris-installer-contract-')
}

class ContractRefusal extends Error {}

/** A format that has nothing to do with ST: one `plugin.json` at the root. */
function pluginJsonContract(seen: string[]): ArtifactContract {
  return {
    name: 'plugin-json-fixture',
    async validate(contentDir: string): Promise<void> {
      seen.push(contentDir)
      const stat = await fsp.lstat(path.join(contentDir, 'plugin.json')).catch(() => null)
      if (!stat?.isFile()) throw new ContractRefusal('artifact has no plugin.json')
    },
  }
}

test('a tree the ST contract accepts is refused by an injected contract that wants something else', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'st-shaped')
  await writeTree(src, demoFileMap()) // manifest.json + js entry: valid ST
  const installer = await Installer.create(path.join(root, 'store'))

  // Same bytes, default contract: installs.
  const ok = await installer.installAs('demo-ext', { kind: 'local-directory', directoryPath: src })
  assert.equal((await installer.readLock('demo-ext'))?.artifactSha256, ok.artifactSha256)

  // Same bytes, injected contract: refused, and refused by the injected one.
  const seen: string[] = []
  const installer2 = await Installer.create(path.join(root, 'store2'))
  await assert.rejects(
    installer2.installAs('demo-ext', { kind: 'local-directory', directoryPath: src }, { artifactContract: pluginJsonContract(seen) }),
    ContractRefusal,
  )
  assert.equal(seen.length, 1, 'the injected contract is the one that ran, exactly once')
  assert.deepEqual(await fsp.readdir(path.join(root, 'store2', 'installed')), [], 'a contract refusal never reaches the target root')
  assert.deepEqual(await fsp.readdir(path.join(root, 'store2', 'staging')), [], 'a contract refusal cleans its own staging')
  assert.deepEqual(await fsp.readdir(path.join(root, 'store2', 'claims')), [], 'the gate runs before the claim is taken')
})

test('a tree the ST contract refuses installs under the injected contract that accepts it', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'plugin-shaped')
  await writeTree(src, new Map([
    ['plugin.json', '{"name":"demo"}\n'],
    ['host.js', 'export default {}\n'],
  ]))

  // The default gate is the ST one, and it refuses: no manifest.json.
  const installer = await Installer.create(path.join(root, 'store'))
  await assert.rejects(
    installer.installAs('demo-ext', { kind: 'local-directory', directoryPath: src }),
    /manifest/,
  )
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [])

  // The injected gate accepts the same bytes, and everything downstream of the
  // gate — hash, claim, rename, lock — is the shared machinery, unchanged.
  const seen: string[] = []
  const installer2 = await Installer.create(path.join(root, 'store2'))
  const result = await installer2.installAs('demo-ext', { kind: 'local-directory', directoryPath: src }, { artifactContract: pluginJsonContract(seen) })
  const lock = await installer2.readLock('demo-ext')
  assert.equal(lock?.enabled, false, 'an injected contract does not buy a different lifecycle')
  assert.equal(lock?.artifactSha256, result.artifactSha256)
  assert.equal(seen.length, 1)
  assert.ok(await fsp.lstat(path.join(result.targetPath, 'host.js')).then(s => s.isFile()))

  // The directory the contract was handed is the staged tree, not the source
  // and not the target: a contract that refuses must not have been shown bytes
  // the user's disk already trusted.
  const staged = seen[0] as string
  assert.ok(staged.startsWith(path.join(root, 'store2', 'staging') + path.sep), `contract saw ${staged}`)
})

test('the exported ST contract is the default the installer applies', async (t: TestContext) => {
  const root = await tempRoot(t)
  const src = path.join(root, 'st-shaped')
  await writeTree(src, demoFileMap())

  // Passing the exported value explicitly is indistinguishable from passing
  // nothing — this is what "the default is a compatibility statement" means,
  // and it is what lets the ST caller name its contract without changing
  // behaviour.
  const a = await Installer.create(path.join(root, 'a'))
  const fromDefault = await a.installAs('demo-ext', { kind: 'local-directory', directoryPath: src })
  const b = await Installer.create(path.join(root, 'b'))
  const fromNamed = await b.installAs('demo-ext', { kind: 'local-directory', directoryPath: src }, { artifactContract: ST_EXTENSION_ARTIFACT_CONTRACT })
  assert.equal(fromNamed.artifactSha256, fromDefault.artifactSha256)
  assert.equal(ST_EXTENSION_ARTIFACT_CONTRACT.name, 'st-extension')

  // And it still refuses what it always refused, at the same place.
  const noEntry = path.join(root, 'no-entry')
  await writeTree(noEntry, new Map([['manifest.json', JSON.stringify({ display_name: 'x', js: 'dist/index.js' })]]))
  const c = await Installer.create(path.join(root, 'c'))
  await assert.rejects(
    c.installAs('demo-ext', { kind: 'local-directory', directoryPath: noEntry }, { artifactContract: ST_EXTENSION_ARTIFACT_CONTRACT }),
    /does not exist in the artifact/,
  )
})
