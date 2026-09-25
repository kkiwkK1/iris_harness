/**
 * A sandbox refusal is recognised by brand, whichever copy of `errors.ts`
 * built it.
 *
 * The frame is two bundles, each with its own compiled `errors.ts`, so a
 * refusal thrown by a Tavern Helper member is an instance of the *other*
 * bundle's `UnsupportedApiError`. Node loads one module graph, so the only way
 * to reproduce two classes here is to import the file twice under two URLs.
 *
 * @module iris-web/tests/refusal-brand
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UnsupportedApiError, isRefusal, refusedMember } from '../src/sandbox/errors.ts'

test('a refusal built by a second copy of errors.ts is graded refused', async () => {
  // Through a computed URL, so the typechecker does not try to resolve the query.
  const url = new URL('../src/sandbox/errors.ts?second-bundle', import.meta.url).href
  const second = await import(url) as typeof import('../src/sandbox/errors.ts')
  assert.notEqual(second.UnsupportedApiError, UnsupportedApiError, 'the two imports shared one module')
  const foreign = new second.UnsupportedApiError('getCurrentMessageId()', 'no floor in a script frame')

  // The premise: identity does not cross copies.
  assert.equal(foreign instanceof UnsupportedApiError, false)
  // The fix: the brand does.
  assert.equal(isRefusal(foreign), true)
  assert.equal(refusedMember(foreign), 'getCurrentMessageId()')
})

test('an ordinary error, or a look-alike without a member, is not a refusal', () => {
  assert.equal(refusedMember(new Error('boom')), undefined)
  const unnamed = Object.assign(new Error('x'), { name: 'UnsupportedApiError' })
  assert.equal(refusedMember(unnamed), undefined, 'a name alone is not the brand')
  assert.equal(refusedMember('UnsupportedApiError'), undefined)
  assert.equal(refusedMember(null), undefined)
})
