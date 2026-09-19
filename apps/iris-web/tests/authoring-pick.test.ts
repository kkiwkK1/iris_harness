/**
 * What the authoring row's model holds after its provider moves.
 *
 * `connection-authoring-row.test.ts` drives this decision through the real
 * panel in a real document, which is where the defect of 2026-09-19 lived and
 * the only place it could have been caught. This file is beside it rather than
 * inside it for one branch that the panel cannot reach: **keeping a model the
 * new provider also advertises**. The fake's two probed profiles share no model
 * name — a local serve's `local/*` tags and a Gemini list — so there is no pair
 * of seeded providers a click could walk between to exercise it, and a fixture
 * invented for the DOM test would be a fixture proving itself.
 *
 * The three lines it does pin are the three sentences `authoring-pick.ts`
 * writes down, each against the case where the cheap implementation differs:
 * "always take the first model" passes the last two and fails the third,
 * "always keep the model" passes the first and third and fails the second.
 *
 * @module iris-web/tests/authoring-pick
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listConnections } from '@iris/client-fake'

import { authoringPick } from '../src/app/authoring-pick.ts'

const { profiles } = listConnections()
/** A profile with a probed list of several tags. */
const LOCAL = profiles.find(profile => profile.id === 'local-qwen')!
/** A second probed profile, whose list shares nothing with the first. */
const MISNAMED = profiles.find(profile => profile.id === 'misnamed')!
/** A profile nothing has ever probed, so the row falls back to a text field. */
const UNPROBED = profiles.find(profile => profile.id === 'unnamed')!

test('a provider with models brings its first one, which is what the select shows', () => {
  assert.deepEqual(
    authoringPick(profiles, LOCAL.id, '', false),
    { id: LOCAL.id, model: LOCAL.models?.[0] },
  )
  /*
   * And from a provider to another provider, rather than only from nothing:
   * the previous model is not in the new list, so carrying it would leave the
   * state naming a model this endpoint has never advertised while the control
   * displayed the first row of the new list.
   */
  assert.deepEqual(
    authoringPick(profiles, MISNAMED.id, LOCAL.models?.[0] ?? '', false),
    { id: MISNAMED.id, model: MISNAMED.models?.[0] },
  )
})

test('a provider with no probed list drops the model and leaves the field empty', () => {
  assert.deepEqual(
    authoringPick(profiles, UNPROBED.id, LOCAL.models?.[0] ?? '', false),
    { id: UNPROBED.id, model: '' },
  )
  // 「不设置」 is the same shape: no provider advertises anything, so nothing
  // is held, and the button reads a state that matches the empty field.
  assert.deepEqual(authoringPick(profiles, '', LOCAL.models?.[0] ?? '', false), { id: '', model: '' })
})

test('a model both providers advertise is kept rather than re-pointed', () => {
  /*
   * The seed has no such pair — two endpoints fronting one model is ordinary in
   * the field and absent from the fixtures — so this is the one case built
   * here, from the shape the function actually reads.
   */
  const shared = 'gpt-4o-mini'
  const two = [
    { id: 'left', models: [shared, 'left-only'] },
    { id: 'right', models: ['right-first', shared] },
  ]
  assert.deepEqual(authoringPick(two, 'right', shared, false), { id: 'right', model: shared })
  // While a model only the *old* one had still moves to the new list's first.
  assert.deepEqual(authoringPick(two, 'right', 'left-only', false), { id: 'right', model: 'right-first' })
})

test('a hand-typed model survives the provider moving under it', () => {
  /*
   * Owner ruling, 2026-09-10: a model that writes code is often one in closed
   * testing, and a name like that is typed precisely because no list offers it
   * — including, often, the list of the endpoint being switched to. The typed
   * name is the reader's, so the provider control does not get to spend it.
   */
  assert.deepEqual(
    authoringPick(profiles, LOCAL.id, 'some-beta-model', true),
    { id: LOCAL.id, model: 'some-beta-model' },
  )
  assert.deepEqual(
    authoringPick(profiles, UNPROBED.id, 'some-beta-model', true),
    { id: UNPROBED.id, model: 'some-beta-model' },
  )
})
