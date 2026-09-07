/**
 * The reader's own turn must be findable on the page.
 *
 * Pinned after the first plum pass shipped user lines as quiet marginalia and
 * the user reported not seeing their own messages at all. What is asserted is
 * the mechanism, not the pixels: the user's body carries the wash and the plum
 * bar (the design's one "this is yours" idiom, shared with the selected sidebar
 * row), the label is plum, and the words are full ink - a user turn that only
 * differed from prose by weight and shade is exactly the failure this guards.
 *
 * @module iris-web/tests/user-turn
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const reading = readFileSync(join(root, 'src/app/reading.css'), 'utf8')

/** The declarations of one rule, by its exact selector. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`
${selector} {`)
  assert.notEqual(start, -1, `no rule for ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

test('the user turn stands on a wash with a plum bar, so it cannot pass for prose', () => {
  const body = rule(reading, '.iris-msg--user .iris-msg__body')
  assert.match(body, /background: var\(--iris-accent-wash\)/, 'the user turn lost its ground')
  assert.match(body, /border-left: 2px solid var\(--iris-accent\)/, 'the user turn lost its plum bar')
})

test('the user turn is set in full ink with a plum label, not stepped back', () => {
  const text = rule(reading, '.iris-msg--user .iris-msg__text')
  assert.match(text, /color: var\(--iris-ink\)/, 'the user words went back to a caption shade')
  assert.doesNotMatch(text, /--iris-ink-secondary|--iris-ink-tertiary/, 'the user words are stepped back again')
  const who = rule(reading, '.iris-msg--user .iris-msg__who')
  assert.match(who, /color: var\(--iris-accent\)/, 'the user label is not plum')
})

test('the wash-and-bar idiom stays the user turn alone in the reading column', () => {
  // The selected sidebar row uses the same idiom in shell.css; inside the
  // reading column it must mean one thing, or "yours" stops being readable.
  const washes = reading.match(/background: var\(--iris-accent-wash\)/g) ?? []
  assert.equal(washes.length, 1, `the accent wash is used ${String(washes.length)} times in reading.css; the user turn must be its only reader there`)
})
