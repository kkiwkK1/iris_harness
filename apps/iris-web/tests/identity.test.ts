/**
 * The identity classification, checked against the surface it describes.
 *
 * A hand-kept list of "which members care who is asking" rots the moment someone
 * adds a member, and the rot is silent: under co-location an unclassified member
 * gets the shared binding by default, so a card reads another script's variable
 * partition and finds it empty — which looks like state that was never written
 * rather than state that was read from the wrong place.
 *
 * So the list is not trusted. This walks the real surface and requires every
 * member to have been classified deliberately.
 *
 * @module iris-web/tests/identity
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { EventBus } from '@iris/compat-tavernhelper-core'

import { createFrameTavernHelper } from '../src/sandbox/tavern-helper.ts'
import { FRAME_MEMBERS, MEMBER_KINDS, identityMembers } from '../src/sandbox/identity.ts'

/** The live surface, built with a host that answers nothing. */
function surfaceNames(): string[] {
  const gaps: string[] = []
  const api = createFrameTavernHelper({
    context: () => undefined,
    scriptId: () => undefined,
    reportGap: message => gaps.push(message),
    adoptVariables: () => undefined,
    call: async () => undefined,
    triggerSlash: async () => '',
    events: new EventBus(),
  })
  // The frame contributes members of its own — they need its shared namespace
  // and its channel — so the surface a card sees is the union of the two.
  return [...Object.keys(api), ...FRAME_MEMBERS].sort()
}

test('every member of the card API is classified', () => {
  const unclassified = surfaceNames().filter(name => !Object.hasOwn(MEMBER_KINDS, name))

  assert.deepEqual(
    unclassified,
    [],
    'a new member defaults to the shared binding, which answers for the wrong script',
  )
})

test('the classification names nothing the surface does not have', () => {
  // The other direction: an entry left behind after a member was renamed would
  // make the list look complete while covering something that no longer exists.
  const surface = new Set(surfaceNames())
  const stale = Object.keys(MEMBER_KINDS).filter(name => !surface.has(name))

  assert.deepEqual(stale, [], 'the classification describes a member that is gone')
})

test('everything taking a variable scope is identity-bearing', () => {
  /*
   * `{type:'script'}` partitions by `getScriptId()`. Any member that accepts a
   * `VariableOption` therefore answers differently depending on who asked, and
   * MVU calls `getScriptId` 17 times for precisely this partitioning.
   */
  for (const name of [
    'getVariables',
    'getAllVariables',
    'replaceVariables',
    'insertOrAssignVariables',
    'insertVariables',
    'deleteVariable',
    'updateVariablesWith',
  ]) {
    assert.equal(MEMBER_KINDS[name], 'identity', `${name} takes a scope and must be per-script`)
  }
})

test('event teardown is identity-bearing, and emission is not', () => {
  /*
   * Measured upstream: the listener registry is keyed by iframe name and
   * `eventClearAll` deletes only that frame's entry, fired on `pagehide` so a
   * script's listeners die with the script. One shared registry across a card
   * would let one script's teardown remove its siblings' listeners — something
   * upstream cannot do, because the frames are separate.
   *
   * Emission is the deliberate exception: reaching every script of the card is
   * what the bus is for.
   */
  for (const name of ['eventOn', 'eventOnce', 'eventClearEvent', 'eventClearAll']) {
    assert.equal(MEMBER_KINDS[name], 'identity', `${name} must not reach another script`)
  }
  assert.equal(MEMBER_KINDS['eventEmit'], 'shared', 'a card-wide bus is the point of emission')
})

test('the members needing a per-script binding are a stable, named set', () => {
  // Named in full so that widening it is a visible change rather than a
  // side effect of adding a member.
  assert.deepEqual(identityMembers(), [
    // Script buttons: four stubs today, but classified by what they are. A stub
    // that becomes real must not quietly change which script owns it.
    'appendInexistentScriptButtons',
    'deleteVariable',
    'eventClearAll',
    'eventClearEvent',
    'eventClearListener',
    'eventMakeFirst',
    'eventMakeLast',
    'eventOn',
    'eventOnce',
    'eventRemoveListener',
    'getAllVariables',
    'getButtonEvent',
    'getScriptButtons',
    'getScriptId',
    'getVariables',
    'initializeGlobal',
    'insertOrAssignVariables',
    'insertVariables',
    'replaceScriptButtons',
    'replaceVariables',
    'updateVariablesWith',
    'waitGlobalInitialized',
  ])
})
