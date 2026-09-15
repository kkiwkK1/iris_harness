/**
 * The install path's wire face: four new methods, the host handlers, and the
 * fake that has to mirror them.
 *
 * The suite beside this one (`plugin-install.test.ts`) drives the service
 * object directly, against real trees. This one drives the *methods* — schema
 * first, handler second, the way the transport does — because everything a
 * page can reach goes through that pair and a method with a schema and no
 * handler is exactly the hole `Handlers` being total exists to close.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { parseRequest, requestSchemas } from '@iris/protocol'


import { CharacterLibrary } from '../src/library.ts'
import { ChatStore } from '../src/chats.ts'
import { SettingsStore } from '../src/settings.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SystemPluginInstallService } from '../src/plugins/install.ts'
import { MVU_PLUGIN_ID, TAVERN_HELPER_PLUGIN_ID } from '../src/plugins/builtins.ts'
import { SystemPluginRuntime, type SystemPluginDefinition } from '../src/system-plugins.ts'
import { buildGitFixture, writeTree } from '../../iris-extension-installer/tests/fixtures/helpers.ts'

const INSTALL_METHODS = [
  'plugin.previewInstall',
  'plugin.confirmInstall',
  'plugin.cancelInstall',
  'plugin.update',
] as const

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

interface Fixture {
  dir: string
  handlers: Handlers
  runtime: SystemPluginRuntime
}

async function fixture(t: TestContext, options: { withInstaller?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-install-rpc-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' })
  const context = new Context()
  const runtime = new SystemPluginRuntime({
    context,
    file: join(dir, 'system-plugins.json'),
    definitions: builtinStubs(),
    defaultEnabled: [],
  })
  await runtime.initialize()
  t.after(async () => { await runtime.dispose() })

  const installer = new SystemPluginInstallService({
    runtime,
    installRoot: join(dir, 'system-plugins'),
    clientAssetRoot: join(dir, 'assets', 'system-plugins'),
    allowLocalGit: true,
  })
  const handlers = new IrisAppService({
    stream: () => { throw new Error('this fixture never generates') },
    library,
    chats,
    settings,
    broadcast: () => {},
    plugins: runtime,
    ...(options.withInstaller === false ? {} : { pluginInstaller: installer }),
  }).handlers()
  return { dir, handlers, runtime }
}

test('the four install methods are in the static vocabulary, so they ride the existing POST face', () => {
  for (const method of INSTALL_METHODS) {
    assert.ok(method in requestSchemas, `${method} must have a static request schema`)
  }
  // §9 #15: no new route. These go through `parseRequest` and the same
  // `POST /iris/rpc` every other method uses, which is what "the Host
  // allow-list and the loopback binding are untouched" means in practice — a
  // method that needed a route of its own would have to be registered
  // somewhere, and a static schema is the evidence that it is not.
  assert.equal(parseRequest('plugin.cancelInstall', { previewToken: 'x' }).ok, true)
})

test('the wire schemas refuse what the install path must never be handed', () => {
  const bad: [string, unknown][] = [
    ['plugin.previewInstall', { source: { kind: 'git', remote: 'https://h/r.git', commit: 'main' } }],
    ['plugin.previewInstall', { source: { kind: 'git', remote: 'https://h/r.git', commit: 'f9a07da' } }],
    ['plugin.previewInstall', { source: { kind: 'svn', url: 'https://h/r' } }],
    ['plugin.previewInstall', { source: { kind: 'dev' } }],
    ['plugin.confirmInstall', { previewToken: 't', id: 'Demo Plugin', commit: null, treeHash: 'a'.repeat(64) }],
    ['plugin.confirmInstall', { previewToken: 't', id: 'demo', commit: null, treeHash: 'a'.repeat(63) }],
    // `commit` is nullable, not optional: omitting it must not read as "dev".
    ['plugin.confirmInstall', { previewToken: 't', id: 'demo', treeHash: 'a'.repeat(64) }],
    ['plugin.update', { id: 'demo', commit: 'main' }],
  ]
  for (const [method, params] of bad) {
    assert.equal(parseRequest(method, params).ok, false, `${method} ${JSON.stringify(params)}`)
  }
  assert.equal(
    parseRequest('plugin.confirmInstall', { previewToken: 't', id: 'demo', commit: null, treeHash: 'a'.repeat(64) }).ok,
    true,
    'and the well-formed dev confirmation still parses',
  )
})

test('plugin.update answers a preview for a git row and refuses a dev row, through the handler pair', async (t) => {
  const value = await fixture(t)
  const request = <T,>(method: keyof Handlers, params: unknown): Promise<T> => {
    const parsed = parseRequest(method, params)
    assert.equal(parsed.ok, true, `${method} did not parse`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (value.handlers as any)[method]((parsed as { params: unknown }).params) as Promise<T>
  }

  const base = join(value.dir, 'rpc-git-src')
  await mkdir(base, { recursive: true })
  const gitRepo = await buildGitFixture(base, new Map([
    ['package.json', `${JSON.stringify({
      name: 'iris-plugin-wire-update',
      version: '1.0.0',
      type: 'module',
      iris: {
        plugin: {
          id: 'wire-update',
          apiVersion: 1,
          host: 'host.js',
          displayName: 'Wire Update',
          description: 'Driven through the RPC pair, updated through it too.',
          capabilities: ['wire.state'],
          permissions: ['provide-capability'],
        },
      },
    }, null, 2)}\n`],
    ['host.js', 'export default {\n'
      + "  id: 'wire-update', name: 'Wire Update', description: 'd', version: '1.0.0', apiVersion: 1, dependencies: [],\n"
      + "  activate(scope) { return scope.provide('wire.state', { ok: true }) },\n"
      + '}\n'],
    // buildGitFixture's second commit rewrites dist/index.js, so the tree
    // carries the dist/ directory it lands in.
    ['dist/index.js', 'export const demo = 0\n'],
  ]))
  const staged = await request<{ previewToken: string, id: string, commit: string, treeHash: string }>(
    'plugin.previewInstall',
    { source: { kind: 'git', remote: gitRepo.repoUrl, commit: gitRepo.olderCommit } },
  )
  await request('plugin.confirmInstall', {
    previewToken: staged.previewToken, id: staged.id, commit: staged.commit, treeHash: staged.treeHash,
  })
  const listed = await request<{ plugins: { id: string, provenance?: { treeHash?: string } }[] }>('plugin.list', {})
  const fromTreeHash = listed.plugins.find(plugin => plugin.id === 'wire-update')?.provenance?.treeHash

  // The implemented method: the row's own remote at the requested commit,
  // answering a preview whose updateOf names what the user is replacing.
  const updatePreview = await request<{
    id: string, commit?: string, updateOf?: { id: string, fromCommit: string, fromTreeHash?: string }
  }>('plugin.update', { id: 'wire-update', commit: gitRepo.head })
  assert.equal(updatePreview.id, 'wire-update')
  assert.equal(updatePreview.commit, gitRepo.head)
  assert.deepEqual(updatePreview.updateOf, { id: 'wire-update', fromCommit: gitRepo.olderCommit, fromTreeHash })

  const devTree = join(value.dir, 'rpc-dev-pkg')
  await writeTree(devTree, new Map([
    ['package.json', `${JSON.stringify({
      name: 'iris-plugin-wire-dev',
      version: '1.0.0',
      type: 'module',
      iris: {
        plugin: {
          id: 'wire-dev',
          apiVersion: 1,
          host: 'host.js',
          displayName: 'Wire Dev',
          description: 'A dev row has no update transaction.',
          capabilities: ['wire.state'],
          permissions: ['provide-capability'],
        },
      },
    }, null, 2)}\n`],
    ['host.js', 'export default {\n'
      + "  id: 'wire-dev', name: 'Wire Dev', description: 'd', version: '1.0.0', apiVersion: 1, dependencies: [],\n"
      + '  activate() {},\n'
      + '}\n'],
  ]))
  const devPreview = await request<{ previewToken: string, id: string, treeHash: string }>(
    'plugin.previewInstall', { source: { kind: 'dev', path: devTree } },
  )
  await request('plugin.confirmInstall', {
    previewToken: devPreview.previewToken, id: devPreview.id, commit: null, treeHash: devPreview.treeHash,
  })

  await assert.rejects(
    () => request('plugin.update', { id: 'wire-dev', commit: 'a'.repeat(40) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'unsupported')
      assert.match(String((error as Error).message), /loaded in place|就地/u)
      return true
    },
  )
  await assert.rejects(
    () => request('plugin.update', { id: 'no-such-plugin', commit: 'a'.repeat(40) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'not-found')
      return true
    },
  )
})

test('a host with no install path answers unsupported rather than half-installing', async (t) => {
  const value = await fixture(t, { withInstaller: false })
  for (const params of [
    ['plugin.previewInstall', { source: { kind: 'dev', path: 'x' } }],
    ['plugin.cancelInstall', { previewToken: 'x' }],
  ] as const) {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (value.handlers as any)[params[0]](params[1]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'unsupported')
        return true
      },
      params[0],
    )
  }
  // And `plugin.uninstall` keeps its old behaviour exactly: the row's flag
  // flips, the row stays, and nothing on disk is touched.
  await value.handlers['plugin.install']({ id: TAVERN_HELPER_PLUGIN_ID })
  const after = await value.handlers['plugin.uninstall']({ id: TAVERN_HELPER_PLUGIN_ID })
  const row = after.plugins.find(plugin => plugin.id === TAVERN_HELPER_PLUGIN_ID)
  assert.equal(row?.installed, false)
  assert.equal(row?.status, 'not-installed')
})

test('preview, confirm and cancel work through the handler pair, with the schema in front', async (t) => {
  const value = await fixture(t)
  const tree = join(value.dir, 'pkg')
  await writeTree(tree, new Map([
    ['package.json', `${JSON.stringify({
      name: 'iris-plugin-wire-demo',
      version: '2.1.0',
      type: 'module',
      iris: {
        plugin: {
          id: 'wire-demo',
          apiVersion: 1,
          host: 'host.js',
          displayName: 'Wire Demo',
          description: 'Driven through the RPC pair.',
          capabilities: ['wire.state'],
          permissions: ['provide-capability', 'register-rpc'],
        },
      },
    }, null, 2)}\n`],
    ['host.js', 'export default {\n'
      + "  id: 'wire-demo', name: 'Wire Demo', description: 'd', version: '2.1.0', apiVersion: 1, dependencies: [],\n"
      + "  activate(scope) { return scope.provide('wire.state', { ok: true }) },\n"
      + '}\n'],
  ]))

  const request = <T,>(method: keyof Handlers, params: unknown): Promise<T> => {
    const parsed = parseRequest(method, params)
    assert.equal(parsed.ok, true, `${method} did not parse`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (value.handlers as any)[method]((parsed as { params: unknown }).params) as Promise<T>
  }

  const first = await request<{ previewToken: string, id: string, treeHash: string, permissions: string[] }>(
    'plugin.previewInstall', { source: { kind: 'dev', path: tree } },
  )
  assert.equal(first.id, 'wire-demo')
  assert.deepEqual(first.permissions, ['provide-capability', 'register-rpc'])

  // Cancelling really retires the token: the same preview cannot be confirmed
  // afterwards, which is the property that makes cancel a real exit path and
  // not a cosmetic one.
  assert.deepEqual(await request('plugin.cancelInstall', { previewToken: first.previewToken }), { ok: true })
  await assert.rejects(() => request('plugin.confirmInstall', {
    previewToken: first.previewToken, id: first.id, commit: null, treeHash: first.treeHash,
  }), /no staged install/u)

  const second = await request<{ previewToken: string, id: string, treeHash: string }>(
    'plugin.previewInstall', { source: { kind: 'dev', path: tree } },
  )
  const snapshot = await request<{ plugins: { id: string, source?: string, status: string }[] }>(
    'plugin.confirmInstall',
    { previewToken: second.previewToken, id: second.id, commit: null, treeHash: second.treeHash },
  )
  const row = snapshot.plugins.find(plugin => plugin.id === 'wire-demo')
  assert.equal(row?.source, 'dev')
  assert.equal(row?.status, 'disabled')

  await request('plugin.enable', { id: 'wire-demo' })
  assert.deepEqual(value.runtime.capability('wire-demo', 'wire.state'), { ok: true })

  const gone = await request<{ plugins: { id: string }[] }>('plugin.uninstall', { id: 'wire-demo' })
  assert.ok(!gone.plugins.some(plugin => plugin.id === 'wire-demo'))
  // A dev uninstall never touches the user's directory.
  await writeFile(join(tree, 'touch.txt'), 'still here\n')
})
