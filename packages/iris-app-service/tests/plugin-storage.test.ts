/**
 * `scope.storage` — the plugins' private store under `<profile>/plugin-data/`.
 *
 * Two layers are driven here against real bytes. The store layer
 * (`PluginDataStore`) is driven alone, which is what its `isCurrent` predicate
 * being a parameter buys: key grammar, quarantine, both ceilings, isolation,
 * the close. The runtime layer drives `SystemPluginRuntime` and the install
 * service to pin the three shapes the permission gate takes, the write a
 * plugin makes from its own dispose, and the data an uninstall must not
 * touch. Every load-bearing assertion names the mutation that reddens it in
 * `notes/packages/iris-app-service/DEVIATIONS.md` §83's teeth table.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { PluginStorage } from '@iris/plugin-api'
import { writeTree } from '../../iris-extension-installer/tests/fixtures/helpers.ts'

import { AppError } from '../src/errors.ts'
import { SystemPluginInstallService } from '../src/plugins/install.ts'
import { MAX_PLUGIN_STORE_BYTES, MAX_PLUGIN_VALUE_BYTES, PluginDataStore } from '../src/plugins/storage.ts'
import { SystemPluginRuntime, type SystemPluginDefinition } from '../src/system-plugins.ts'

/**
 * The moment every quarantine name in this file carries — injected through
 * the store's `now`, so the assertion can pin the *whole* filename instead of
 * regexing around a timestamp that belongs to the run.
 */
const QUARANTINE_AT = new Date('2026-09-15T10:00:00.000Z')
const QUARANTINE_STAMP = '2026-09-15T10-00-00-000Z'

interface StoreHarness {
  root: string
  store: PluginDataStore
  face: PluginStorage
  problems: string[]
  errors: Error[]
}

