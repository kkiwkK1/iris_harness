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

import { listConnections } from '@iris/client-fake'

import { modelMenu, MODEL_LIST_FRESH_MS } from '../src/app/model-menu.ts'

const { profiles } = listConnections()
/** The seed's active profile: a local serve with several tags recorded. */
const LOCAL = profiles.find(profile => profile.id === 'local-qwen')!
/** A profile whose recorded list does **not** contain its own model. */
const MISNAMED = profiles.find(profile => profile.id === 'misnamed')!
/** A profile nothing has ever probed. */
const UNPROBED = profiles.find(profile => profile.id === 'unnamed')!
/*
 * `HOST` and `HOST_UNPROBED` stood here: the fake's own 「宿主环境」 row, with and
 * without a recorded model list, which was this capsule's second model source
 * while no profile was in use. The user's ruling of 2026-09-10 retires it (web
 * §79), so the capsule has one source and "none in use" is a real emptiness.
 */

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
  // And the fixture has more than one provider, which is what makes "no
  // provider in use" distinguishable from "no provider saved" below.
  assert.ok(profiles.length >= 2, 'the fake stopped seeding more than one provider')
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

test('an active id pointing at nothing is no connection at all', () => {
  // Deleted out of band, or a stale `activeId` from a host restart. There is no
  // profile to read, and there is no second source to fall through to any more:
  // this used to become the host's own connection, which is exactly the state
  // that now generates nothing (host §61).
  const stale = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: 'deleted-out-of-band',
  })
  assert.equal(stale.source, undefined)
  assert.equal(stale.empty, 'no-connection')
  assert.equal(stale.connectionName, undefined)
  assert.equal(stale.probe, undefined, 'a probe was addressed to a profile that is not there')
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
 * The environment is not a source (web §79).
 *
 * Seven tests stood here, all of them about the host's own launch connection
 * being the capsule's fallback list. They were written for a reported bug,
 * verbatim: 「我点击输入框下方的模型标签希望快速切换模型但是确实提示：『没有活动
 * 连接，因此没有可选的模型列表。』当很明显我是连接着模型的。」 — the route came from
 * the `IRIS_*` variables, no profile had ever been saved, and the menu answered
 * about the profile list, which was a true statement about the wrong object.
 *
 * The user's ruling of 2026-09-10 answers that report from the other end
 * instead: the environment is not a connection, and a host with no provider in
 * use is not connected to anything — it refuses to generate (host §61). So the
 * sentence the reader met is now correct, and what these tests pin is that the
 * second source is gone rather than merely unused: a stale `host` argument
 * would be accepted silently by a structural type, so the assertions are about
 * what the answer *cannot* contain.
 * ------------------------------------------------------------------------- */

test('no provider in use offers no list, names no source, and probes nothing', () => {
  const menu = modelMenu({
    model: 'local-model', overrides: {}, connections: profiles, activeId: undefined,
  })
  // The floor on the fixture: there are providers saved, so this is "none in
  // use" and not "none saved" — the fall back this section removed only ever
  // ran in the first of those.
  assert.ok(profiles.length >= 2, 'the fake stopped seeding providers')
  assert.equal(menu.empty, 'no-connection')
  assert.equal(menu.source, undefined)
  assert.equal(menu.sourceKey, undefined)
  assert.equal(menu.probe, undefined, 'a probe was addressed to an endpoint nothing generates through')
  assert.equal(menu.connectionModel, undefined, 'a default was named with no connection to be the default of')
  assert.equal(menu.connectionName, undefined)
  // The model in force is still the first row: it is what this conversation is
  // set to, which the capsule has to be able to say either way.
  assert.deepEqual(menu.models, ['local-model'])
})

test('no profile in use offers no other profile’s list either', () => {
  // The failure this rules out is the one the fall back's removal could
  // produce by accident: reaching for *a* profile rather than *the* one in use.
  const menu = modelMenu({
    model: 'local-model', overrides: {}, connections: profiles, activeId: undefined,
  })
  for (const profile of profiles) {
    for (const model of profile.models ?? []) {
      assert.equal(menu.models.includes(model), false, `${model} is ${profile.id}'s, offered with nothing in use`)
    }
  }
})

test('a profile in use is the only source, and its own list is what is offered', () => {
  const menu = modelMenu({
    model: LOCAL.model, overrides: {}, connections: profiles, activeId: LOCAL.id,
  })
  assert.equal(menu.source, 'profile')
  assert.deepEqual(menu.models, LOCAL.models)
  for (const foreign of MISNAMED.models ?? []) {
    assert.equal(
      menu.models.includes(foreign),
      false,
      `${foreign} belongs to another profile and is offered anyway`,
    )
  }
  assert.equal(menu.connectionName, LOCAL.label)
  assert.equal(menu.connectionModel, LOCAL.model)
})

test('a recent look is not repeated, and an old one is', () => {
  const probedAt = 1_800_000_000_000
  // A list that came back empty is the case that needs the window: the source
  // has been asked, and the answer was "nothing". Without the stamp being read,
  // every open would ask again. Carried on a *profile* now — the row that used
  // to serve this case was the host's.
  const asked = [{ ...UNPROBED, models: [], modelsProbedAt: probedAt }]

  const justAsked = modelMenu({
    model: UNPROBED.model,
    overrides: {},
    connections: asked,
    activeId: UNPROBED.id,
    now: probedAt + MODEL_LIST_FRESH_MS - 1,
  })
  assert.equal(justAsked.empty, 'no-list', 'an empty list is still an absent list to the reader')
  assert.equal(justAsked.probe, undefined, 'the menu re-probed inside the freshness window')

  const staleNow = modelMenu({
    model: UNPROBED.model,
    overrides: {},
    connections: asked,
    activeId: UNPROBED.id,
    now: probedAt + MODEL_LIST_FRESH_MS,
  })
  assert.deepEqual(staleNow.probe, { profileId: UNPROBED.id }, 'the window never reopens')
})

test('the source key changes with the source, so one source’s failure cannot label another', () => {
  const onProfile = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: LOCAL.id,
  })
  const onOther = modelMenu({
    model: 'm', overrides: {}, connections: profiles, activeId: MISNAMED.id,
  })
  assert.ok(onProfile.sourceKey !== undefined && onOther.sourceKey !== undefined)
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

test('the composer hands the capsule nothing but the provider in use', () => {
  // The other direction from the pins above, and the one this file can state:
  // the environment must not come back as a second source through the call
  // site. It used to be passed as `host: hostConnection` and read from the
  // store beside it (web §78); both are gone (web §79), so a fall back cannot
  // be restored by the caller while the decision says there is none.
  assert.doesNotMatch(COMPOSER, /host: hostConnection/u, 'the capsule passes the environment as a source again')
  assert.doesNotMatch(COMPOSER, /state\.hostConnection/u, 'the composer reads the environment row again')
  // And the call it does make is the whole of what the decision needs.
  assert.match(COMPOSER, /activeId: activeConnectionId,/u, 'the capsule stopped naming the provider in use')
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
