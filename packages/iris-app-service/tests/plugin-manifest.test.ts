import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Installer } from '@iris/extension-installer'
import { PLUGIN_COPY_LIMITS } from '@iris/text'

import {
  auditPluginCopy,
  checkPluginApiVersion,
  parsePluginManifest,
  parsePluginManifestValue,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_PERMISSIONS,
  PluginManifestError,
  SUPPORTED_PLUGIN_API_RANGE,
  SYSTEM_PLUGIN_ARTIFACT_CONTRACT,
  type PluginManifestResult,
} from '../src/plugins/manifest.ts'

/**
 * The system-plugin manifest contract (`docs/SYSTEM-PLUGIN-INSTALL.md` §3),
 * and the two security invariants that live in it: §9 #7 (path containment)
 * and §9 #10 (no symlink on the way to an entry).
 *
 * Every refusal is asserted by its **field**, not by its message. The field is
 * the part a consent page renders and the part a plugin author acts on; a test
 * that matched messages would stay green through a rename of the thing the
 * user is told to fix.
 */

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'iris-plugin-manifest-'))
}

/** A package.json object that parses clean, with one field overridden per case. */
function validPackage(overrides: Record<string, unknown> = {}, pluginOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'iris-plugin-demo',
    version: '0.3.1',
    iris: {
      plugin: {
        id: 'demo',
        apiVersion: 1,
        host: 'host.js',
        client: 'client.js',
        displayName: 'Demo',
        description: 'A demo system plugin.',
        capabilities: ['demo.state'],
        permissions: ['provide-capability', 'register-rpc'],
        dependencies: ['tavern-helper'],
        ...pluginOverrides,
      },
    },
    ...overrides,
  }
}

/** Writes a package tree: the manifest plus `host.js` and `client.js`. */
async function writePackage(dir: string, pkg: unknown, extra: Map<string, string> = new Map()): Promise<string> {
  await fsp.mkdir(dir, { recursive: true })
  if (pkg !== undefined) {
    await fsp.writeFile(path.join(dir, PLUGIN_MANIFEST_FILE), typeof pkg === 'string' ? pkg : JSON.stringify(pkg, null, 2))
  }
  await fsp.writeFile(path.join(dir, 'host.js'), 'export default {}\n')
  await fsp.writeFile(path.join(dir, 'client.js'), 'globalThis.demo = 1\n')
  for (const [rel, data] of extra) {
    const target = path.join(dir, ...rel.split('/'))
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
  }
  return dir
}

function field(result: PluginManifestResult): string {
  assert.equal(result.ok, false, 'expected a refusal')
  return result.ok ? '' : result.field
}

// --- the shape half: one case per manifest-invalid field --------------------