async function storeHarness(
  t: TestContext,
  options: { limits?: { valueBytes?: number, storeBytes?: number } } = {},
): Promise<StoreHarness> {
  const root = await mkdtemp(join(tmpdir(), 'iris-plugin-storage-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const problems: string[] = []
  const errors: Error[] = []
  const store = new PluginDataStore({
    root,
    onProblem: message => { problems.push(message) },
    onError: error => { errors.push(error) },
    now: () => QUARANTINE_AT,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  })
  return { root, store, face: store.storageFor('demo', () => true), problems, errors }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`)
    return error.code
  }
  assert.fail('expected the call to be refused')
}

// ---------------------------------------------------------------------------
// The store layer
// ---------------------------------------------------------------------------

test('T1: keys outside the id grammar are refused before a path is built', async (t) => {
  const { root, face } = await storeHarness(t)
  const isInvalidRequest = async (promise: Promise<unknown>): Promise<void> => {
    assert.equal(await codeOf(promise), 'invalid-request')
  }
  // `../x` escapes upward, `C:\x` is drive-absolute on the platform this runs
  // on, `.` is a directory and not a name. The grammar is the first guard and
  // the resolved-prefix containment the second; §83's teeth table records
  // which of the two each mutation exposes (deleting the containment check
  // alone reddens *nothing*, because the grammar refuses all three first).
  let refused = 0
  for (const key of ['../x', 'C:\\x', '.']) {
    await isInvalidRequest(face.set(key, 1))
    await isInvalidRequest(face.get(key))
    await isInvalidRequest(face.delete(key))
    refused += 3
  }
  assert.equal(refused, 9, 'every key must be refused by every writing method')
  // Nothing was created for the refusals to land in: a plugin that only ever
  // typed bad keys leaves no directory behind.
  await assert.rejects(readdir(join(root, 'demo')), /ENOENT/u)
})

test('T2: a damaged key file is quarantined with evidence and the store keeps working', async (t) => {
  const { root, face, problems } = await storeHarness(t)
  const dir = join(root, 'demo')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'counter.json'), '{ this is not json', 'utf8')

  assert.equal(await face.get('counter'), undefined, 'a damaged file answers undefined, like an absent one')
  assert.equal(problems.length, 1, 'the host is told once')
  assert.match(problems[0] ?? '', /could not be read as JSON/u)
  // The original bytes are gone and the evidence is under the pinned
  // quarantine name: not deleted, not left in place to be overwritten.
  assert.deepEqual(await readdir(dir), [`counter.json.corrupt-${QUARANTINE_STAMP}`])

  // The store is not wedged by the quarantine: the next set writes and reads
  // back like nothing happened.
  await face.set('counter', { n: 1 })
  assert.deepEqual(await face.get('counter'), { n: 1 })
})

test('T3: the single-value ceiling refuses with both numbers, and admits the value at it', async (t) => {
  const { face } = await storeHarness(t, { limits: { valueBytes: 16 } })
  await assert.rejects(face.set('big', 'x'.repeat(20)), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'invalid-request')
    assert.match(error.message, /23 bytes/u, 'the size of the refused value')
    assert.match(error.message, /16 bytes/u, 'the ceiling it ran into')
    return true
  })
  // Exactly at the ceiling is not over it.
  await face.set('exact', 'x'.repeat(13))
  assert.equal(await face.get('exact'), 'x'.repeat(13))
})

test('T3b: the ceiling is measured in bytes, which a Chinese value proves', async (t) => {
  const { face } = await storeHarness(t, { limits: { valueBytes: 9 } })
  // Three CJK characters: 12 UTF-8 bytes of serialized text (12 > 9, refused),
  // but only 6 UTF-16 code units (6 ≤ 9, admitted) — the ruler a `.length`
  // mutation leaves behind, which is why this fixture and no ASCII one.
  await assert.rejects(face.set('zh', '龙'.repeat(3)), /9 bytes/u)
})

test('T4: the per-plugin ceiling counts replaces and deletes, and refuses with both numbers', async (t) => {
  const { face } = await storeHarness(t, { limits: { valueBytes: 100, storeBytes: 40 } })
  await face.set('a', 'x'.repeat(10))
  await face.set('b', 'y'.repeat(10))
  await face.set('c', 'z'.repeat(10))
  // 3 × 13 = 39 bytes used; one more 13-byte value would pass it.
  await assert.rejects(face.set('d', 'w'.repeat(10)), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'invalid-request')
    assert.match(error.message, /52 bytes/u, 'what the store would hold')
    assert.match(error.message, /40 bytes/u, 'the ceiling')
    return true
  })
  // Replacing a key is charged for the bytes it releases, not refused for
  // them: the same 13 bytes over the same name changes nothing.
  await face.set('a', 'x'.repeat(10))
  // Deleting frees.
  await face.delete('b')
  await face.set('d', 'w'.repeat(10))
  assert.equal(await face.get('d'), 'w'.repeat(10))
})

test('the shipped ceilings are the ones the documents describe', async () => {
  // Pinned the way `PLUGIN_TREE_LIMITS` is: a seam exists so tests can shrink
  // these, which means only an assertion keeps the shipped numbers honest.
  assert.equal(MAX_PLUGIN_VALUE_BYTES, 1_048_576)
  assert.equal(MAX_PLUGIN_STORE_BYTES, 64 * 1_048_576)
})

test('T6: two plugins with the same key cannot see each other', async (t) => {
  const { root, store } = await storeHarness(t)
  const alpha = store.storageFor('alpha', () => true)
  const beta = store.storageFor('beta', () => true)
  await alpha.set('shared', { who: 'alpha' })
  await beta.set('shared', { who: 'beta' })

  assert.deepEqual(await alpha.get('shared'), { who: 'alpha' })
  assert.deepEqual(await beta.get('shared'), { who: 'beta' })
  assert.deepEqual(await alpha.keys(), ['shared'])
  assert.deepEqual(await beta.keys(), ['shared'])
  // Separate directories on disk, not a shared namespace with polite habits.
  assert.deepEqual([...(await readdir(root))].sort(), ['alpha', 'beta'])
})

test('T8: forbidden keys in a value are refused, nested or not', async (t) => {
  const { face } = await storeHarness(t)
  // Computed keys: a literal `{ __proto__: … }` would set a prototype instead
  // of creating the own property `assertStorable` refuses.
  let refused = 0
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(face.set('evil', { [key]: 1 }), /reserved key/u)
    refused += 1
  }
  // Nested one level, computed form again: the literal spelling
  // `{ __proto__: … }` would try to set a prototype, not create the key.
  await assert.rejects(face.set('evil', { nested: { ['__proto__']: 'deep' } }), /reserved key/u)
  refused += 1
  assert.equal(refused, 4)
  assert.deepEqual(await face.keys(), [], 'a refused value must not leave a file behind')
})

test('T9: keys() reports neither quarantine names nor leftover temporaries', async (t) => {
  const { root, face } = await storeHarness(t)
  const dir = join(root, 'demo')
  await face.set('alpha', 1)
  // A key whose file will not parse: reading it quarantines it, and the
  // quarantine's name must not read back as a key.
  await writeFile(join(dir, 'gone.json'), '{ oops', 'utf8')
  assert.equal(await face.get('gone'), undefined)
  // And one of atomicWriteFile's temporaries, placed the way a crash leaves
  // one: `<key>.json.<pid>.<hex>.tmp`.
  await writeFile(join(dir, 'hand.json.12345.deadbeef.tmp'), 'partial', 'utf8')

  assert.deepEqual(await readdir(dir), [
    'alpha.json',
    `gone.json.corrupt-${QUARANTINE_STAMP}`,
    'hand.json.12345.deadbeef.tmp',
  ])
  assert.deepEqual(await face.keys(), ['alpha'])
})

test('T11: flush lands the queued writes, closes writing, and never closes reading', async (t) => {
  const { store, face } = await storeHarness(t)
  await face.set('a', 1)
  // Enqueued before the flush, so the flush owes its landing.
  const queued = face.set('b', 2)
  const flushing = store.flush()
  // A write arriving while the drain runs is refused — the refusal must be
  // decided at the call, which is why `flush` closes the store *before* it
  // awaits anything.
  let late = 'pending'
  const arriving = face.set('late', 3).then(() => { late = 'kept' }, () => { late = 'refused' })
  await flushing
  await queued
  await arriving

  assert.equal(late, 'refused', 'a write arriving mid-flush is not enqueued behind it')
  assert.deepEqual(await face.get('b'), 2, 'the write queued before the flush landed')
  assert.equal(await face.get('a'), 1)
  assert.deepEqual(await face.keys(), ['a', 'b'], 'reads still answer what is on disk')
  assert.equal(await codeOf(face.set('c', 3)), 'invalid-request')
  assert.equal(await codeOf(face.delete('a')), 'invalid-request')
})

// ---------------------------------------------------------------------------
// The runtime layer: the permission gate, dispose writes, disable
// ---------------------------------------------------------------------------

interface RuntimeHarness {
  dir: string
  runtime: SystemPluginRuntime
  pluginDataRoot: string
}

async function runtimeHarness(
  t: TestContext,
  options: { withRoot?: boolean } = {},
): Promise<RuntimeHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-storage-runtime-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const runtime = new SystemPluginRuntime({
    context: new Context(),
    file: join(dir, 'system-plugins.json'),
    definitions: [],
    defaultEnabled: [],
    ...(options.withRoot === false ? {} : { pluginDataRoot: join(dir, 'plugin-data') }),
  })
  await runtime.initialize()
  t.after(async () => { await runtime.dispose() })
  return { dir, runtime, pluginDataRoot: join(dir, 'plugin-data') }
}

function storerDefinition(
  captured: { storage?: PluginStorage, disposeWrite?: Promise<void> },
  onDispose?: (storage: PluginStorage) => void,
): SystemPluginDefinition {
  return {
    id: 'storer',
    name: 'Storer',
    description: 'captures its storage face',
    version: '1.0.0',
    apiVersion: 1,
    dependencies: [],
    activate(scope) {
      captured.storage = scope.storage
      if (onDispose === undefined) return
      return () => { onDispose(scope.storage) }
    },
  }
}

async function adoptAndEnable(harness: RuntimeHarness, definition: SystemPluginDefinition, permissions: readonly string[]): Promise<void> {
  harness.runtime.adoptDefinition(definition, { installed: true, permissions: [...permissions] })
  await harness.runtime.enable(definition.id)
}

test('T5: an undeclared permission is refused by name, on every method', async (t) => {
  const harness = await runtimeHarness(t)
  const captured: { storage?: PluginStorage } = {}
  await adoptAndEnable(harness, storerDefinition(captured), [])
  assert.ok(captured.storage !== undefined, 'the member is present even when refused')

  let tried = 0
  for (const attempt of [
    captured.storage.get('counter'),
    captured.storage.set('counter', 1),
    captured.storage.delete('counter'),
    captured.storage.keys(),
  ]) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'invalid-request')
      assert.match(error.message, /did not declare the "plugin-storage" permission/u)
      return true
    })
    tried += 1
  }
  assert.equal(tried, 4, 'all four methods answer the same named refusal')
})

test('a declared plugin gets the real store, and a host with no root refuses as internal', async (t) => {
  const harness = await runtimeHarness(t)
  const captured: { storage?: PluginStorage } = {}
  await adoptAndEnable(harness, storerDefinition(captured), ['plugin-storage'])
  await captured.storage!.set('counter', { n: 1 })
  assert.deepEqual(await captured.storage!.get('counter'), { n: 1 })
  assert.deepEqual(await captured.storage!.keys(), ['counter'])

  // A builtin declares all of it — it is this repository's own source — so the
  // same runtime hands a builtin a working store without any manifest.
  // The no-root runtime, a lifecycle test's shape, refuses with `internal`:
  // the wiring is missing, which is the host's fault and not the plugin's.
  const bare = await runtimeHarness(t, { withRoot: false })
  const builtinCaptured: { storage?: PluginStorage } = {}
  const builtin = storerDefinition(builtinCaptured)
  bare.runtime.adoptDefinition(builtin, { installed: true })
  await bare.runtime.enable(builtin.id)
  let tried = 0
  for (const attempt of [
    builtinCaptured.storage!.get('k'),
    builtinCaptured.storage!.set('k', 1),
    builtinCaptured.storage!.delete('k'),
    builtinCaptured.storage!.keys(),
  ]) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'internal')
      assert.match(error.message, /has no plugin data root/u)
      return true
    })
    tried += 1
  }
  assert.equal(tried, 4)
})

test('T10: a write from the plugin\'s own dispose lands', async (t) => {
  const harness = await runtimeHarness(t)
  const captured: { storage?: PluginStorage, disposeWrite?: Promise<void> } = {}
  await adoptAndEnable(harness, storerDefinition(captured, storage => {
    // The one save a plugin cannot make at any other moment: its last words,
    // written while its own activation is already past `enabled` and being
    // disposed.
    captured.disposeWrite = storage.set('final', 'from-dispose')
  }), ['plugin-storage'])

  await captured.storage!.set('live', 'before-disable')
  await harness.runtime.disable('storer')

  assert.ok(captured.disposeWrite !== undefined)
  // Resolves, not rejects: the dispose ran while its activation was still the
  // catalog row's current one.
  await captured.disposeWrite
  const text = await readFile(join(harness.pluginDataRoot, 'storer', 'final.json'), 'utf8')
  assert.match(text, /from-dispose/u)
})

test('T12: after the disable completes, a write is refused as unsupported, not invalid-request', async (t) => {
  const harness = await runtimeHarness(t)
  const captured: { storage?: PluginStorage } = {}
  await adoptAndEnable(harness, storerDefinition(captured), ['plugin-storage'])
  await harness.runtime.disable('storer')

  await assert.rejects(captured.storage!.set('late', 1), (error: unknown) => {
    assert.ok(error instanceof AppError)
    // The *kind* is the assertion: `unsupported` is the runtime's own
    // vocabulary for a stale incarnation; `invalid-request` would say the
    // request was malformed, which it was not.
    assert.equal(error.code, 'unsupported')
    return true
  })
  // Reads keep answering: they cannot make the plugin believe it saved.
  assert.deepEqual(await captured.storage!.keys(), [])
})

// ---------------------------------------------------------------------------
// The install layer: uninstall keeps the data
// ---------------------------------------------------------------------------

test('T7: uninstall removes the plugin and not one byte of its data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-storage-install-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const runtime = new SystemPluginRuntime({
    context: new Context(),
    file: join(dir, 'system-plugins.json'),
    definitions: [],
    defaultEnabled: [],
    pluginDataRoot: join(dir, 'plugin-data'),
  })
  await runtime.initialize()
  t.after(async () => { await runtime.dispose() })
  const installer = new SystemPluginInstallService({
    runtime,
    installRoot: join(dir, 'system-plugins'),
    clientAssetRoot: join(dir, 'assets', 'system-plugins'),
  })
  await installer.scanInstalled()

  const pluginDir = join(dir, 'dev-tree')
  const host = [
    'export default {',
    `  id: 'demo-plugin',`,
    `  name: 'Demo Plugin',`,
    `  description: 'A storage fixture plugin.',`,
    `  version: '1.0.0',`,
    `  apiVersion: 1,`,
    `  dependencies: [],`,
    `  async activate(scope) {`,
    `    const before = await scope.storage.get('counter')`,
    `    const n = (before === undefined || before === null ? 0 : before.n) + 1`,
    `    await scope.storage.set('counter', { n })`,
    `    return () => {}`,
    `  },`,
    `}`,
    '',
  ].join('\n')
  const manifest = {
    name: 'iris-plugin-demo',
    version: '1.0.0',
    type: 'module',
    iris: {
      plugin: {
        id: 'demo-plugin',
        apiVersion: 1,
        host: 'host.js',
        displayName: 'Demo Plugin',
        description: 'A storage fixture plugin.',
        capabilities: ['demo.state'],
        permissions: ['plugin-storage'],
        dependencies: [],
      },
    },
  }
  await writeTree(pluginDir, new Map<string, string>([
    ['package.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['host.js', host],
    ['README.md', '# demo plugin\n'],
  ]))

  const preview = await installer.preview({ kind: 'dev', path: pluginDir })
  await installer.confirm({
    previewToken: preview.previewToken,
    id: preview.id,
    commit: preview.commit ?? null,
    treeHash: preview.treeHash,
  })
  await runtime.enable('demo-plugin')

  const dataDir = join(dir, 'plugin-data', 'demo-plugin')
  const counter = JSON.parse(await readFile(join(dataDir, 'counter.json'), 'utf8')) as { n: number }
  assert.equal(counter.n, 1, 'activate wrote through the declared storage face')

  const before = await Promise.all((await readdir(dataDir)).map(async name => ({
    name,
    bytes: await readFile(join(dataDir, name)),
  })))
  await installer.uninstall('demo-plugin')
  const after = await Promise.all((await readdir(dataDir)).map(async name => ({
    name,
    bytes: await readFile(join(dataDir, name)),
  })))
  assert.deepEqual(after, before, 'uninstall did not touch one byte of the data directory')
  assert.equal(runtime.snapshot().plugins.some(plugin => plugin.id === 'demo-plugin'), false)
})
