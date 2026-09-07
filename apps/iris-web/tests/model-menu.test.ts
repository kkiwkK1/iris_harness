/**
 * What the composer's model capsule offers, and where each part of it comes
 * from.
 *
 * The decisions here are the ones a reader would get wrong by eye, so they are
 * pinned individually against the fake's own seeded profiles — the same
 * fixtures the dev page and `render-check` run on, so a case that passes here
 * is a case somebody can also look at.
 *
 * Two worth naming:
 *
 * **"Is this overridden?" is read from the chat's layer, never by comparing
 * values.** A conversation that chose the model its connection already used is
 * byte-identical, in the merged read, to one that chose nothing — and a
 * comparison would call it "not overridden" and hide the undo. That case has
 * its own test below, because it is the case where the cheap implementation
 * looks right.
 *
 * **The current model is a row, not only a readout.** It is pinned first
 * whatever the list says, which is what makes the menu answerable while a list
 * is missing or stale — and it is why the "which nothing is this" verdict is
 * decided from the *source's* list rather than from the rows offered. Two
 * assertions below were rewritten when that ruling landed (2026-09-07) rather
 * than deleted, and they say what they used to say.
 *
 * @module iris-web/tests/model-menu
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hostDefault, listConnections } from '@iris/client-fake'

import { modelMenu, MODEL_LIST_FRESH_MS } from '../src/app/model-menu.ts'

const { profiles, host: HOST } = listConnections()
/** The seed's active profile: a local serve with several tags recorded. */
const LOCAL = profiles.find(profile => profile.id === 'local-qwen')!
/** A profile whose recorded list does **not** contain its own model. */
const MISNAMED = profiles.find(profile => profile.id === 'misnamed')!
/** A profile nothing has ever probed. */
const UNPROBED = profiles.find(profile => profile.id === 'unnamed')!
/** The host row as a launch that nothing has probed yet serves it. */
const HOST_UNPROBED = hostDefault({ models: false })

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
  // The host row is the other source, and the two shapes of it are both
  // fixtures this file reads: probed, and not yet.
  assert.ok((HOST.models ?? []).length >= 2, 'the seeded host row carries no model list')
  assert.equal(typeof HOST.modelsProbedAt, 'number', 'the host row’s list is not stamped')
  assert.equal(HOST_UNPROBED.models, undefined, 'the never-probed host row gained a list')
  assert.ok(
    (HOST.baseURL ?? '').length > 0,
    'the host row carries no endpoint, so nothing here can test the probe it would address',
  )
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

test('a model the endpoint no longer lists is the menu’s first row anyway', () => {
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
  assert.equal(menu.overridden, true)
  /*
   * Until 2026-09-07 this asserted `models.includes(MISNAMED.model) === false`
   * — the rows were the endpoint's list and nothing else, and the current model
   * was reported by the capsule alone. The ruling changed: the menu has to be
   * able to say what is running in *every* state, including the ones where no
   * list came back at all, so the current model is row one and the endpoint's
   * own list follows it.
   */
  assert.equal(menu.models[0], MISNAMED.model, 'the model in force is not the first row')
  assert.deepEqual(
    menu.models.slice(1),
    MISNAMED.models,
    'the endpoint’s list should follow, in its own order and unfiltered',
  )
})

test('the pinned row is not a duplicate when the list already contains it', () => {
  const menu = modelMenu({
    model: LOCAL.model, overrides: {}, connections: profiles, activeId: LOCAL.id,
  })
  const at = menu.models.filter(id => id === LOCAL.model)
  assert.equal(at.length, 1, 'the current model appears twice')
  // And the order is still the endpoint's, because its list already opened with
  // this model. A row moved to the front would reorder somebody's list for no
  // reason the reader can see.
  assert.deepEqual(menu.models, LOCAL.models)
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
  /*
   * `models` used to be asserted empty here. It is not any more, and the change
   * is the point of the `empty` field rather than a loosening of it: the rows
   * always carry the model in force, so "is there anything to show?" and "has
   * any endpoint said anything?" became two questions. `empty` answers the
   * second, and it is read off the *source's* list — which is why pinning row
   * one did not silence this sentence.
   */
  assert.deepEqual(noConnection.models, ['local-model'], 'the model in force is not offered')
  assert.equal(noConnection.empty, 'no-connection')
  assert.equal(noConnection.source, undefined)
  // Nothing to name as a default either, so the restore row cannot be offered.
  assert.equal(noConnection.connectionModel, undefined)
  // And nothing to probe: there is no endpoint to address a probe to, so the
  // menu must not offer to fetch a list from nowhere.
  assert.equal(noConnection.probe, undefined)

  const neverProbed = modelMenu({
    model: UNPROBED.model, overrides: {}, connections: profiles, activeId: UNPROBED.id,
  })
  assert.equal(neverProbed.empty, 'no-list')
  // A default is nameable here: the connection exists, only its list is
  // missing.
  assert.equal(neverProbed.connectionModel, UNPROBED.model)
})