test('every manifest-invalid result names the field, one case per field spelling', () => {
  const cases: { field: string; value: unknown; note: string }[] = [
    { field: PLUGIN_MANIFEST_FILE, value: null, note: 'the whole file is not an object' },
    { field: PLUGIN_MANIFEST_FILE, value: [1, 2], note: 'an array is not a package.json' },
    { field: 'version', value: validPackage({ version: undefined }), note: '§5.1 shows the version beside the commit' },
    { field: 'version', value: validPackage({ version: '' }), note: 'empty is not a version' },
    { field: 'iris', value: validPackage({ iris: undefined }), note: 'a package with no iris block' },
    { field: 'iris', value: validPackage({ iris: 'plugin' }), note: 'iris is not an object' },
    { field: 'iris.plugin', value: { name: 'x', version: '1.0.0', iris: {} }, note: 'an iris block with no plugin block' },
    { field: 'iris.plugin', value: { name: 'x', version: '1.0.0', iris: { plugin: [] } }, note: 'the plugin block is an array' },
    { field: 'id', value: validPackage({}, { id: 'Demo' }), note: 'uppercase: the id is a directory name' },
    { field: 'id', value: validPackage({}, { id: 'a'.repeat(65) }), note: '65 characters is one past the installer grammar' },
    { field: 'id', value: validPackage({}, { id: '-demo' }), note: 'must start alphanumeric' },
    { field: 'id', value: validPackage({}, { id: 1 }), note: 'not a string' },
    { field: 'apiVersion', value: validPackage({}, { apiVersion: undefined }), note: 'required' },
    { field: 'apiVersion', value: validPackage({}, { apiVersion: '1' }), note: 'a bare major names half the compared value' },
    { field: 'apiVersion', value: validPackage({}, { apiVersion: '01.0' }), note: 'leading zeros give one version two spellings' },
    { field: 'apiVersion', value: validPackage({}, { apiVersion: 'latest' }), note: 'not semver-ish at all' },
    { field: 'apiVersion', value: validPackage({}, { apiVersion: 1.5 }), note: 'a non-integer number' },
    { field: 'apiVersion', value: validPackage({}, { apiVersion: -1 }), note: 'a negative integer' },
    { field: 'host', value: validPackage({}, { host: undefined }), note: 'required' },
    { field: 'host', value: validPackage({}, { host: '' }), note: 'empty' },
    { field: 'client', value: validPackage({}, { client: 12 }), note: 'optional, but typed when present' },
    { field: 'i18n', value: validPackage({}, { i18n: 'copy' }), note: 'the copy block is an object of two tables' },
    { field: 'i18n.en', value: validPackage({}, { i18n: { zh: 'i18n/zh.json' } }), note: 'U5 ruling 1: once present, both languages, the missing one named' },
    { field: 'i18n.zh', value: validPackage({}, { i18n: { en: 'i18n/en.json' } }), note: 'U5 ruling 1, the other column' },
    { field: 'i18n.en', value: validPackage({}, { i18n: { en: '../escape.json', zh: 'zh.json' } }), note: 'copy paths follow the host/client grammar' },
    { field: 'i18n.zh', value: validPackage({}, { i18n: { en: 'en.json', zh: 'C:/abs/zh.json' } }), note: 'absolute copy paths refused' },
    { field: 'displayName', value: validPackage({}, { displayName: undefined }), note: 'the consent page needs a name' },
    { field: 'description', value: validPackage({}, { description: '   ' }), note: 'whitespace is not a description' },
    { field: 'capabilities', value: validPackage({}, { capabilities: 'demo.state' }), note: 'a list, not a string' },
    { field: 'capabilities[1]', value: validPackage({}, { capabilities: ['a', 7] }), note: 'entry type, indexed' },
    { field: 'capabilities[0]', value: validPackage({}, { capabilities: [''] }), note: 'an empty capability name' },
    { field: 'permissions', value: validPackage({}, { permissions: 'register-rpc' }), note: 'a list, not a string' },
    { field: 'permissions[1]', value: validPackage({}, { permissions: ['provide-capability', 'network'] }), note: 'unknown name: the closed vocabulary' },
    { field: 'permissions[1]', value: validPackage({}, { permissions: ['register-rpc', 'registerRpc'] }), note: 'a spelling the host can catch' },
    { field: 'permissions[1]', value: validPackage({}, { permissions: ['register-rpc', 'register-rpc'] }), note: 'declared twice' },
    { field: 'permissions[0]', value: validPackage({}, { permissions: [null] }), note: 'entry type, indexed' },
    { field: 'dependencies', value: validPackage({}, { dependencies: { 'tavern-helper': true } }), note: 'a list, not a map' },
    { field: 'dependencies[0]', value: validPackage({}, { dependencies: ['Tavern Helper'] }), note: 'a dependency is a plugin id' },
  ]

  const compared: string[] = []
  for (const testCase of cases) {
    const result = parsePluginManifestValue(testCase.value)
    assert.equal(result.ok, false, `${testCase.note}: expected a refusal`)
    if (result.ok) continue
    assert.equal(result.state, 'manifest-invalid', testCase.note)
    assert.equal(result.field, testCase.field, testCase.note)
    assert.notEqual(result.reason, '', `${testCase.note}: a named field with no reason is half a refusal`)
    compared.push(testCase.field)
  }
  // The loop must have compared every case, not skipped into green.
  assert.equal(compared.length, cases.length)
  assert.ok(cases.length >= 30, `expected the field table to stay exhaustive, compared ${String(cases.length)}`)
  // And every distinct field spelling the parser can emit is represented.
  assert.deepEqual(
    [...new Set(compared)].sort(),
    [
      'apiVersion', 'capabilities', 'capabilities[0]', 'capabilities[1]', 'client',
      'dependencies', 'dependencies[0]', 'description', 'displayName', 'host',
      'i18n', 'i18n.en', 'i18n.zh',
      'id', 'iris', 'iris.plugin', 'package.json', 'permissions', 'permissions[0]',
      'permissions[1]', 'version',
    ],
  )
})

