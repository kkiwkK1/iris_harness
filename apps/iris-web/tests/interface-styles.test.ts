/**
 * The interface classes the component emits, and the rules that style them.
 *
 * This guard exists because a CSS selector that stops matching is **silent**.
 * The frames moved into per-instance slots, the stylesheet went on naming the
 * container they had left, and nothing anywhere said so — the rule simply
 * applied to no element. The visible result was an interface with no height,
 * which read as a broken card rather than as a renamed class.
 *
 * Two directions, because each fails differently:
 *
 * - a class the component emits with **no rule** is the regression above;
 * - a rule for a class **nothing emits** is a dead rule that will be read as
 *   live by the next person who tries to change how interfaces look.
 *
 * @module iris-web/tests/interface-styles
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))

/** Class names beginning `iris-interfaces`, wherever they appear. */
function interfaceClasses(source: string): Set<string> {
  const found = new Set<string>()
  const PREFIX = 'iris-interfaces'
  let at = 0
  for (;;) {
    const start = source.indexOf(PREFIX, at)
    if (start === -1) break
    let end = start
    // A class name runs while the characters are name-ish. Written as a scan
    // rather than a pattern, per this package's standing reason about escapes.
    while (end < source.length && /[A-Za-z0-9_-]/u.test(source.charAt(end))) end += 1
    found.add(source.slice(start, end))
    at = end
  }
  return found
}

test('every interface class the component emits has a rule, and every rule is used', () => {
  const component = readFileSync(join(here, '..', 'src', 'app', 'MessageInterfaces.tsx'), 'utf8')
  const styles = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')

  const emitted = interfaceClasses(component)
  const styled = interfaceClasses(styles)

  assert.ok(emitted.size > 0, 'the component emits no interface classes at all')

  const unstyled = [...emitted].filter(name => !styled.has(name))
  assert.deepEqual(
    unstyled,
    [],
    'these are emitted with no rule — the failure is silent, and last time it cost an interface its height',
  )

  const unused = [...styled].filter(name => !emitted.has(name))
  assert.deepEqual(unused, [], 'these rules match nothing, and will be read as live by the next reader')
})

test('the frame itself is given a starting height', () => {
  /*
   * Not a style preference. A card whose root is `html,body{height:100%}` has no
   * intrinsic height, and the one way it could ask — `window.frameElement`, as
   * the sample card's `fit()` does — is null across origins. Without a height
   * from the shell the card is 100% of nothing, reports nothing, and stays
   * invisible.
   */
  const styles = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')
  const at = styles.indexOf('.iris-interfaces__slot iframe')
  assert.notEqual(at, -1, 'nothing styles the frame element')

  const block = styles.slice(at, styles.indexOf('}', at))
  assert.match(block, /height:/u, 'the frame has no starting height, so a self-sizing card collapses')
  assert.match(block, /width:\s*100%/u, 'a frame narrower than its row would clip the card sideways')
})
