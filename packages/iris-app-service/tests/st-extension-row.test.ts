import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { normalizeManifest } from '@iris/compat-st-extension'
import { servedStExtensionRow, stExtensionRows } from '@iris/plugin-web-api'

import { SystemPluginInstallService } from '../src/plugins/install.ts'
import { adoptStExtension } from '../src/st-extension-adopt.ts'
import { SystemPluginRuntime, type SystemPluginDefinition } from '../src/system-plugins.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * Which catalog row the ST-compat pilot serves, over a catalog built the way
 * the composition builds it.
 *
 * The pilot used to find its row by exclusion: the first installed row that is
 * neither `tavern-helper` nor `mvu`. That was written when a catalog held only
 * those builtins and ST rows. Route 3 (installed git/dev packages) broke the
 * premise, and the boot order makes the package win: `scanInstalled` adopts
 * package rows (a tampered or missing tree still gets an `installed: true`
 * placeholder) *before* the ST boot scan adopts extension rows, and the
 * snapshot lists rows in adoption order. The bridge is armed for the real ST
 * id, so `begin()` with the package id returned null and ST-Prompt-Template
 * silently stopped expanding.
 *
 * Each catalog here is the real `SystemPluginRuntime`, the package row comes
 * from the real `SystemPluginInstallService` boot scan, and the ST rows come
 * from `adoptStExtension`, the function both of the composition's ST adoption
 * sites call.
 */

/** The two builtin ids, with trivial bodies (the capability graph is not the subject). */
function builtinStubs(): SystemPluginDefinition[] {
  return ['tavern-helper', 'mvu'].map(id => ({
    id,
    name: id,
    description: `${id} stub`,
    version: '0.0.0',
    apiVersion: 1 as const,
    dependencies: [],
    activate: () => undefined,
  }))
}

/**
 * A catalog whose file records one `dev` package installed in an earlier run.
 *
 * Its tree is not on disk, so the boot scan adopts the placeholder row —
 * `installed: true`, status `error` — which is the cheapest real package row
 * and exactly the "even a tampered placeholder" case the finding names.
 */
async function catalog(t: TestContext, options: { devPackage: boolean }): Promise<{ runtime: SystemPluginRuntime, dir: string }> {
  const dir = await tempDir(t, 'iris-st-row-')
  const file = join(dir, 'system-plugins.json')
  await writeFile(file, `${JSON.stringify({
    version: 2,
    revision: 1,
    plugins: options.devPackage
      ? { 'dev-widget': { installed: true, enabled: false, source: 'dev', path: join(dir, 'no-such-tree') } }
      : {},
  }, null, 2)}\n`, 'utf8')
  const runtime = new SystemPluginRuntime({
    context: new Context(),
    file,
    definitions: builtinStubs(),
    defaultEnabled: [],
  })
  await runtime.initialize()
  const installer = new SystemPluginInstallService({
    runtime,
    installRoot: join(dir, 'system-plugins'),
    clientAssetRoot: join(dir, 'assets', 'system-plugins'),
  })
  await installer.scanInstalled()
  t.after(async () => { await runtime.dispose() })
  return { runtime, dir }
}

function adoptSt(runtime: SystemPluginRuntime, dir: string, id: string): void {
  const parsed = normalizeManifest({ display_name: id, js: 'index.js', version: '1.0.0' })
  assert.ok(parsed.ok, 'the fixture manifest must parse')
  adoptStExtension(runtime, { id, manifest: parsed.manifest, dataDir: dir })
}

test('with a dev package installed before the ST extension, the pilot serves the ST extension', async (t) => {
  const { runtime, dir } = await catalog(t, { devPackage: true })
  adoptSt(runtime, dir, 'prompt-template')

  const rows = runtime.snapshot().plugins
  // The fixture's premise, checked: the package row is really there, installed,
  // and ahead of the ST row in snapshot order — the order that made it win.
  const ids = rows.map(row => row.id)
  assert.ok(rows.find(row => row.id === 'dev-widget')?.installed === true, 'the boot scan did not adopt the package row')
  assert.ok(ids.indexOf('dev-widget') < ids.indexOf('prompt-template'), 'the package row must precede the ST row for this to discriminate')

  assert.equal(servedStExtensionRow(rows)?.id, 'prompt-template')
  assert.equal(rows.find(row => row.id === 'dev-widget')?.origin, 'package', 'the boot scan stamps its rows as packages')
  assert.deepEqual(stExtensionRows(rows).map(row => row.id), ['prompt-template'])
})

test('with two ST extensions and the first one disabled, the pilot serves the enabled one', async (t) => {
  // No package here: this failure mode needs none. Taking the first installed
  // non-builtin row served the disabled extension, and the enabled one never ran.
  const { runtime, dir } = await catalog(t, { devPackage: false })
  adoptSt(runtime, dir, 'first-extension')
  adoptSt(runtime, dir, 'second-extension')
  await runtime.enable('second-extension')

  const rows = runtime.snapshot().plugins
  assert.equal(rows.find(row => row.id === 'first-extension')?.status, 'disabled')
  assert.equal(rows.find(row => row.id === 'second-extension')?.status, 'enabled')

  assert.equal(servedStExtensionRow(rows)?.id, 'second-extension')
  assert.equal(rows.find(row => row.id === 'second-extension')?.origin, 'st-extension')
  assert.equal(rows.find(row => row.id === 'tavern-helper')?.origin, 'builtin')
})

test('with no ST extension at all, the pilot serves nothing — not the package', async (t) => {
  const { runtime } = await catalog(t, { devPackage: true })
  assert.equal(servedStExtensionRow(runtime.snapshot().plugins), undefined)
})
