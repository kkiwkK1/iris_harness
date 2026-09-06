/**
 * The per-script preamble.
 *
 * Small enough to look obviously right, which is why it is tested: the two ways
 * it can be wrong are both silent. A preamble that misses a member leaves that
 * member answering for whichever script ran last, and a preamble that spans two
 * lines makes every syntax error a card author sees point at the wrong line of
 * their own file.
 *
 * @module iris-web/tests/preamble
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { identityMembers } from '../src/sandbox/identity.ts'
import { PREAMBLE_LINES, WINDOW_GLOBAL, preambleFor, withPreamble } from '../src/sandbox/preamble.ts'

test('the preamble binds every identity-bearing member', () => {
  // Derived from the classification rather than restated, so a member promoted
  // to `identity` is bound without anyone remembering to come here.
  const line = preambleFor('card-1')

  for (const member of identityMembers()) {
    assert.ok(line.includes(member), `${member} is identity-bearing but is not bound per script`)
  }
})

test('the preamble shadows window with the published shadow, in the same line', () => {
  /*
   * A module cannot be handed the shadow as a parameter and `top` cannot be
   * published onto the real window, so the shadow rides a published name and a
   * lexical binding. Reading it off `globalThis` — not a bare identifier —
   * because a bare `__iris_window__` that somehow never got published would
   * throw a ReferenceError and stop the whole body, where a `globalThis` read
   * yields undefined and fails where the card uses it.
   */
  const line = preambleFor('card-1')

  assert.ok(
    line.includes(`const window=globalThis.${WINDOW_GLOBAL}`),
    'the module window is not the shadow a classic body receives as a parameter',
  )
})

test('the preamble is exactly one line', () => {
  /*
   * Every line here is a line a card author must subtract from the line number
   * in their error before it points at their own source. One is the smallest
   * offset that still lets the bindings precede the body — trailing them would
   * put the card's own statements in the bindings' temporal dead zone.
   */
  const line = preambleFor('card-1')

  assert.equal(line.split('\n').length - 1, PREAMBLE_LINES)
  assert.ok(line.endsWith('\n'))
})

test('a script id reaching source is escaped, not interpolated raw', () => {
  /*
   * The id comes from the host, so this is not defence against the host. It is
   * the rule that a value crossing into evaluated text gets escaped whatever its
   * provenance — the alternative is a quote in an id silently ending the literal
   * and starting to be code.
   */
  const line = preambleFor('it\'s "quoted" \ odd')

  assert.ok(line.includes(JSON.stringify('it\'s "quoted" \ odd')))
  assert.equal(line.split('\n').length - 1, 1, 'an escaped id must not add lines either')
})

test('a body with no script id still gets its bindings', () => {
  // A file dragged in from disk has no entry in the host's list. It still needs
  // the members; they just answer `undefined` for identity.
  const line = preambleFor(undefined)

  assert.ok(line.includes('undefined'))
  assert.ok(line.includes('getScriptId'))
})

test('the body follows the preamble unchanged', () => {
  const body = 'const x = 1\nexport {}'
  const source = withPreamble('a', body)

  assert.ok(source.endsWith(body), 'the card source must not be rewritten')
  assert.equal(source.split('\n').length, body.split('\n').length + PREAMBLE_LINES)
})
