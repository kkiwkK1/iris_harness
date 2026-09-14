import assert from 'node:assert/strict'
import { test } from 'node:test'

import '../src/sandbox/members-entry.ts'
import {
  MEMBERS_GLOBAL,
  PLUGIN_ADMITTED_GLOBAL,
  pluginMembersGlobal,
  pluginReadyMarker,
} from '../src/sandbox/members-contract.ts'
import { collectPluginMembers } from '../src/sandbox/plugin-members.ts'

/**
 * The third-party member merge, against the real `members-entry` side effects:
 * importing it publishes the core table and the merge gate into this realm,
 * the way the members `<script>` does in a frame. Each test file is its own
 * process, so the module-level registration ledger starts clean here.
 */

const host = globalThis as unknown as Record<string, unknown>

/** Simulate the bootstrap's admission publication for one test's snapshot. */
function admit(ids: string[]): void {
  host[PLUGIN_ADMITTED_GLOBAL] = Object.fromEntries(ids.map(id => [id, { rev: '0'.repeat(12), client: `/plugins/${id}/client.js` }]))
}

/** Simulate a plugin script that ran to completion. */
function pluginRan(id: string, members: Record<string, unknown>): void {
  const register = (host[MEMBERS_GLOBAL] as Record<string, unknown>).registerPluginMembers as (
    id: string, members: Record<string, unknown>,
  ) => void
  register(id, members)
  host[pluginReadyMarker(id)] = true
}

test('an admitted, completed plugin is collected with its members', () => {
  admit(['demo-panel'])
  // Plain values, not functions: deepStrictEqual compares functions by
  // reference, and the point here is the merge's structure, not identity.
  pluginRan('demo-panel', { panelTitle: 'Demo', ready: 1 })
  const collected = collectPluginMembers(host[PLUGIN_ADMITTED_GLOBAL] as Record<string, unknown>, host)
  assert.deepEqual(collected.members['demo-panel'], { panelTitle: 'Demo', ready: 1 })
  assert.deepEqual(collected.reports, {})
  // Stored frozen: the frame trusts the registration, so the plugin cannot
  // mutate it after the fact.
  assert.equal(Object.isFrozen(host[pluginMembersGlobal('demo-panel')]), true)
})

test('a plugin whose script never ran is refused by name, alone', () => {
  // Fresh ids: the registration ledger is module state in this process, and
  // these two must start unregistered.
  admit(['blocked-panel', 'healthy-panel'])
  pluginRan('healthy-panel', { render: 'ok' })
  // blocked-panel registered nothing and set no marker: blocked, unparseable,
  // or thrown — and the merge must say so per plugin, not refuse the frame.
  const collected = collectPluginMembers(host[PLUGIN_ADMITTED_GLOBAL] as Record<string, unknown>, host)
  assert.equal(collected.members['blocked-panel'], undefined)
  assert.ok(collected.reports['blocked-panel'] !== undefined)
  assert.match(collected.reports['blocked-panel'], /blocked-panel.*did not run to completion/)
  assert.deepEqual(collected.members['healthy-panel'], { render: 'ok' })
  assert.equal(collected.reports['healthy-panel'], undefined)
})

test('half registrations are refused: a marker without members, members without a marker', () => {
  admit(['marker-only', 'members-only'])
  host[pluginReadyMarker('marker-only')] = true
  const register = (host[MEMBERS_GLOBAL] as Record<string, unknown>).registerPluginMembers as (
    id: string, members: Record<string, unknown>,
  ) => void
  register('members-only', { lone: 1 })
  const collected = collectPluginMembers(host[PLUGIN_ADMITTED_GLOBAL] as Record<string, unknown>, host)
  assert.ok(collected.reports['marker-only'] !== undefined)
  assert.match(collected.reports['marker-only'], /ready marker without members/)
  assert.ok(collected.reports['members-only'] !== undefined)
  assert.match(collected.reports['members-only'], /members without a ready marker/)
})

test('a plugin the snapshot does not admit cannot register', () => {
  admit([])
  const register = (host[MEMBERS_GLOBAL] as Record<string, unknown>).registerPluginMembers as (
    id: string, members: Record<string, unknown>,
  ) => void
  assert.throws(() => register('ghost-panel', { x: 1 }), /ghost-panel.*not admitted/)
  // And with no publication at all — an older bootstrap — nothing is admitted.
  delete host[PLUGIN_ADMITTED_GLOBAL]
  assert.throws(() => register('ghost-panel', { x: 1 }), /not admitted/)
})

test('collisions are refused by name: core names first, then other plugins', () => {
  admit(['squatter', 'second'])
  const register = (host[MEMBERS_GLOBAL] as Record<string, unknown>).registerPluginMembers as (
    id: string, members: Record<string, unknown>,
  ) => void
  const coreName = Object.keys(host[MEMBERS_GLOBAL] as Record<string, unknown>).find(name => name !== 'registerPluginMembers')
  assert.ok(coreName !== undefined, 'the core table has a name to collide with')
  assert.throws(() => register('squatter', { [coreName]: 1 }), /collides with the core member table/)
  register('squatter', { sharedTool: 1, ownTool: 2 })
  host[pluginReadyMarker('squatter')] = true
  assert.throws(
    () => register('second', { sharedTool: 3 }),
    /sharedTool.*already registered by plugin "squatter"/,
  )
  // The first registration stands; the refused one registered nothing.
  const collected = collectPluginMembers(host[PLUGIN_ADMITTED_GLOBAL] as Record<string, unknown>, host)
  assert.equal(collected.members['second'], undefined)
  assert.match(collected.reports['second'] ?? '', /did not run to completion|half-registered/)
})

test('re-registration by the same plugin is refused, and shape violations name the plugin', () => {
  admit(['steady', 'bad-shape'])
  const register = (host[MEMBERS_GLOBAL] as Record<string, unknown>).registerPluginMembers as (
    id: string, members: Record<string, unknown>,
  ) => void
  register('steady', { tool: 1 })
  assert.throws(() => register('steady', { tool: 2 }), /steady.*already registered/)
  assert.throws(() => register('bad-shape', null as unknown as Record<string, unknown>), /must register a members object/)
  assert.throws(() => register('', { x: 1 }), /non-empty string/)
})
