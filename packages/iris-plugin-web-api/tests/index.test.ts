import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'

import {
  DEFAULT_SANDBOX_PLUGIN_RUNTIME,
  PLUGIN_ASSET_MANIFEST_PATH,
  PLUGIN_ASSET_PREFIX,
  SYSTEM_PLUGIN_RUNTIME_META,
  encodeSandboxPluginRuntime,
  parsePluginAssetManifest,
  fenceFrameParams,
  parseSandboxPluginRuntime,
  sandboxPluginRuntime,
} from '../src/index.ts'

function view(overrides: Partial<SystemPluginView>): SystemPluginView {
  return {
    id: 'tavern-helper',
    name: 'Tavern Helper',
    description: '',
    version: '0.0.0',
    apiVersion: 1,
    dependencies: [],
    installed: true,
    enabled: true,
    status: 'enabled',
    ...overrides,
  }
}

function snapshot(plugins: SystemPluginView[], revision = 7): SystemPluginSnapshot {
  return { revision, plugins }
}

test('the meta name is the literal both bundles read and write', () => {
  assert.equal(SYSTEM_PLUGIN_RUNTIME_META, 'iris-system-plugins')
})

test('the legacy default behaves like an existing profile with both built-ins enabled', () => {
  assert.deepEqual(DEFAULT_SANDBOX_PLUGIN_RUNTIME, { revision: 0, tavernHelper: true, mvu: true, plugins: {} })
  assert.equal(Object.isFrozen(DEFAULT_SANDBOX_PLUGIN_RUNTIME), true)
  assert.equal(Object.isFrozen(DEFAULT_SANDBOX_PLUGIN_RUNTIME.plugins), true)
})

test('an absent snapshot reduces to absent capabilities', () => {
  assert.equal(sandboxPluginRuntime(undefined), undefined)
})

test('running built-ins reduce to their capability flags at the snapshot revision', () => {
  const runtime = sandboxPluginRuntime(snapshot([
    view({ id: 'tavern-helper' }),
    view({ id: 'mvu', dependencies: ['tavern-helper'] }),
  ]))
  assert.deepEqual(runtime, { revision: 7, tavernHelper: true, mvu: true, plugins: {} })
})

test('a plugin counts as usable only when installed, enabled and enabled in status', () => {
  for (const overrides of [
    { installed: false, enabled: true, status: 'enabled' as const },
    { installed: true, enabled: false, status: 'disabled' as const },
    { installed: true, enabled: true, status: 'disabling' as const },
    { installed: true, enabled: true, status: 'enabling' as const },
    { installed: true, enabled: true, status: 'error' as const },
  ]) {
    const runtime = sandboxPluginRuntime(snapshot([view({ ...overrides, id: 'tavern-helper' })]))
    assert.deepEqual(runtime, { revision: 7, tavernHelper: false, mvu: false, plugins: {} }, JSON.stringify(overrides))
  }
})

test('MVU is usable only through Tavern Helper, never alone', () => {
  const runtime = sandboxPluginRuntime(snapshot([
    view({ id: 'tavern-helper', installed: false, enabled: false, status: 'not-installed' }),
    view({ id: 'mvu' }),
  ]))
  assert.deepEqual(runtime, { revision: 7, tavernHelper: false, mvu: false, plugins: {} })
})

test('a running plugin with a manifest row enters the snapshot with its rev-keyed URL', () => {
  const assets: Parameters<typeof sandboxPluginRuntime>[1] = {
    revision: 7,
    plugins: {
      'demo-panel': { rev: '0d3a91c47ba2', client: '/plugins/demo-panel/client.js?rev=0d3a91c47ba2' },
    },
  }
  const runtime = sandboxPluginRuntime(snapshot([
    view({ id: 'tavern-helper' }),
    view({ id: 'mvu', dependencies: ['tavern-helper'] }),
    view({ id: 'demo-panel', dependencies: ['tavern-helper'] }),
  ]), assets)
  assert.deepEqual(runtime?.plugins, {
    'demo-panel': { rev: '0d3a91c47ba2', client: '/plugins/demo-panel/client.js?rev=0d3a91c47ba2' },
  })
})

test('the snapshot is the authority on whether; the manifest only says where', () => {
  const assets: Parameters<typeof sandboxPluginRuntime>[1] = {
    revision: 6,
    plugins: {
      // a row for a plugin the snapshot does not run: dropped, whatever the
      // manifest once served — a frame is never told about a plugin the
      // current snapshot has disabled
      'ghost-panel': { rev: '111111111111', client: '/plugins/ghost-panel/client.js?rev=111111111111' },
    },
  }
  const runtime = sandboxPluginRuntime(snapshot([view({ id: 'tavern-helper' })]), assets)
  assert.deepEqual(runtime?.plugins, {})
})

test('a running plugin without a manifest row is admitted without one', () => {
  const runtime = sandboxPluginRuntime(snapshot([view({ id: 'demo-panel' })]), { revision: 7, plugins: {} })
  assert.deepEqual(runtime?.plugins, {})
})

test('encode and parse round-trip through a metadata attribute', () => {
  const runtime: Parameters<typeof encodeSandboxPluginRuntime>[0] = {
    revision: 12,
    tavernHelper: true,
    mvu: false,
    plugins: { 'demo-panel': { rev: '0d3a91c47ba2', client: '/plugins/demo-panel/client.js?rev=0d3a91c47ba2' } },
  }
  assert.deepEqual(parseSandboxPluginRuntime(encodeSandboxPluginRuntime(runtime)), runtime)
})

