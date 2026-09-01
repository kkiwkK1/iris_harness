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

import {
  consentFigures,
  describeConsentAsk,
  consentState,
  mayRun,
  shouldAsk,
  totalBytes,
} from '../src/sandbox/consent.ts'

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

test('the count and the size measure the same set', () => {
  /*
   * The defect this pins shipped and was reviewed: "This card ships 4 scripts
   * (448 kB)" — four counted the *enabled* scripts (17 kB between them), while
   * 448 kB measured all nine, 423 kB of which were switched off. The reader was
   * told they were about to run twenty-six times more code than they were, on
   * the one screen built for judging exactly that.
   *
   * It passed review because the card it was checked against had two scripts,
   * both enabled, so the two rulers gave the same answer. A single example
   * cannot distinguish a figure from a coincidence.
   */
  const scripts = [
    { bytes: 10_000, enabled: true },
    { bytes: 7_000, enabled: true },
    { bytes: 423_000, enabled: false },
  ]
  const figures = consentFigures(scripts)

  assert.equal(figures.running, 2)
  assert.equal(figures.total, 3)
  assert.equal(figures.runningBytes, 17_000, 'the size of what would run')
  assert.equal(figures.totalBytes, 440_000, 'the size the answer covers')
  assert.notEqual(
    figures.runningBytes,
    figures.totalBytes,
    'a card where the two coincide cannot catch this',
  )
})

test('a card whose scripts are all enabled reports one figure, not two', () => {
  // The coinciding case is legitimate — it just must not be the only case tested.
  const scripts = [
    { bytes: 100, enabled: true },
    { bytes: 200, enabled: true },
  ]
  const figures = consentFigures(scripts)

  assert.equal(figures.running, figures.total)
  assert.equal(figures.runningBytes, figures.totalBytes)
})

test('a card with nothing enabled still states what the answer covers', () => {
  // Answering "run them" here grants something, even though nothing runs today.
  const figures = consentFigures([{ bytes: 500, enabled: false }])

  assert.equal(figures.running, 0)
  assert.equal(figures.runningBytes, 0)
  assert.equal(figures.total, 1)
  assert.equal(figures.totalBytes, 500)
})

test('a state meaning "no information" never borrows one meaning "an answer"', () => {
  /*
   * The collapse this pins was observed in production: a card that had already
   * been allowed showed the question again on reload, and its scripts did not
   * run. The shell used `unasked` as its initial value, so the moment before the
   * host answered was indistinguishable from the host having said nobody asked.
   *
   * Same shape as reading an absent `scriptsAllowed` as a decline, one layer
   * out. Loading is not an answer.
   */
  assert.equal(shouldAsk('unknown'), false, 'do not ask while the answer is in flight')
  assert.equal(mayRun('unknown'), false, 'and do not run on a state that knows nothing')
  assert.equal(shouldAsk('unasked'), true)
  assert.equal(mayRun('allowed'), true)
})

/** The interface's formatter, reproduced so the sentence reads as it ships. */
const bytes = (count: number): string =>
  count < 1024 ? `${String(count)} B` : `${String(Math.round(count / 1024))} kB`

test('one script takes a singular verb', () => {
  /*
   * Caught in production, on the first card anyone opened that shipped exactly
   * one script: "This card runs 1 script (94 B). **They** run in an isolated
   * sandbox…". Invisible on every card with two or more, which is every card
   * this had been checked against.
   */
  const sentence = describeConsentAsk(consentFigures([{ bytes: 94, enabled: true }]), bytes)

  assert.match(sentence, /This card runs 1 script \(94 B\)\./)
  assert.match(sentence, /It runs in an isolated sandbox/)
  assert.doesNotMatch(sentence, /They run/)
})

test('more than one takes the plural', () => {
  const sentence = describeConsentAsk(
    consentFigures([
      { bytes: 100, enabled: true },
      { bytes: 200, enabled: true },
    ]),
    bytes,
  )

  assert.match(sentence, /This card runs 2 scripts \(300 B\)\./)
  assert.match(sentence, /They run in an isolated sandbox/)
})

test('a card whose counts diverge states both, and agrees with what runs', () => {
  // The OVERLORD shape: four of nine enabled, and almost all the weight dormant.
  const sentence = describeConsentAsk(
    consentFigures([
      { bytes: 17_000, enabled: true },
      { bytes: 400, enabled: true },
      { bytes: 423_000, enabled: false },
    ]),
    bytes,
  )

  assert.match(sentence, /2 of 3 scripts would run now \(17 kB\)\./)
  assert.match(sentence, /covers all 3, including 413 kB switched off today/)
  assert.match(sentence, /They run in/)
})

test('a single running script among many still takes the singular', () => {
  // The case that needs both rules at once, and the one neither card exposed.
  const sentence = describeConsentAsk(
    consentFigures([
      { bytes: 50, enabled: true },
      { bytes: 900, enabled: false },
    ]),
    bytes,
  )

  assert.match(sentence, /1 of 2 scripts would run now/)
  assert.match(sentence, /It runs in an isolated sandbox/)
})
