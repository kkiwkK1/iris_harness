import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stringHash as shared } from '@iris/text'

import { stringHash as local } from '../src/registry.ts'

/**
 * This package uses **the** hash, not a copy of it.
 *
 * Three consumers must produce the same number from the same string: the
 * lorebook engine derives an entry's identity for timed effects from it, the
 * macro tier seeds `{{pick}}` with it, and a script button's event name is
 * `${scriptId}_${hash(name)}` — where a listener registered under a hash
 * differing by **one bit** never fires and never says why.
 *
 * Asserted by **identity**, not by behaviour. Two functions agreeing on every
 * string anyone thought to test are still two functions, and the failure this
 * guards is drift — a later edit to one copy that reads as an improvement.
 * Comparing outputs would pass until the day it mattered.
 *
 * Pairwise rather than three-way on purpose: a single test naming all three
 * would need a package to depend on two others it does not use, and inventing a
 * dependency to hold a test is a real coupling bought with a fake need. Each
 * package checks its own re-export against `@iris/text`; transitivity does the
 * rest. The shared home was `@iris/compat-tavernhelper-core` until 2026-09-12,
 * and the reason it moved is that this pairwise shape was buying transitivity
 * with a dependency on the Tavern Helper compat layer (root
 * `notes/DEVIATIONS.md`, stage 0).
 */

test('the exported hash is the shared one', () => {
  assert.equal(local, shared, 'this package grew its own copy of the hash')
})
