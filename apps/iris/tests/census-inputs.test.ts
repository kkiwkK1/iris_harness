import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UPSTREAM_CONTEXT_MEMBERS, UPSTREAM_MEMBERS } from '../../../apps/iris-web/src/sandbox/upstream-surface.ts'
import { FRAME_MEMBERS, MEMBER_KINDS } from '../../../apps/iris-web/src/sandbox/identity.ts'
import { VIRTUAL_PARENT_DIALOG_MEMBERS, VIRTUAL_PARENT_SCHEDULER_MEMBERS } from '../../../apps/iris-web/src/sandbox/frame.ts'
// The two calipers are plain JavaScript. Their types are inferred (the root
// program has `allowJs`, and `scripts/tsconfig.json` checks their bodies), but
// inference says only that an export is a set of strings; this file says
// *which* strings: each assertion pins what the census read to what the
// modules above export, so the two sides cannot drift apart quietly in either
// direction.
import { BUILT, MEMBERS } from '../../../scripts/th-member-census.mjs'
import { PARENT_BRIDGED, TH_BUILT, TH_DECLARED } from '../../../scripts/card-surface-census.mjs'

/**
 * What the two surface calipers read, against what the modules own.
 *
 * `scripts/th-member-census.mjs` and `scripts/card-surface-census.mjs` used to
 * find our side of their faces by slicing the source text at each constant's
 * declaration, which failed **silently** the day a constant moved
 * (`notes/PLUGIN-FEASIBILITY.md` §8, item 3) — and face ③ had already
 * mis-answered once that way, leaving `VIRTUAL_PARENT_DIALOG_MEMBERS` out of
 * its built set and reporting the #55 dialog trio as three gaps. Both calipers
 * import the constants now; these tests close the loop from the other side.
 *
 * Importing a caliper here is safe by construction: both are split so that the
 * corpus scan and the printing live behind an `argv[1]` guard, and only the
 * corpus-independent inputs are module-level exports.
 *
 * @module apps/iris/tests/census-inputs
 */

test('the member census read exactly the declared Tavern Helper surface', () => {
  assert.deepEqual(MEMBERS, [...UPSTREAM_MEMBERS])
})

test('the member census read exactly the classification identity.ts owns', () => {
  assert.deepEqual([...BUILT].sort(), Object.keys(MEMBER_KINDS).sort())
})

test('the card-surface census read exactly the two exported surface lists', () => {
  assert.deepEqual(TH_DECLARED, [...UPSTREAM_MEMBERS])
  assert.deepEqual([...TH_BUILT].sort(), [...new Set([...Object.keys(MEMBER_KINDS), ...FRAME_MEMBERS])].sort())
})

test('the virtual parent face answers every name its two member lists declare', () => {
  for (const name of [...VIRTUAL_PARENT_SCHEDULER_MEMBERS, ...VIRTUAL_PARENT_DIALOG_MEMBERS]) {
    assert.ok(PARENT_BRIDGED.has(name), `the parent face must bridge ${name}`)
  }
})
