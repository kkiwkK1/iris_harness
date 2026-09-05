import assert from 'node:assert/strict'
import { test } from 'node:test'

import { trimToEndSentence } from '../src/reply-trim.ts'

/**
 * `trim_sentences` ("trim incomplete sentences"): cutting a finished reply
 * back to its last complete sentence. The rule is upstream's `trimToEndSentence`
 * (`utils.js:883`), ported verbatim because the punctuation set decides where
 * real users' replies are cut — so these pins are upstream behaviour, not
 * this port's idea of it.
 */

test('a reply ending in a complete sentence is left alone', () => {
  assert.equal(trimToEndSentence('He stood. He turned!'), 'He stood. He turned!')
  assert.equal(trimToEndSentence('“Wait.”'), '“Wait.”')
})

test('a trailing incomplete clause is cut back to the last sentence end', () => {
  assert.equal(trimToEndSentence('He stood. He turned and'), 'He stood.')
  assert.equal(trimToEndSentence('He stood. He turned and then he'), 'He stood.')
})

test('the CJK closers are sentence ends too', () => {
  assert.equal(trimToEndSentence('他停下。风还在吹'), '他停下。')
  assert.equal(trimToEndSentence('「站住！」她说'), '「站住！」')
  assert.equal(trimToEndSentence('真的？她不知道'), '真的？')
})

test('an emoji ends a sentence, even beside whitespace', () => {
  assert.equal(trimToEndSentence('Nice! 😀'), 'Nice! 😀')
  assert.equal(trimToEndSentence('Nice! 😀 waving'), 'Nice! 😀')
})

test('punctuation preceded by whitespace does not end a sentence', () => {
  // Upstream's `… .` rule: a spaced dot is not a sentence end, so the scan
  // falls through to what precedes it.
  assert.equal(trimToEndSentence('yes . no more'), 'yes')
})

test('text with no cut point only loses trailing whitespace', () => {
  assert.equal(trimToEndSentence('no punctuation here   '), 'no punctuation here')
  assert.equal(trimToEndSentence('...   '), '...')
})

test('an empty reply comes back empty', () => {
  assert.equal(trimToEndSentence(''), '')
})
