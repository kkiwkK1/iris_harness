import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildMemberBundle } from '../../../packages/iris-compat-st-extension/src/host/member-bundle.ts'
import { scanPluginMemberNames } from '../src/app/use-plugin-manifest.ts'

/**
 * The PluginCenter's member status is blind to a bundle the scanner cannot
 * read. The generated member bundle is the pilot's card-facing face, so the
 * scanner must see exactly the member it registers — this test fails the day
 * someone edits the bundle's call shape and breaks the status surface.
 */
test('the generated member bundle scans to its one member', () => {
  const bundle = buildMemberBundle('st-prompt-template')
  assert.deepEqual(scanPluginMemberNames(bundle), ['EjsTemplate'])
})

test('an unrelated bundle scans to nothing', () => {
  assert.deepEqual(scanPluginMemberNames('console.log("registerPluginMembers later")'), [])
})
