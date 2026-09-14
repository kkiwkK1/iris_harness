import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildMemberBundle } from '../src/host/member-bundle.ts'
import { buildStExtensionDefinition, ST_EXTENSION_CAPABILITY } from '../src/host/definition.ts'
import { normalizeManifest } from '../src/manifest.ts'
import { defaultSettingsBlob, hydrateSettingsBlob, settingsKeyFor } from '../src/host/settings.ts'

test('the member bundle registers under its own id with the literal member key the scanner reads', () => {
  const bundle = buildMemberBundle('st-prompt-template')
  assert.match(bundle, /registerPluginMembers\('st-prompt-template', \{ EjsTemplate:/)
  assert.match(bundle, /__iris_members__/)
  for (const method of ['evalTemplate', 'evalTemplateWI', 'setVariable', 'getVariable']) {
    assert.ok(bundle.includes(`'${method}'`), `bundle carries ${method}`)
  }
})

test('the member bundle refuses an unsafe id', () => {
  assert.throws(() => buildMemberBundle('../evil'), TypeError)
  assert.throws(() => buildMemberBundle(''), TypeError)
})

test('an installed ST extension becomes a runtime-shaped definition from its manifest', () => {
  const result = normalizeManifest({
    display_name: 'ST-Prompt-Template',
    version: '1.17.4.1',
    js: 'dist/index.js',
    css: '',
    loading_order: 1,
    requires: [],
    optional: [],
  })
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  const definition = buildStExtensionDefinition({ id: 'st-prompt-template', manifest: result.manifest })
  assert.equal(definition.id, 'st-prompt-template')
  assert.equal(definition.name, 'ST-Prompt-Template')
  assert.equal(definition.version, '1.17.4.1')
  assert.equal(definition.apiVersion, 1)
  let provided: unknown
  definition.activate({
    provide(name: string, capability: unknown): unknown {
      assert.equal(name, ST_EXTENSION_CAPABILITY)
      provided = capability
      return {}
    },
  })
  assert.deepEqual(provided, { extensionId: 'st-prompt-template', manifestVersion: '1.17.4.1', entry: 'dist/index.js' })
})

test('the settings blob seeds upstream defaults and hydrates a stored blob over them', () => {
  const fresh = defaultSettingsBlob()
  assert.equal(fresh.EjsTemplate['enabled'], true)
  assert.equal(fresh.EjsTemplate['raw_message_evaluation_enabled'], true)
  assert.equal(fresh.EjsTemplate['compile_workers'], false)
  assert.deepEqual(fresh.variables, { global: {} })
  assert.deepEqual(fresh.regex, [])

  const stored = hydrateSettingsBlob({
    EjsTemplate: { enabled: false, cache_enabled: 1 },
    variables: { global: { last: 'x' } },
    regex: [{ id: 'r1' }],
    custom: 'kept',
  })
  assert.equal(stored.EjsTemplate['enabled'], false)
  assert.equal(stored.EjsTemplate['cache_enabled'], 1)
  // Keys absent from the stored blob fall back to defaults, not undefined.
  assert.equal(stored.EjsTemplate['render_enabled'], true)
  assert.deepEqual(stored.variables.global, { last: 'x' })
  assert.deepEqual(stored.regex, [{ id: 'r1' }])
  assert.equal(stored['custom'], 'kept')
})

test('hydrate tolerates garbage; the key builder refuses unsafe ids', () => {
  const blob = hydrateSettingsBlob('not an object')
  assert.equal(blob.EjsTemplate['enabled'], true)
  assert.equal(settingsKeyFor('st-prompt-template'), 'st-compat/st-prompt-template')
  assert.throws(() => settingsKeyFor('../evil'), TypeError)
})
