import assert from 'node:assert/strict'
import { test } from 'node:test'

import { servedExtensionEnabled, servedExtensionRow, type SystemPluginRow } from '../src/st-extensions/plane-extension.ts'

const BUNDLED = new Set(['tavern-helper', 'mvu'])

function row(id: string, installed: boolean, status: string): SystemPluginRow {
  return { id, installed, status }
}

test('the bundled plugins are never the row the plane serves', () => {
  const rows = [row('tavern-helper', true, 'enabled'), row('mvu', true, 'enabled')]
  assert.equal(servedExtensionRow(rows, BUNDLED), undefined)
})

test('the installed non-bundled row is the served one, whatever its status', () => {
  const st = row('prompt-template', true, 'enabled')
  assert.equal(servedExtensionRow([row('tavern-helper', true, 'enabled'), st], BUNDLED), st)
  assert.equal(
    servedExtensionRow([row('tavern-helper', true, 'enabled'), row('prompt-template', true, 'disabled')], BUNDLED)?.id,
    'prompt-template',
  )
})

test('an uninstalled extension has no row to serve', () => {
  assert.equal(servedExtensionRow([row('prompt-template', false, 'not-installed')], BUNDLED), undefined)
})

test('no snapshot yet means no row', () => {
  assert.equal(servedExtensionRow(undefined, BUNDLED), undefined)
})

test('only a fully enabled row counts as running — transitions and disabled do not', () => {
  assert.equal(servedExtensionEnabled(row('prompt-template', true, 'enabled')), true)
  assert.equal(servedExtensionEnabled(row('prompt-template', true, 'disabled')), false)
  assert.equal(servedExtensionEnabled(row('prompt-template', true, 'enabling')), false)
  assert.equal(servedExtensionEnabled(row('prompt-template', true, 'disabling')), false)
  assert.equal(servedExtensionEnabled(row('prompt-template', true, 'error')), false)
  assert.equal(servedExtensionEnabled(undefined), false)
})

test('a profile whose only enabled plugin is bundled reports the extension as NOT running', () => {
  // The regression this module exists for: the old gate asked "is some plugin
  // enabled", which stayed true on every profile because the bundled plugins
  // are on — so a disabled extension kept its frame and its settings panel.
  const rows = [row('tavern-helper', true, 'enabled'), row('mvu', true, 'enabled'), row('prompt-template', true, 'disabled')]
  assert.equal(servedExtensionEnabled(servedExtensionRow(rows, BUNDLED)), false)
  // And with the extension enabled, the same profile reports it running.
  const enabledRows = [...rows.slice(0, 2), row('prompt-template', true, 'enabled')]
  assert.equal(servedExtensionEnabled(servedExtensionRow(enabledRows, BUNDLED)), true)
})
