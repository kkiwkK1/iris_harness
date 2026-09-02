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
import { UPSTREAM_MEMBERS } from '../src/sandbox/upstream-surface.ts'

/**
 * Members that are ours, not upstream’s, and are therefore exempt from the
 * spelling guard below.
 *
 * Three, and each is here because upstream has no member of that name at all —
 * confirmed against its `@types` and its `src`, both zero hits. Being an
 * extension is the only thing that earns an entry: a name that upstream *does*
 * have, spelled our own way, is a bug, and the paired test below refuses to let
 * one hide here.
 */
const IRIS_OWN: ReadonlySet<string> = new Set([
  // Swipes are a first-class object in Iris; upstream reaches them through the
  // message it hangs them off, so there is no name to copy.
  'getSwipes',
  'swipeTo',
  // The MVU event namespace, exposed as one member rather than as upstream’s
  // loose globals.
  'mvu_events',
])

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
    // Script buttons: all five real now, and the classification did not move
    // when they stopped being stubs — which is what classifying them by what
    // they are, rather than by what a stub needed, was for.
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
    'updateScriptButtonsWith',
    'updateVariablesWith',
    'waitGlobalInitialized',
  ])
})

test('every name we build is a name upstream has, or is declared as ours', () => {
  /*
   * The direction that was missing, and the gap it left was live.
   *
   * `identity.test.ts` had two guards over this surface and both compared the
   * implementation against `MEMBER_KINDS`. That pairing is closed: a name
   * misspelled in one was misspelled in the other, so the two agreed and both
   * tests passed while cards calling the real upstream name got `undefined`.
   * It happened — `substitudeMacros` is upstream’s own misspelling, which this
   * surface deliberately copies, and the copy was itself mistyped as
   * `substidudeMacros`. Five green tests, one dead member.
   *
   * `UPSTREAM_MEMBERS` is extracted from upstream’s `@types`, so it is the one
   * list here that cannot drift to match our mistakes. This is the only guard
   * that consults it.
   *
   * The module header already had the principle backwards-on: “a checklist can
   * only ever speak about names that are on it.” The checklist was on the shelf;
   * nobody held the implementation up against it.
   */
  const upstream = new Set(UPSTREAM_MEMBERS)
  const invented = surfaceNames().filter(
    name => !upstream.has(name) && !IRIS_OWN.has(name),
  )

  assert.deepEqual(
    invented,
    [],
    'these exist on our surface under names upstream does not use — a card written against upstream reaches them as undefined. Either the spelling is wrong, or the member is ours and belongs in IRIS_OWN with a reason.',
  )
})

test('the members we claim as our own are genuinely not upstream’s', () => {
  /*
   * The allowlist has to be falsifiable in both directions, or it becomes the
   * place a future typo is parked to make the guard above go quiet.
   */
  const upstream = new Set(UPSTREAM_MEMBERS)
  const notOurs = [...IRIS_OWN].filter(name => upstream.has(name))
  assert.deepEqual(notOurs, [], 'upstream has these, so they are not Iris extensions and must not be exempt from the spelling guard')

  const surface = new Set(surfaceNames())
  const absent = [...IRIS_OWN].filter(name => !surface.has(name))
  assert.deepEqual(absent, [], 'exempted but not built — a dead entry that will excuse the next real typo')
})