test('an active id pointing at nothing falls through to the host row', () => {
  // Deleted out of band, or a stale `activeId` from a host restart. There is no
  // profile to read, so the source is whatever answers when no profile
  // displaces it — which is the host's own connection, not "no connection".
  const withHost = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: 'deleted-out-of-band', host: HOST,
  })
  assert.equal(withHost.source, 'host')
  assert.equal(withHost.connectionName, undefined, 'a host row has no user-given name to show')

  // With no host row either, this is the one true no-connection case.
  const alone = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: 'deleted-out-of-band',
  })
  assert.equal(alone.empty, 'no-connection')
  assert.equal(alone.connectionName, undefined)
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

/* ------------------------------------------------------------------------- *
 * The host's own connection as the source.
 *
 * The reported bug, from the reader's side: 「我点击输入框下方的模型标签希望快速
 * 切换模型但是确实提示：『没有活动连接，因此没有可选的模型列表。』当很明显我是
 * 连接着模型的。」 The route was configured as `IRIS_*` variables and no profile
 * had ever been saved, so `activeId` was undefined and the menu answered about
 * the profile list — a true statement about the wrong object.
 * ------------------------------------------------------------------------- */

test('with no profile active the list comes from the host’s own connection', () => {
  const menu = modelMenu({
    model: HOST.model!, overrides: {}, connections: profiles, activeId: undefined, host: HOST,
  })
  assert.equal(menu.empty, undefined, 'the reported bug: a configured host read as no connection')
  assert.equal(menu.source, 'host')
  assert.deepEqual(menu.models, HOST.models, 'the host row’s own list, in its own order')
  // The heading has something to name it by that the reader can act on: the
  // variable the key is read from, never the key.
  assert.equal(menu.hostKeyEnv, HOST.keyEnv)
  assert.equal(menu.connectionName, undefined)
  // "Back to the default" means the model the process was started with.
  assert.equal(menu.connectionModel, HOST.model)
  // Nothing to fetch: there is a list, and the stamp the host wrote against it
  // is recent enough that opening the menu must not spend a round trip. The
  // stamp itself is not projected — see the note on the interface.
  assert.equal(menu.probe, undefined)
})

test('a profile outranks the host row, because it is what is generating', () => {
  const menu = modelMenu({
    model: LOCAL.model, overrides: {}, connections: profiles, activeId: LOCAL.id, host: HOST,
  })
  assert.equal(menu.source, 'profile')
  assert.deepEqual(menu.models, LOCAL.models)
  for (const foreign of HOST.models ?? []) {
    assert.equal(
      menu.models.includes(foreign),
      false,
      `${foreign} is the host endpoint's model, offered while a profile is active`,
    )
  }
  // And nothing of the host row leaks into the heading's provenance.
  assert.equal(menu.hostKeyEnv, undefined)
  assert.equal(menu.connectionName, LOCAL.label)
})

test('the current model leads the host row’s list too, even when it is not on it', () => {
  // The state a fresh install is in: the settings layer names one model and the
  // host's endpoint advertises others. The menu still has to say which one is
  // running.
  const menu = modelMenu({
    model: 'local/qwen3-8b', overrides: {}, connections: profiles, activeId: undefined, host: HOST,
  })
  assert.equal((HOST.models ?? []).includes('local/qwen3-8b'), false, 'the fixture stopped being off-list')
  assert.equal(menu.models[0], 'local/qwen3-8b')
  assert.deepEqual(menu.models.slice(1), HOST.models)
})

test('a host row nobody has probed offers to fetch its list, addressed to its endpoint', () => {
  const menu = modelMenu({
    model: HOST_UNPROBED.model!,
    overrides: {},
    connections: profiles,
    activeId: undefined,
    host: HOST_UNPROBED,
  })
  // Not "no connection" — the connection is right there, only its list is
  // missing, and the next step is a probe rather than a trip to the panel.
  assert.equal(menu.empty, 'no-list')
  assert.equal(menu.source, 'host')
  assert.deepEqual(menu.probe, { baseURL: HOST_UNPROBED.baseURL })
  // The ask carries no key. The host resolves the credential from what it
  // already holds and origin-checks it on its side; a key in this object would
  // be a key this module had to have been given.
  assert.deepEqual(Object.keys(menu.probe ?? {}), ['baseURL'])
})

test('a host row with no endpoint of its own has nothing to probe', () => {
  // `IRIS_BASE_URL` unset: the host rides whatever route its composition
  // registered, and this protocol has no address to point a probe at. The menu
  // says the list is missing and stops there rather than inventing an endpoint.
  const { baseURL: _dropped, ...noEndpoint } = HOST_UNPROBED
  const menu = modelMenu({
    model: 'deepseek-chat', overrides: {}, connections: profiles, activeId: undefined, host: noEndpoint,
  })
  assert.equal(menu.empty, 'no-list')
  assert.equal(menu.probe, undefined)
})

