import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isCardMemberProxyCall,
  listedExtensionFor,
  servedExtensionEnabled,
  servedExtensionRow,
  type SystemPluginRow,
} from '../src/st-extensions/plane-extension.ts'

type Origin = NonNullable<SystemPluginRow['origin']>

function row(id: string, installed: boolean, status: string, origin: Origin = 'st-extension'): SystemPluginRow {
  return { id, installed, status, origin }
}

const TH = row('tavern-helper', true, 'enabled', 'builtin')
const MVU = row('mvu', true, 'enabled', 'builtin')

test('the bundled plugins are never the row the plane serves', () => {
  assert.equal(servedExtensionRow([TH, MVU]), undefined)
})

test('the installed ST row is the served one, whatever its status', () => {
  const st = row('prompt-template', true, 'enabled')
  assert.equal(servedExtensionRow([TH, st]), st)
  assert.equal(servedExtensionRow([TH, row('prompt-template', true, 'disabled')])?.id, 'prompt-template')
})

test('an installed git/dev package adopted before the ST extension does not capture the plane', () => {
  // The regression: package rows are adopted before ST rows, and the old rule
  // ("the first installed row that is not a bundled plugin") served the package.
  const pkg = row('dev-widget', true, 'error', 'package')
  const st = row('prompt-template', true, 'enabled')
  assert.equal(servedExtensionRow([TH, MVU, pkg, st])?.id, 'prompt-template')
  assert.equal(servedExtensionRow([TH, MVU, pkg]), undefined, 'a package is never the ST extension')
})

test('with two ST extensions and the first disabled, the enabled one is served', () => {
  const rows = [TH, row('first-extension', true, 'disabled'), row('second-extension', true, 'enabled')]
  assert.equal(servedExtensionRow(rows)?.id, 'second-extension')
  assert.equal(servedExtensionEnabled(servedExtensionRow(rows)), true)
})

test('a row with no origin (an older host) is not an ST extension', () => {
  assert.equal(servedExtensionRow([{ id: 'prompt-template', installed: true, status: 'enabled' }]), undefined)
})

test('an uninstalled extension has no row to serve', () => {
  assert.equal(servedExtensionRow([row('prompt-template', false, 'not-installed')]), undefined)
})

test('no snapshot yet means no row', () => {
  assert.equal(servedExtensionRow(undefined), undefined)
})

test('the frame is built from the listing entry for the served row, not the first entry', () => {
  const listing = [
    { id: 'other-extension', rev: 'r1', dirName: 'Other' },
    { id: 'prompt-template', rev: 'r2', dirName: 'ST-Prompt-Template' },
  ]
  assert.equal(listedExtensionFor(listing, 'prompt-template')?.rev, 'r2')
  assert.equal(listedExtensionFor(listing, 'missing'), undefined)
  assert.equal(listedExtensionFor(listing, undefined), undefined)
  assert.equal(listedExtensionFor(undefined, 'prompt-template'), undefined)
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
  const rows = [TH, MVU, row('prompt-template', true, 'disabled')]
  assert.equal(servedExtensionEnabled(servedExtensionRow(rows)), false)
  // And with the extension enabled, the same profile reports it running.
  const enabledRows = [...rows.slice(0, 2), row('prompt-template', true, 'enabled')]
  assert.equal(servedExtensionEnabled(servedExtensionRow(enabledRows)), true)
})

test('a card member-proxy envelope is recognised through the gate, whatever the source', () => {
  // The regression: the page's message gate used to swallow everything whose
  // source was not the extension frame BEFORE the plane saw it, so a card's
  // irisStMemberProxy call could never reach the member routing at all.
  assert.equal(isCardMemberProxyCall({ irisStMemberProxy: 'prompt-template', callId: 'c1' }), true)
  assert.equal(isCardMemberProxyCall({ irisStMemberProxy: '' }), true, 'present-and-empty still claims the channel')
  assert.equal(isCardMemberProxyCall({ irisStExt: 'tok', type: 'bridge-result' }), false)
  assert.equal(isCardMemberProxyCall({ irisStProject: 'tok', path: 'p1' }), false)
  assert.equal(isCardMemberProxyCall(null), false)
  assert.equal(isCardMemberProxyCall('string'), false)
})
