/**
 * Reporting a missing jQuery plugin method without pretending to have it.
 *
 * @module iris-web/tests/jquery-plugin-gap
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  installJQueryGapReporter,
  removeJQueryGapReporter,
} from '../src/sandbox/jquery-plugin-gap.ts'

/** A stand-in for jQuery: a prototype with one real method, and an instance. */
function jqueryLike() {
  const said: string[] = []
  const fn: Record<string, unknown> = {
    addClass(): string {
      return 'real'
    },
    jquery: '3.5.1',
  }
  const installed = installJQueryGapReporter({
    jquery: { fn },
    report: message => said.push(message),
  })
  const element = Object.create(fn) as Record<string, unknown>
  return { fn, element, said, installed }
}

test('a real method is untouched', () => {
  // The layer sits *beneath* `jQuery.fn`, so a lookup jQuery satisfies never
  // reaches it. If this ever fails, the proxy has been put in front instead.
  const { element, said } = jqueryLike()
  assert.equal((element['addClass'] as () => string)(), 'real')
  assert.equal(element['jquery'], '3.5.1')
  assert.deepEqual(said, [], 'a satisfied lookup must not be reported')
})

test('an existence guard sees the truth: not a function', () => {
  /*
   * The consumer shape that decided this design. A stub has to be a function to
   * be callable, and a function is truthy — so a card doing the careful thing
   * would pass its own guard and then explode on the call. The guard would
   * trigger exactly what it exists to prevent, which is the `SillyTavern`
   * surface's old failure in mirror image.
   *
   * `undefined` is also the honest answer: it is what this card would get from a
   * SillyTavern install without the plugin.
   */
  const { element } = jqueryLike()

  assert.equal(typeof element['draggable'], 'undefined')
  assert.equal(Boolean(element['draggable']), false, 'a truthy stub would defeat the guard')
})

test('the read is reported before the call can throw', () => {
  /*
   * The other consumer shape: a card that does not check. It gets a plain
   * `TypeError`, exactly as it would anywhere else — but the fact is already
   * recorded, because **the read always precedes the call**. That ordering is
   * what lets the report carry the diagnosis instead of an exception.
   */
  const { element, said } = jqueryLike()

  assert.throws(
    () => (element['draggable'] as () => void)(),
    TypeError,
    'calling an absent method must fail the way it fails everywhere else',
  )
  assert.equal(said.length, 1)
  assert.match(said[0] ?? '', /\$\.fn\.draggable/u)
  assert.match(said[0] ?? '', /jQuery UI and touch-punch are not in the message preset/u)
})

test('a name is reported once, however many times it is read', () => {
  // A card polling a slot would otherwise turn one absence into a stream.
  const { element, said } = jqueryLike()
  for (let turn = 0; turn < 5; turn += 1) void element['draggable']
  void element['sortable']

  assert.equal(said.length, 2)
})

test('`in` answers without reporting', () => {
  // `'draggable' in $el` is a question, not a use. Answering it truthfully is
  // the point, and reporting it would file a gap for a card that was checking.
  const { element, said } = jqueryLike()

  assert.equal('draggable' in element, false)
  assert.equal('addClass' in element, true)
  assert.deepEqual(said, [])
})

test('the language’s own reads are forwarded, not reported', () => {
  /*
   * `toString`, `hasOwnProperty`, `Symbol.iterator` and friends are read by the
   * runtime and by anything that stringifies or iterates a jQuery object. A card
   * asked for none of them, so reporting them would bury the real signal under
   * traffic nobody generated — and breaking them would break every consumer of
   * an ordinary object.
   */
  const { element, said } = jqueryLike()

  assert.equal(typeof element['toString'], 'function')
  assert.equal(typeof element['hasOwnProperty'], 'function')
  assert.equal(String(element), '[object Object]')
  assert.equal(JSON.stringify({ wrapped: 1 }), '{"wrapped":1}')
  assert.equal(element[Symbol.iterator as unknown as string], undefined)
  assert.deepEqual(said, [], 'runtime reads must not be reported as card behaviour')
})

test('enumeration is unaffected', () => {
  // `for..in` walks the prototype chain, and a proxy that answered `ownKeys`
  // carelessly would invent members on every jQuery object in the frame.
  const { element } = jqueryLike()
  const seen: string[] = []
  for (const key in element) seen.push(key)

  assert.deepEqual(seen.sort(), ['addClass', 'jquery'])
})

test('the layer can be removed, which is how a test knows it was a layer', () => {
  const { fn, element, said } = jqueryLike()
  void element['draggable']
  assert.equal(said.length, 1)

  assert.equal(removeJQueryGapReporter(fn), true)
  void element['sortable']
  assert.equal(said.length, 1, 'nothing should be reported once the layer is gone')
})

test('no jQuery means no installation, and no crash', () => {
  // The preset runs in a frame that may have failed to load jQuery at all. A
  // reporter that threw here would replace a missing library with a broken one.
  assert.equal(
    installJQueryGapReporter({ jquery: undefined, report: () => undefined }),
    false,
  )
  assert.equal(
    installJQueryGapReporter({ jquery: {}, report: () => undefined }),
    false,
  )
})
