/**
 * The consent gate's three states.
 *
 * Every test here exists for one failure mode: reading an **absent**
 * `scriptsAllowed` as a decline. That collapse produces no error, no log and no
 * visible symptom — the question is never asked, so scripts never run, so the
 * feature is simply missing and looks like a decision. It would survive review
 * precisely because `?? false` is what one writes for the field sitting beside
 * it.
 *
 * @module iris-web/tests/consent
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { consentState, mayRun, shouldAsk, totalBytes } from '../src/sandbox/consent.ts'

test('absent, false and true are three different answers', () => {
  assert.equal(consentState({}), 'unasked', 'absent means nobody has been asked')
  assert.equal(consentState({ scriptsAllowed: false }), 'declined')
  assert.equal(consentState({ scriptsAllowed: true }), 'allowed')
})

test('an unanswered card is asked; a declining card is not asked again', () => {
  /*
   * The two halves of the same distinction. Folding absence into `false` breaks
   * the first — nobody is ever asked. Folding `false` into absence breaks the
   * second — someone who said no is asked again on every chat they open, which
   * is how a permission prompt becomes something users click through.
   */
  assert.equal(shouldAsk(consentState({})), true)
  assert.equal(shouldAsk(consentState({ scriptsAllowed: false })), false)
  assert.equal(shouldAsk(consentState({ scriptsAllowed: true })), false)
})

test('only an explicit yes runs anything', () => {
  // "Not asked" and "declined" both run nothing. They differ in what the
  // interface does next, never in what executes.
  assert.equal(mayRun(consentState({})), false)
  assert.equal(mayRun(consentState({ scriptsAllowed: false })), false)
  assert.equal(mayRun(consentState({ scriptsAllowed: true })), true)
})

test('an explicit undefined is still an answer nobody gave', () => {
  /*
   * `{ scriptsAllowed: undefined }` has the key. A presence test written with
   * `in` says "asked"; the honest answer is "unasked", because no host writes
   * that on purpose — it is what a spread or an optional property produces.
   * This is the one case where presence alone is not the whole rule.
   */
  assert.equal(consentState({ scriptsAllowed: undefined }), 'unasked')
})

test('a missing response is unasked rather than a decline', () => {
  // A failed or absent `script.list` must not be read as the user saying no.
  assert.equal(consentState(undefined), 'unasked')
})

test('the size shown is every script, not only the enabled ones', () => {
  /*
   * The question is "may this card run code", and the answer covers scripts the
   * user may enable later without being asked again. Counting only what is
   * enabled today would show a smaller number than the permission grants.
   */
  const scripts = [
    { bytes: 1024, enabled: true },
    { bytes: 2048, enabled: false },
  ]

  assert.equal(totalBytes(scripts), 3072)
})
