/**
 * The `z` global's spelling defense, against the real zod it ships with.
 *
 * The break this exists for is a *library-shape* break, so the tests import the
 * same `zod` the bundle bundles rather than describing it — and they reproduce
 * the measured overwrite first: the bare named export must not answer `.z`, or
 * the defense is a layer over a library that no longer needs it and must be
 * removed in the same change that removes that assertion.
 *
 * The dereference chain asserted at the end is `mvu_zod.js`'s own — the helper
 * 人贩子物语 imports reads the global once into `r` and then works through
 * `r.z.*` for the rest of its life.
 *
 * @module iris-web/tests/zod-global
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import * as zodNamespace from 'zod'

import { publishZodGlobal } from '../src/sandbox/zod-global.ts'

test('the break reproduces on the bare named export', () => {
  /*
   * Guarding the premise, the way `zod-compat.test.ts` guards its own. The
   * named export carries the classic members but not the self-reference — the
   * one measured fact the defense rests on.
   */
  const named = zodNamespace.z as unknown as Record<string, unknown>
  assert.equal(typeof named['ZodObject'], 'function')
  assert.equal(
    named['z'],
    undefined,
    'the named export now answers .z — remove this defense and its tests together',
  )
})

test('the seed answers both spellings before any card runs', () => {
  const target: Record<string, unknown> = {}
  publishZodGlobal(target, zodNamespace)

  const z = target['z'] as unknown as Record<string, unknown>
  assert.equal(typeof z['ZodObject'], 'function')
  assert.equal(typeof (z['z'] as unknown as Record<string, unknown>)['ZodObject'], 'function')
  // Unchanged reads: the seed is the namespace itself, not a view of it.
  assert.equal(target['z'], zodNamespace)
})

test('a card overwrite with the named export still answers the z → .z chain', () => {
  const target: Record<string, unknown> = {}
  publishZodGlobal(target, zodNamespace)

  // The measured overwrite, verbatim in shape: the named export of the same
  // zod the CDN bundle ships, hung on the global by a card before it imports
  // its helper.
  target['z'] = zodNamespace.z

  // `const r = z` — the helper's module top level.
  const r = target['z'] as unknown as Record<string, unknown>
  assert.equal(typeof r['z'], 'object', 'the global lost the .z spelling at the overwrite')
  assert.equal(typeof (r['z'] as unknown as Record<string, unknown>)['ZodObject'], 'function')
  assert.equal(typeof (r['z'] as unknown as Record<string, unknown>)['looseObject'], 'function')
  assert.equal(typeof (r['z'] as unknown as Record<string, unknown>)['prettifyError'], 'function')

  // The work the helper does at registration: build through `r.z`, and match a
  // schema against the copy the card built its own schemas from. The class on
  // the right of `instanceof` is read through that same dereference
  // (`zViaHelper` is `r['z']`), typed as zod's own class so the compiler sees
  // what the runtime value is.
  const zViaHelper = r['z'] as unknown as typeof zodNamespace.z
  const schema = zViaHelper.object({ stage: zViaHelper.string() })
  assert.deepEqual(schema.parse({ stage: '犯罪期' }), { stage: '犯罪期' })
  assert.equal(
    schema instanceof zViaHelper.ZodObject,
    true,
    'instanceof must see the class of the copy the card built from',
  )
})

test('the view is stable across reads and inherits the copy it was built over', () => {
  const target: Record<string, unknown> = {}
  publishZodGlobal(target, zodNamespace)
  target['z'] = zodNamespace.z

  const first = target['z']
  const second = target['z']
  assert.equal(first, second, 'repeated reads handed back different objects')
  assert.notEqual(first, zodNamespace.z, 'the view replaced the copy instead of answering for it')
})

test('an overwrite that already carries .z reads back identically', () => {
  // A card assigning the full namespace (or a future zod whose named export
  // self-references) gets its own object back — the defense has nothing to add.
  const target: Record<string, unknown> = {}
  publishZodGlobal(target, zodNamespace)
  target['z'] = zodNamespace

  assert.equal(target['z'], zodNamespace)
})

test('a non-zod assignment reads back unchanged', () => {
  // The getter runs on every bare `z` read in the realm, so anything that is
  // not the one-spelled shape must pass through as stored.
  const target: Record<string, unknown> = {}
  publishZodGlobal(target, zodNamespace)

  target['z'] = 42
  assert.equal(target['z'], 42)
  const marker = { tag: 'not zod' }
  target['z'] = marker
  assert.equal(target['z'], marker)
})
