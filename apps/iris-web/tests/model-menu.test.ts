/**
 * What the composer's model capsule offers, and where each part of it comes
 * from.
 *
 * The decisions here are the ones a reader would get wrong by eye, so they are
 * pinned individually against the fake's own seeded profiles — the same
 * fixtures the dev page and `render-check` run on, so a case that passes here
 * is a case somebody can also look at.
 *
 * The one worth naming: **"is this overridden?" is read from the chat's layer,
 * never by comparing values.** A conversation that chose the model its
 * connection already used is byte-identical, in the merged read, to one that
 * chose nothing — and a comparison would call it "not overridden" and hide the
 * undo. That case has its own test below, because it is the case where the
 * cheap implementation looks right.
 *
 * @module iris-web/tests/model-menu
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listConnections } from '@iris/client-fake'

import { modelMenu } from '../src/app/model-menu.ts'

const { profiles } = listConnections()
/** The seed's active profile: a local serve with several tags recorded. */
const LOCAL = profiles.find(profile => profile.id === 'local-qwen')!
/** A profile whose recorded list does **not** contain its own model. */
const MISNAMED = profiles.find(profile => profile.id === 'misnamed')!
/** A profile nothing has ever probed. */
const UNPROBED = profiles.find(profile => profile.id === 'unnamed')!

test('the fixtures this test needs are the ones the fake actually seeds', () => {
  // A floor on the sample. Every assertion below is about a list's contents,
  // and a fixture that quietly lost its `models` would make most of them pass
  // by describing nothing.
  assert.ok((LOCAL.models ?? []).length >= 2, 'the active seeded profile carries no model list')
  assert.ok((MISNAMED.models ?? []).length >= 1)
  assert.equal(
    (MISNAMED.models ?? []).includes(MISNAMED.model),
    false,
    'the off-list fixture stopped being off-list',
  )
  assert.equal(UNPROBED.models, undefined, 'the never-probed fixture gained a list')
})

test('the menu offers the active connection’s recorded list, in the endpoint’s order', () => {
  const menu = modelMenu({
    model: LOCAL.model,
    overrides: {},
    connections: profiles,
    activeId: LOCAL.id,
  })
  assert.deepEqual(menu.models, LOCAL.models)
  assert.equal(menu.current, LOCAL.model)
  assert.equal(menu.connectionModel, LOCAL.model)
  assert.equal(menu.empty, undefined)
})

test('only the active connection’s list is offered, never a union of every profile', () => {
  const menu = modelMenu({
    model: LOCAL.model,
    overrides: {},
    connections: profiles,
    activeId: LOCAL.id,
  })
  // The other seeded profile's models exist and must not be here: they are a
  // different endpoint's, and the live endpoint has never heard of them.
  for (const foreign of MISNAMED.models ?? []) {
    assert.equal(menu.models.includes(foreign), false, `${foreign} came from a profile that is not active`)
  }
})

test('a model the endpoint no longer lists is still what the capsule reports', () => {
  const menu = modelMenu({
    model: MISNAMED.model,
    overrides: { model: MISNAMED.model },
    connections: profiles,
    activeId: MISNAMED.id,
  })
  // The conversation is generating with this model whether or not the endpoint
  // still advertises it. A capsule that only reported list members would go
  // blank in exactly the case worth reporting.
  assert.equal(menu.current, MISNAMED.model)
  assert.equal(menu.models.includes(MISNAMED.model), false)
  assert.equal(menu.overridden, true)
})

test('an override equal to the connection’s own model still reads as an override', () => {
  const menu = modelMenu({
    model: LOCAL.model,
    // The chat chose the same string the connection already used. The merged
    // read cannot tell this apart from choosing nothing; the layer can.
    overrides: { model: LOCAL.model },
    connections: profiles,
    activeId: LOCAL.id,
  })
  assert.equal(menu.overridden, true, 'a value comparison is deciding this instead of the layer')
  assert.equal(menu.connectionModel, LOCAL.model, 'the undo still names what it returns to')
})

test('no chat open is not the same as a chat that overrides nothing', () => {
  const open = modelMenu({ model: LOCAL.model, overrides: {}, connections: profiles, activeId: LOCAL.id })
  const global = modelMenu({
    model: LOCAL.model, overrides: undefined, connections: profiles, activeId: LOCAL.id,
  })
  // Both are `false`, and they must be: the marker is a claim about a
  // conversation, and there is no conversation in the second case. What this
  // pins is that `undefined` does not throw or default to "overridden".
  assert.equal(open.overridden, false)
  assert.equal(global.overridden, false)
})

test('the two empty states are named apart, because the next step differs', () => {
  const noConnection = modelMenu({
    model: 'local-model', overrides: {}, connections: profiles, activeId: undefined,
  })
  assert.deepEqual(noConnection.models, [])
  assert.equal(noConnection.empty, 'no-connection')
  // Nothing to name as a default either, so the restore row cannot be offered.
  assert.equal(noConnection.connectionModel, undefined)

  const neverProbed = modelMenu({
    model: UNPROBED.model, overrides: {}, connections: profiles, activeId: UNPROBED.id,
  })
  assert.equal(neverProbed.empty, 'no-list')
  // A default is nameable here: the connection exists, only its list is
  // missing.
  assert.equal(neverProbed.connectionModel, UNPROBED.model)
})

test('an active id pointing at nothing is the no-connection case, not a crash', () => {
  const menu = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: 'deleted-out-of-band',
  })
  assert.equal(menu.empty, 'no-connection')
  assert.equal(menu.connectionName, undefined)
})

test('the menu names the connection its list came from', () => {
  const labelled = modelMenu({
    model: LOCAL.model, overrides: {}, connections: profiles, activeId: LOCAL.id,
  })
  assert.equal(labelled.connectionName, LOCAL.label)

  // A profile the user never named falls back to the derived summary — the
  // panel's standing rule, because the summary is the one thing on a profile
  // that cannot be out of date.
  assert.equal(UNPROBED.label, undefined, 'the never-named fixture gained a label')
  const unnamed = modelMenu({
    model: UNPROBED.model, overrides: {}, connections: profiles, activeId: UNPROBED.id,
  })
  assert.equal(unnamed.connectionName, UNPROBED.summary)
})
