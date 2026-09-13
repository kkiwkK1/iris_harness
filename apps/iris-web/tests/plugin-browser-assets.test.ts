import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyClientResponse,
  findMemberConflicts,
  scanPluginMemberNames,
} from '../src/app/use-plugin-manifest.ts'

/**
 * The classification and conflict-scan contract behind the PluginCenter's
 * browser-asset status rows. These are the shell's half of the visibility
 * rule: whatever the frame itself reports is out of reach here, so the kinds
 * these functions name are the ones the status surface shows. The probe never
 * executes plugin code — `classifyClientResponse` compiles at most — and the
 * conflict scan reads only literal registration objects, so a static scan
 * cannot invent a conflict that registration would not refuse.
 */

test('a 404 for the client bundle is client-missing, not a generic fetch failure', () => {
  const probe = classifyClientResponse(404, undefined, 'abc123def456')
  assert.equal(probe.phase, 'degraded')
  assert.equal(probe.error?.kind, 'client-missing')
  assert.match(probe.error?.message ?? '', /404/)
  assert.equal(probe.loadedAt, undefined)
})

test('other failed HTTP statuses are classified as fetch failures', () => {
  const probe = classifyClientResponse(503, undefined, 'abc123def456')
  assert.equal(probe.phase, 'degraded')
  assert.equal(probe.error?.kind, 'http')
})

test('a classic-script bundle that fails to compile is a parse failure', () => {
  const probe = classifyClientResponse(200, 'globalThis.x = {', 'abc123def456')
  assert.equal(probe.phase, 'degraded')
  assert.equal(probe.error?.kind, 'parse')
  assert.equal(probe.source, undefined)
})

test('a compiling classic-script bundle is loaded and stamped', () => {
  const before = Date.now()
  const probe = classifyClientResponse(200, 'globalThis.__iris_plugin_ready__demo = true', 'abc123def456')
  assert.equal(probe.phase, 'loaded')
  assert.equal(probe.error, undefined)
  assert.equal(probe.rev, 'abc123def456')
  assert.ok((probe.loadedAt ?? 0) >= before, 'a loaded probe carries its success time')
  assert.ok(probe.source !== undefined, 'the source is kept for the conflict scan')
})

test('a module bundle is taken on trust, not misreported as a parse failure', () => {
  const probe = classifyClientResponse(200, 'import x from "y"\nexport default x', 'abc123def456')
  assert.equal(probe.phase, 'loaded')
  assert.equal(probe.error, undefined)
})

test('the member-name scan reads literal registerPluginMembers objects only', () => {
  assert.deepEqual(
    scanPluginMemberNames(`globalThis.__iris_members__.registerPluginMembers('demo', { alpha: 1, beta: () => {} });`),
    ['alpha', 'beta'],
  )
  // Computed keys and indirect registration yield nothing: a static scan must
  // not invent a conflict registration itself would not refuse.
  assert.deepEqual(scanPluginMemberNames(`registerPluginMembers('demo', { [key]: 1 })`), [])
  assert.deepEqual(scanPluginMemberNames(`const register = host.registerPluginMembers; register('demo', { a: 1 })`), [])
  assert.deepEqual(scanPluginMemberNames(undefined), [])
})

test('nested values, comments and strings cannot invent top-level member names', () => {
  const source = `
    // registerPluginMembers('comment', { fake: 1 })
    const text = "registerPluginMembers('string', { fake: 1 })"
    registerPluginMembers('demo', {
      outer: { shared: 1 },
      handler: () => ({ nested: 2 }),
      note: "a brace } and nested: 3",
      /* decoy: 4, */ finalMember: true,
    })
  `
  assert.deepEqual(scanPluginMemberNames(source), ['outer', 'handler', 'note', 'finalMember'])
  const conflicts = findMemberConflicts({
    a: { phase: 'loaded', rev: 'a', loadedAt: 1, error: undefined, source },
    b: { phase: 'loaded', rev: 'b', loadedAt: 1, error: undefined, source: `registerPluginMembers('b', { shared: 2 })` },
  })
  assert.deepEqual(conflicts, {}, 'a nested property is not a registered member and cannot create a conflict')
})

test('two bundles claiming one member name are named as the conflict sources', () => {
  const probes = {
    'plugin-a': { phase: 'loaded' as const, rev: 'a', loadedAt: 1, error: undefined, source: `registerPluginMembers('plugin-a', { shared: 1, onlyA: 1 })` },
    'plugin-b': { phase: 'loaded' as const, rev: 'b', loadedAt: 1, error: undefined, source: `registerPluginMembers('plugin-b', { shared: 2 })` },
  }
  const conflicts = findMemberConflicts(probes)
  assert.equal(conflicts['plugin-a']?.kind, 'conflict')
  assert.deepEqual(conflicts['plugin-a']?.sources?.claimants, ['plugin-a', 'plugin-b'])
  assert.equal(conflicts['plugin-a']?.sources?.member, 'shared')
  assert.equal(conflicts['plugin-b']?.kind, 'conflict', 'both claimants are degraded, so neither row hides the other')
})

test('disjoint member namespaces produce no conflict', () => {
  const probes = {
    'plugin-a': { phase: 'loaded' as const, rev: 'a', loadedAt: 1, error: undefined, source: `registerPluginMembers('plugin-a', { onlyA: 1 })` },
    'plugin-b': { phase: 'loaded' as const, rev: 'b', loadedAt: 1, error: undefined, source: `registerPluginMembers('plugin-b', { onlyB: 1 })` },
  }
  assert.deepEqual(findMemberConflicts(probes), {})
})
