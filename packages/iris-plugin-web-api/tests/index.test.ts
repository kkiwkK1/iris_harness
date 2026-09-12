import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'

import {
  DEFAULT_SANDBOX_PLUGIN_RUNTIME,
  PLUGIN_ASSET_MANIFEST_PATH,
  PLUGIN_ASSET_PREFIX,
  SYSTEM_PLUGIN_RUNTIME_META,
  encodeSandboxPluginRuntime,
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
  assert.deepEqual(DEFAULT_SANDBOX_PLUGIN_RUNTIME, { revision: 0, tavernHelper: true, mvu: true })
  assert.equal(Object.isFrozen(DEFAULT_SANDBOX_PLUGIN_RUNTIME), true)
})

test('an absent snapshot reduces to absent capabilities', () => {
  assert.equal(sandboxPluginRuntime(undefined), undefined)
})

test('running built-ins reduce to their capability flags at the snapshot revision', () => {
  const runtime = sandboxPluginRuntime(snapshot([
    view({ id: 'tavern-helper' }),
    view({ id: 'mvu', dependencies: ['tavern-helper'] }),
  ]))
  assert.deepEqual(runtime, { revision: 7, tavernHelper: true, mvu: true })
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
    assert.deepEqual(runtime, { revision: 7, tavernHelper: false, mvu: false }, JSON.stringify(overrides))
  }
})

test('MVU is usable only through Tavern Helper, never alone', () => {
  const runtime = sandboxPluginRuntime(snapshot([
    view({ id: 'tavern-helper', installed: false, enabled: false, status: 'not-installed' }),
    view({ id: 'mvu' }),
  ]))
  assert.deepEqual(runtime, { revision: 7, tavernHelper: false, mvu: false })
})

test('encode and parse round-trip through a metadata attribute', () => {
  const runtime: Parameters<typeof encodeSandboxPluginRuntime>[0] = {
    revision: 12,
    tavernHelper: true,
    mvu: false,
  }
  assert.deepEqual(parseSandboxPluginRuntime(encodeSandboxPluginRuntime(runtime)), runtime)
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