test('an unprobed profile is probed by id, so the host names its own refusal', () => {
  const menu = modelMenu({
    model: UNPROBED.model, overrides: {}, connections: profiles, activeId: UNPROBED.id,
  })
  // By id even though this profile carries no endpoint: the host answers
  // `no-endpoint` with a sentence naming what to do, which is better than
  // anything this module could guess from a missing field.
  assert.deepEqual(menu.probe, { profileId: UNPROBED.id })
  assert.equal(UNPROBED.baseURL, undefined, 'the endpointless fixture gained an endpoint')
})

test('a recent look is not repeated, and an old one is', () => {
  const probedAt = 1_800_000_000_000
  // A list that came back empty is the case that needs the window: the source
  // has been asked, and the answer was "nothing". Without the stamp being read,
  // every open would ask again.
  const empty = { ...HOST_UNPROBED, models: [], modelsProbedAt: probedAt }

  const justAsked = modelMenu({
    model: 'deepseek-chat',
    overrides: {},
    connections: profiles,
    activeId: undefined,
    host: empty,
    now: probedAt + MODEL_LIST_FRESH_MS - 1,
  })
  assert.equal(justAsked.empty, 'no-list', 'an empty list is still an absent list to the reader')
  assert.equal(justAsked.probe, undefined, 'the menu re-probed inside the freshness window')

  const staleNow = modelMenu({
    model: 'deepseek-chat',
    overrides: {},
    connections: profiles,
    activeId: undefined,
    host: empty,
    now: probedAt + MODEL_LIST_FRESH_MS,
  })
  assert.deepEqual(staleNow.probe, { baseURL: empty.baseURL }, 'the window never reopens')
})

test('the source key changes with the source, so one source’s failure cannot label another', () => {
  const onHost = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: undefined, host: HOST,
  })
  const onProfile = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: LOCAL.id, host: HOST,
  })
  const onOther = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: MISNAMED.id, host: HOST,
  })
  assert.ok(onHost.sourceKey !== undefined && onProfile.sourceKey !== undefined)
  assert.notEqual(onHost.sourceKey, onProfile.sourceKey)
  assert.notEqual(onProfile.sourceKey, onOther.sourceKey)
  // And no key at all when there is no source, so a note keyed on one cannot be
  // shown against nothing.
  assert.equal(
    modelMenu({ model: 'm', overrides: {}, connections: [], activeId: undefined }).sourceKey,
    undefined,
  )
})

/* ------------------------------------------------------------------------- *
 * The four lines of `Composer.tsx` that make the above reachable.
 *
 * Pinned against the source, as `masthead-controls.test.ts` and
 * `sidebar-tabs.test.ts` are, and for the same reason: there is no DOM harness
 * for a `.tsx` here, and `tools/render-check.tsx` cannot open the menu (its
 * open state is `useState` and a server render cannot click). So every
 * assertion above is about a function whose *one caller* is a file no test can
 * execute — which is exactly the seam where a decision arrives correct and is
 * then handed over wrong. Three of these four were kept alive only by a comment
 * before this file said so.
 * ------------------------------------------------------------------------- */

const COMPOSER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'Composer.tsx'),
  'utf8',
)

test('the composer hands the host row to the decision it belongs to', () => {
  // Without this line every host-source assertion in this file describes a
  // code path the product never enters, and the reported bug is still live.
  assert.match(COMPOSER, /host: hostConnection,/u, 'the capsule stopped passing the host row')
  assert.match(COMPOSER, /state\.hostConnection/u, 'the host row is not read from the store')
})

test('opening the menu spends the probe the decision offered, unchanged', () => {
  // `menu.probe` passed through rather than rebuilt: it is shaped as the
  // request's own parameters precisely so that this call site cannot decide
  // something different from the module that decided whether to ask at all.
  assert.match(COMPOSER, /const ask = menu\.probe/u)
  assert.match(COMPOSER, /actions\.testConnection\(ask\)/u, 'the probe is assembled at the call site')
  // And a key never appears in it. The host resolves the credential; a page
  // that sent one would be a page that had to hold one.
  assert.equal(/testConnection\(\{[^}]*apiKey/u.test(COMPOSER), false, 'the menu’s probe carries a key')
})

test('a refused probe reaches the reader as the refusal', () => {
  // The fake client refuses `connection.test` by design, so this path runs in
  // development every time — and a menu that went blank there would look like
  // the very bug this change is about.
  assert.match(COMPOSER, /describeError\(error, lang\)/u, 'a refusal is swallowed instead of shown')
  assert.match(COMPOSER, /modelMenuReadFailed/u, 'there is no row to show a refusal in')
  assert.match(COMPOSER, /modelMenuReading/u, 'there is no row for a read in flight')
})

test('the list is re-read from the host after a probe, not kept from the answer', () => {
  // The stamp is what suppresses the next probe, and only the host writes it.
  // A component holding the returned array would be a second copy of a fact the
  // store already carries, and an unstamped one.
  assert.match(COMPOSER, /actions\.loadConnections\(\)/u, 'a successful probe files nothing')
})