test('parse tolerates a legacy meta without the plugins field', () => {
  assert.deepEqual(
    parseSandboxPluginRuntime('{"revision":12,"tavernHelper":true,"mvu":false}'),
    { revision: 12, tavernHelper: true, mvu: false, plugins: {} },
  )
})

test('parse holds a present plugins record to the full contract', () => {
  const bad = [
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":[]}',
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":"demo"}',
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":{"demo":null}}',
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":{"demo":{}}}',
    // rev: wrong length, wrong alphabet
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":{"demo":{"rev":"abc","client":"/plugins/demo/client.js"}}}',
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":{"demo":{"rev":"0D3A91C47BA2","client":"/plugins/demo/client.js"}}}',
    // client: outside the plugin prefix — a frame never learns another URL from a snapshot
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":{"demo":{"rev":"0d3a91c47ba2","client":"https://cdn.example/x.js"}}}',
    '{"revision":7,"tavernHelper":true,"mvu":false,"plugins":{"demo":{"rev":"0d3a91c47ba2","client":"/card-assets/demo/client.js"}}}',
  ]
  for (const value of bad) {
    assert.throws(() => parseSandboxPluginRuntime(value), /invalid|outside/, value)
  }
})

test('parse refuses a frame built without a snapshot', () => {
  for (const value of [null, undefined]) {
    assert.throws(() => parseSandboxPluginRuntime(value), /built without a system-plugin snapshot/)
  }
})

test('parse refuses input that is not a snapshot', () => {
  assert.throws(() => parseSandboxPluginRuntime('nonsense{'), /not valid JSON/)
  assert.throws(() => parseSandboxPluginRuntime(''), /not valid JSON/)
  for (const value of ['7', '[]', '"text"', 'null', '{}']) {
    assert.throws(() => parseSandboxPluginRuntime(value), /invalid shape|built without/)
  }
})

test('parse refuses a snapshot with an out-of-contract shape', () => {
  const cases = [
    '{"revision":-1,"tavernHelper":true,"mvu":true}',
    '{"revision":1.5,"tavernHelper":true,"mvu":false}',
    '{"revision":"7","tavernHelper":true,"mvu":false}',
    '{"revision":7,"tavernHelper":"yes","mvu":false}',
    '{"revision":7,"tavernHelper":true,"mvu":0}',
    '{"revision":7,"tavernHelper":true}',
  ]
  for (const value of cases) {
    assert.throws(() => parseSandboxPluginRuntime(value), /invalid shape/, value)
  }
})

test('parse refuses MVU enabled without Tavern Helper', () => {
  assert.throws(
    () => parseSandboxPluginRuntime('{"revision":7,"tavernHelper":false,"mvu":true}'),
    /MVU cannot be enabled without Tavern Helper/,
  )
})

test('fenceFrameParams attaches the revision to object payloads only', () => {
  assert.deepEqual(fenceFrameParams({ method: 'x' }, 9), { method: 'x', pluginRevision: 9 })
  // Merge, not replace: existing fields survive the fence.
  assert.deepEqual(fenceFrameParams({ a: 1 }, 0), { a: 1, pluginRevision: 0 })
  for (const value of [null, 5, 'text', true, undefined, [1, 2]]) {
    assert.equal(fenceFrameParams(value, 9), value)
  }
})

test('the plugin-asset paths are the literals both sides build URLs from', () => {
  // The host route is mounted at the prefix and answers the manifest path; the
  // frame's plugin tags and the shell's manifest fetch are built from the same
  // two strings. Stated as full literals, not derived from one another in the
  // test, so a change to either contract value is a change this test reports
  // rather than one it follows quietly.
  assert.equal(PLUGIN_ASSET_PREFIX, '/plugins')
  assert.equal(PLUGIN_ASSET_MANIFEST_PATH, '/plugins/manifest.json')
})

test('the aggregate manifest parses when every row is in contract', () => {
  const parsed = parsePluginAssetManifest(JSON.stringify({
    revision: 9,
    plugins: { 'demo-panel': { rev: '0d3a91c47ba2', client: '/plugins/demo-panel/client.js?rev=0d3a91c47ba2' } },
  }))
  assert.notEqual(typeof parsed, 'string')
  if (typeof parsed !== 'string') {
    assert.deepEqual(parsed, {
      revision: 9,
      plugins: { 'demo-panel': { rev: '0d3a91c47ba2', client: '/plugins/demo-panel/client.js?rev=0d3a91c47ba2' } },
    })
  }
})

test('the aggregate manifest parser refuses what the snapshot row parser would', () => {
  const bad: [string, RegExp][] = [
    ['nonsense{', /not valid JSON/],
    ['[]', /not an object/],
    ['"text"', /not an object/],
    ['{"plugins":{}}', /revision/],
    ['{"revision":1.5,"plugins":{}}', /revision/],
    ['{"revision":9}', /plugins record/],
    ['{"revision":9,"plugins":[]}', /plugins record/],
    ['{"revision":9,"plugins":{"demo":1}}', /row for plugin "demo"/],
    ['{"revision":9,"plugins":{"demo":{"rev":"zz","client":"/plugins/demo/client.js"}}}', /invalid rev/],
    ['{"revision":9,"plugins":{"demo":{"rev":"0d3a91c47ba2","client":"https://cdn.example/x.js"}}}', /outside/],
  ]
  for (const [text, pattern] of bad) {
    const parsed = parsePluginAssetManifest(text)
    assert.ok(typeof parsed === 'string' && pattern.test(parsed), text)
  }
})