test('a fully valid manifest parses into the declared shape', async () => {
  const dir = await writePackage(path.join(await tempRoot(), 'pkg'), validPackage())
  const result = await parsePluginManifest(dir)
  assert.equal(result.ok, true, result.ok ? '' : `${result.field}: ${result.reason}`)
  if (!result.ok) return
  assert.deepEqual(result.manifest, {
    id: 'demo',
    apiVersion: '1.0',
    apiVersionParts: { major: 1, minor: 0 },
    host: 'host.js',
    client: 'client.js',
    displayName: 'Demo',
    description: 'A demo system plugin.',
    version: '0.3.1',
    capabilities: ['demo.state'],
    permissions: ['provide-capability', 'register-rpc'],
    dependencies: ['tavern-helper'],
  })
})

test('the optional lists default to empty and client stays absent', () => {
  const result = parsePluginManifestValue({
    name: 'x',
    version: '1.0.0',
    iris: { plugin: { id: 'demo', apiVersion: '1.0', host: 'host.js', displayName: 'D', description: 'd' } },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.manifest.capabilities, [])
  assert.deepEqual(result.manifest.permissions, [])
  assert.deepEqual(result.manifest.dependencies, [])
  assert.equal('client' in result.manifest, false, 'an absent client is absent, not undefined')
})

// --- path containment: invariant #7 ----------------------------------------

test('host and client must be relative in-tree paths (§9 #7)', async () => {
  const root = await tempRoot()
  const outside = path.join(root, 'outside.js')
  await fsp.writeFile(outside, 'export default {}\n')

  const hostile = [
    '../outside.js',
    '../../outside.js',
    'a/../../outside.js',
    '/etc/passwd',
    '/abs.js',
    'C:\\x.js',
    'C:/x.js',
    'dist\\index.js',
    './host.js',
    'dist/',
    '/',
    'sub/../host.js',
  ]
  let compared = 0
  for (const entry of hostile) {
    const dir = await writePackage(path.join(root, `case-${String(compared)}`), validPackage({}, { host: entry }), new Map([['sub/keep.txt', 'x']]))
    const result = await parsePluginManifest(dir)
    assert.equal(result.ok, false, `host ${JSON.stringify(entry)} must be refused`)
    if (result.ok) continue
    assert.equal(result.state, 'manifest-invalid', entry)
    assert.equal(result.field, 'host', entry)
    compared++
  }
  assert.equal(compared, hostile.length)
  assert.ok(hostile.length >= 12, `expected the containment table to stay wide, compared ${String(hostile.length)}`)

  // The same grammar applies to client, which is the optional one and
  // therefore the one an implementation is likeliest to forget.
  const clientDir = await writePackage(path.join(root, 'client-case'), validPackage({}, { client: '../outside.js' }))
  assert.equal(field(await parsePluginManifest(clientDir)), 'client')
})

test('an entry that does not exist, or is a directory, is refused', async () => {
  const root = await tempRoot()
  const missing = await writePackage(path.join(root, 'missing'), validPackage({}, { host: 'dist/index.js' }))
  assert.equal(field(await parsePluginManifest(missing)), 'host')

  const dirEntry = await writePackage(path.join(root, 'dir'), validPackage({}, { host: 'dist' }), new Map([['dist/index.js', 'x']]))
  const asDir = await parsePluginManifest(dirEntry)
  assert.equal(field(asDir), 'host')
  assert.match(asDir.ok ? '' : asDir.reason, /not a regular file/u)

  const throughFile = await writePackage(path.join(root, 'through'), validPackage({}, { host: 'host.js/inner.js' }))
  const walked = await parsePluginManifest(throughFile)
  assert.equal(field(walked), 'host')
  assert.match(walked.ok ? '' : walked.reason, /non-directory/u)
})

// --- symlinks: invariant #10 ------------------------------------------------

test('an entry reached through a symlink or junction is refused (§9 #10)', async () => {
  const root = await tempRoot()

  // A junction/symlink as an intermediate directory: `lstat` of the full path
  // would follow it, so the check walks every component. This case is the one
  // that runs everywhere — a directory junction needs no privilege on Windows.
  const real = path.join(root, 'real-dir')
  await fsp.mkdir(real, { recursive: true })
  await fsp.writeFile(path.join(real, 'host.js'), 'export default {}\n')
  const viaDir = await writePackage(path.join(root, 'via-dir'), validPackage({}, { host: 'linked/host.js' }))
  await fsp.symlink(real, path.join(viaDir, 'linked'), 'junction').catch(() => {})
  const linkedStat = await fsp.lstat(path.join(viaDir, 'linked')).catch(() => null)
  assert.ok(linkedStat?.isSymbolicLink(), 'the fixture must actually be a link, or it proves nothing')
  const viaDirResult = await parsePluginManifest(viaDir)
  assert.equal(field(viaDirResult), 'host')
  assert.match(viaDirResult.ok ? '' : viaDirResult.reason, /symlink\/junction/u)

  // A symlinked `host.js` itself. File symlinks need Developer Mode or
  // elevation on Windows, so the case is asserted only when the fixture took.
  const viaFile = await writePackage(path.join(root, 'via-file'), validPackage({}, { host: 'entry.js' }))
  await fsp.symlink(path.join(real, 'host.js'), path.join(viaFile, 'entry.js'), 'file').catch(() => {})
  const entryStat = await fsp.lstat(path.join(viaFile, 'entry.js')).catch(() => null)
  if (entryStat?.isSymbolicLink() === true) {
    const viaFileResult = await parsePluginManifest(viaFile)
    assert.equal(field(viaFileResult), 'host')
    assert.match(viaFileResult.ok ? '' : viaFileResult.reason, /symlink\/junction/u)
  }
})

// --- apiVersion and the supported range ------------------------------------

test('apiVersion outside the host range is incompatible, not manifest-invalid', async () => {
  const root = await tempRoot()
  const outOfRange = ['2.0', '0.9', '1.1', '11.0', '2.0.0-alpha.1']
  let compared = 0
  for (const declared of outOfRange) {
    const dir = await writePackage(path.join(root, `v-${String(compared)}`), validPackage({}, { apiVersion: declared }))
    const result = await parsePluginManifest(dir)
    assert.equal(result.ok, false, declared)
    if (result.ok) continue
    assert.equal(result.state, 'incompatible', `${declared} is well-formed; it is this host that cannot run it`)
    assert.equal(result.field, 'apiVersion')
    assert.equal(result.declared, declared)
    assert.equal(result.supported, `${SUPPORTED_PLUGIN_API_RANGE.min}–${SUPPORTED_PLUGIN_API_RANGE.max}`)
    // It carries the manifest: the row and the consent page still name the plugin.
    assert.equal(result.manifest.displayName, 'Demo')
    compared++
  }
  assert.equal(compared, outOfRange.length)

  const inRange = [1, '1.0', '1.0.0', '1.0.7', '1.0.0-alpha.3']
  let accepted = 0
  for (const declared of inRange) {
    const dir = await writePackage(path.join(root, `ok-${String(accepted)}`), validPackage({}, { apiVersion: declared }))
    const result = await parsePluginManifest(dir)
    assert.equal(result.ok, true, `${String(declared)} is in range: ${result.ok ? '' : result.reason}`)
    accepted++
  }
  assert.equal(accepted, inRange.length)
  assert.ok(outOfRange.length + inRange.length >= 10, 'the range table stays on both sides of every bound')
})

test('the range check is separable from the parse', () => {
  const parsed = parsePluginManifestValue(validPackage({}, { apiVersion: '2.0' }))
  assert.equal(parsed.ok, true, 'a well-formed manifest parses; compatibility is a second question')
  if (!parsed.ok) return
  const verdict = checkPluginApiVersion(parsed.manifest)
  assert.equal(verdict?.state, 'incompatible')
  const inRange = parsePluginManifestValue(validPackage({}, { apiVersion: '1.0' }))
  assert.equal(inRange.ok, true)
  if (!inRange.ok) return
  assert.equal(checkPluginApiVersion(inRange.manifest), null)
})

test('a malformed field beats an out-of-range version', async () => {
  // Order is observable: a host that cannot read a field has not earned an
  // opinion about the version.
  const dir = await writePackage(path.join(await tempRoot(), 'both'), validPackage({}, { apiVersion: '9.0', id: 'NOPE' }))
  const result = await parsePluginManifest(dir)
  assert.equal(result.ok, false)
  assert.equal(result.ok ? '' : result.state, 'manifest-invalid')
  assert.equal(field(result), 'id')
})

// --- the permission vocabulary ---------------------------------------------

test('the permission vocabulary covers what the activation scope hands over', async () => {
  const scopeSource = await fsp.readFile(
    fileURLToPath(new URL('../../iris-plugin-api/src/index.ts', import.meta.url)),
    'utf8',
  )
  const start = scopeSource.indexOf('export interface SystemPluginActivationScope {')
  assert.notEqual(start, -1, 'the scope interface must still be findable by name')
  const body = scopeSource.slice(start, scopeSource.indexOf('\n}', start))
  const members = new Set<string>()
  for (const match of body.matchAll(/^ {2}(?:readonly )?([A-Za-z][A-Za-z0-9]*)[<(:]/gmu)) {
    members.add(match[1] as string)
  }
  // The floor: a regex that matched nothing would agree with every mapping.
  assert.ok(members.size >= 6, `expected the scope's members, found ${[...members].join(', ')}`)

  // Each permission names one scope member; the members with no permission are
  // the activation's own identity, which is not something it reaches with.
  const mapping: Record<string, string> = {
    'provide-capability': 'provide',
    'get-dependency': 'getDependency',
    'register-rpc': 'registerRpc',
    'host-context': 'context',
    'write-variables': 'variables',
  }
  const identityOnly = new Set(['pluginId', 'revision'])
  assert.deepEqual([...PLUGIN_PERMISSIONS].sort(), Object.keys(mapping).sort())
  for (const [permission, member] of Object.entries(mapping)) {
    assert.ok(members.has(member), `permission ${permission} names a scope member that no longer exists: ${member}`)
  }
  const mapped = new Set(Object.values(mapping))
  const unmapped = [...members].filter(member => !mapped.has(member) && !identityOnly.has(member))
  assert.deepEqual(unmapped, [], 'a scope member gained without a permission name would ship an undeclarable capability')
})

test('the vocabulary is accepted in full, and only in full', () => {
  const all = parsePluginManifestValue(validPackage({}, { permissions: [...PLUGIN_PERMISSIONS] }))
  assert.equal(all.ok, true, all.ok ? '' : all.reason)
  if (all.ok) assert.deepEqual([...all.manifest.permissions], [...PLUGIN_PERMISSIONS])

  // Every name, one at a time, mutated by a plausible misspelling.
  let compared = 0
  for (const permission of PLUGIN_PERMISSIONS) {
    const misspelled = permission.replace(/-/u, '')
    const result = parsePluginManifestValue(validPackage({}, { permissions: [misspelled] }))
    assert.equal(field(result), 'permissions[0]', misspelled)
    compared++
  }
  assert.equal(compared, PLUGIN_PERMISSIONS.length)
  assert.ok(PLUGIN_PERMISSIONS.length >= 4, `expected the vocabulary, got ${String(PLUGIN_PERMISSIONS.length)}`)
})

// --- the installer seam, with the real contract -----------------------------

test('the system-plugin contract installs a plugin tree and refuses an ST one', async () => {
  const root = await tempRoot()
  const pkg = await writePackage(path.join(root, 'plugin-tree'), validPackage())

  const installer = await Installer.create(path.join(root, 'store'))
  const result = await installer.installAs('demo', { kind: 'local-directory', directoryPath: pkg }, {
    artifactContract: SYSTEM_PLUGIN_ARTIFACT_CONTRACT,
  })
  assert.equal((await installer.readLock('demo'))?.enabled, false, 'installing is not enabling')
  assert.ok(await fsp.lstat(path.join(result.targetPath, 'host.js')).then(s => s.isFile()))

  // The same tree under the default (ST) contract is refused: no manifest.json.
  const stStore = await Installer.create(path.join(root, 'st-store'))
  await assert.rejects(stStore.installAs('demo', { kind: 'local-directory', directoryPath: pkg }), /manifest/u)

  // And an ST tree under the plugin contract is refused by field, through the
  // installer's exception-shaped boundary.
  const stTree = path.join(root, 'st-tree')
  await fsp.mkdir(stTree, { recursive: true })
  await fsp.writeFile(path.join(stTree, 'manifest.json'), JSON.stringify({ display_name: 'Demo', js: 'index.js' }))
  await fsp.writeFile(path.join(stTree, 'index.js'), 'export {}\n')
  const pluginStore = await Installer.create(path.join(root, 'plugin-store'))
  await assert.rejects(
    pluginStore.installAs('demo', { kind: 'local-directory', directoryPath: stTree }, { artifactContract: SYSTEM_PLUGIN_ARTIFACT_CONTRACT }),
    (err: unknown) => err instanceof PluginManifestError && err.state === 'manifest-invalid' && err.field === PLUGIN_MANIFEST_FILE,
  )
  assert.deepEqual(await fsp.readdir(path.join(root, 'plugin-store', 'installed')), [])
})

// --- bundled copy: the manifest half and the content audit ------------------

/** A package whose copy block names the conventional table paths. */
function withCopy(i18nOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validPackage({}, {
    i18n: { en: 'i18n/en.json', zh: 'i18n/zh.json', ...i18nOverrides },
  })
}

async function writeCopyPackage(root: string, en: unknown, zh: unknown): Promise<string> {
  const extra = new Map<string, string>()
  if (en !== undefined) extra.set('i18n/en.json', typeof en === 'string' ? en : JSON.stringify(en))
  if (zh !== undefined) extra.set('i18n/zh.json', typeof zh === 'string' ? zh : JSON.stringify(zh))
  return await writePackage(path.join(root, 'pkg'), withCopy(), extra)
}

test('the i18n entries go through the same filesystem half as host and client', async () => {
  const root = await tempRoot()
  const missingEn = await writePackage(
    path.join(root, 'missing-en'),
    withCopy(),
    new Map([['i18n/zh.json', JSON.stringify({ greeting: '你好' })]]),
  )
  assert.equal(field(await parsePluginManifest(missingEn)), 'i18n.en')

  const missingZh = await writePackage(
    path.join(root, 'missing-zh'),
    withCopy(),
    new Map([['i18n/en.json', JSON.stringify({ greeting: 'hello' })]]),
  )
  assert.equal(field(await parsePluginManifest(missingZh)), 'i18n.zh')

  const dirEntry = await writePackage(
    path.join(root, 'dir'),
    withCopy(),
    new Map([
      ['i18n/en.json', JSON.stringify({ greeting: 'hello' })],
      ['i18n/zh.json/nested.js', 'x'],
    ]),
  )
  const asDir = await parsePluginManifest(dirEntry)
  assert.equal(field(asDir), 'i18n.zh')
  assert.match(asDir.ok ? '' : asDir.reason, /not a regular file/u)
})

test('clean two-column copy audits to the total string count', async () => {
  const dir = await writeCopyPackage(
    path.join(await tempRoot(), 'clean'),
    { greeting: 'hello {name}', send: 'Send' },
    { greeting: '你好，{name}', send: '发送' },
  )
  const parsed = await parsePluginManifest(dir)
  assert.equal(parsed.ok, true, parsed.ok ? '' : `${parsed.field}: ${parsed.reason}`)
  if (!parsed.ok) return
  const audit = await auditPluginCopy(dir, parsed.manifest)
  assert.deepEqual(audit, { ok: true, keys: 4 })
})

test('the content audit refuses placeholder drift, naming the key (U5 T2)', async () => {
  const dir = await writeCopyPackage(
    path.join(await tempRoot(), 'drift'),
    { greeting: 'hello {name}' },
    { greeting: '你好' },
  )
  const parsed = await parsePluginManifest(dir)
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const audit = await auditPluginCopy(dir, parsed.manifest)
  assert.equal(audit.ok, false)
  if (audit.ok) return
  assert.equal(audit.field, 'i18n.zh.greeting', 'the refusal points at the key, not just the column')
  assert.match(audit.reason, /placeholder drift on "greeting"/u)
})

test('the content audit refuses an all-English zh column (U5 T3)', async () => {
  const dir = await writeCopyPackage(
    path.join(await tempRoot(), 'english'),
    { greeting: 'hello' },
    { greeting: 'hello' },
  )
  const parsed = await parsePluginManifest(dir)
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const audit = await auditPluginCopy(dir, parsed.manifest)
  assert.equal(audit.ok, false)
  if (audit.ok) return
  assert.equal(audit.field, 'i18n.zh.greeting')
  assert.match(audit.reason, /has no Chinese/u)
})

test('the content audit refuses a broken table: bad JSON, wrong type, bad key', async () => {
  const root = await tempRoot()
  const brokenJson = await writePackage(
    path.join(root, 'json'),
    withCopy(),
    new Map([['i18n/en.json', '{"greeting": '], ['i18n/zh.json', JSON.stringify({ greeting: '你好' })]]),
  )
  const jsonParsed = await parsePluginManifest(brokenJson)
  assert.ok(jsonParsed.ok)
  if (!jsonParsed.ok) return
  const jsonAudit = await auditPluginCopy(brokenJson, jsonParsed.manifest)
  assert.equal(jsonAudit.ok, false)
  if (!jsonAudit.ok) {
    assert.equal(jsonAudit.field, 'i18n.en')
    assert.match(jsonAudit.reason, /not valid JSON/u)
  }

  const arrayTable = await writeCopyPackage(
    path.join(root, 'array'),
    { greeting: 'hello' },
    JSON.stringify(['你好']),
  )
  const arrayParsed = await parsePluginManifest(arrayTable)
  assert.ok(arrayParsed.ok)
  if (!arrayParsed.ok) return
  const arrayAudit = await auditPluginCopy(arrayTable, arrayParsed.manifest)
  assert.equal(arrayAudit.ok, false)
  if (!arrayAudit.ok) {
    assert.equal(arrayAudit.field, 'i18n.zh')
    assert.match(arrayAudit.reason, /expected a JSON object/u)
  }

  const badKey = await writeCopyPackage(
    path.join(root, 'key'),
    { '1bad': 'one bad' },
    { greeting: '你好' },
  )
  const keyParsed = await parsePluginManifest(badKey)
  assert.ok(keyParsed.ok)
  if (!keyParsed.ok) return
  const keyAudit = await auditPluginCopy(badKey, keyParsed.manifest)
  assert.equal(keyAudit.ok, false)
  if (!keyAudit.ok) {
    assert.equal(keyAudit.field, 'i18n.en.1bad')
    assert.match(keyAudit.reason, /does not match/u)
  }
})

test('the copy ceilings are overridable so the refusals are reachable (U5 T12)', async () => {
  const dir = await writeCopyPackage(
    path.join(await tempRoot(), 'limits'),
    { greeting: 'hello', send: 'send' },
    { greeting: '你好', send: '发送' },
  )
  const parsed = await parsePluginManifest(dir)
  assert.ok(parsed.ok)
  if (!parsed.ok) return

  const byKeys = await auditPluginCopy(dir, parsed.manifest, { ...PLUGIN_COPY_LIMITS, maxKeys: 1 })
  assert.equal(byKeys.ok, false)
  if (!byKeys.ok) {
    assert.equal(byKeys.field, 'i18n.en', 'the ceiling names the column')
    assert.match(byKeys.reason, /over the 1-string limit/u)
  }

  const byBytes = await auditPluginCopy(dir, parsed.manifest, { ...PLUGIN_COPY_LIMITS, maxBytes: 10 })
  assert.equal(byBytes.ok, false)
  if (!byBytes.ok) {
    assert.equal(byBytes.field, 'i18n.en')
    assert.match(byBytes.reason, /-byte limit/u)
  }
})

test('the artifact contract refuses drifting copy before anything is hashed', async () => {
  const root = await tempRoot()
  const pkg = await writeCopyPackage(
    path.join(root, 'pkg'),
    { greeting: 'hello {name}' },
    { greeting: '你好' },
  )
  const installer = await Installer.create(path.join(root, 'store'))
  await assert.rejects(
    installer.installAs('demo', { kind: 'local-directory', directoryPath: pkg }, { artifactContract: SYSTEM_PLUGIN_ARTIFACT_CONTRACT }),
    (err: unknown) => err instanceof PluginManifestError && err.state === 'manifest-invalid' && err.field === 'i18n.zh.greeting',
  )
  assert.deepEqual(await fsp.readdir(path.join(root, 'store', 'installed')), [], 'a refused tree is never promoted')
})

test('a manifest without i18n audits clean with zero keys', async () => {
  const dir = await writePackage(path.join(await tempRoot(), 'plain'), validPackage())
  const parsed = await parsePluginManifest(dir)
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal('i18n' in parsed.manifest, false, 'an absent copy block is absent, not undefined')
  assert.deepEqual(await auditPluginCopy(dir, parsed.manifest), { ok: true, keys: 0 })
})
