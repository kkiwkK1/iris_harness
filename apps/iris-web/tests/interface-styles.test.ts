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

/**
 * A declaration with every space removed, so a comparison can ignore formatting.
 * @param text - the CSS to flatten.
 * @returns the same text with all whitespace dropped.
 */
function dense(text: string): string {
  return [...text].filter(character => character > ' ').join('')
}

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

test('the interface breakout and the container it measures against travel together', () => {
  /*
   * A pairing guard, the same shape as the CORS one. `100cqi` in the slot rule
   * is not an error when no ancestor is a container — it falls back to the small
   * viewport, silently, and the breakout computes a plausible wrong number. So
   * the two halves are asserted against each other rather than each alone.
   */
  const styles = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')

  const slotAt = styles.indexOf('.iris-interfaces__slot {')
  assert.notEqual(slotAt, -1, 'the slot rule is gone')
  const slot = styles.slice(slotAt, styles.indexOf('}', slotAt))

  if (slot.includes('cqi')) {
    const scrollAt = styles.indexOf('.iris-scroll {')
    const scroll = styles.slice(scrollAt, styles.indexOf('}', scrollAt))
    /*
     * Compared as a scan, not a pattern. The first cut of this assertion was
     * written with an escape in it, the escape was eaten before it reached the
     * file, and the surviving regex asked for a literal `s` — so the guard
     * failed against a stylesheet that was correct. The whole reason this
     * package prefers scanning is that a collapsed escape still parses.
     */
    assert.ok(
      dense(scroll).includes('container-type:inline-size'),
      'the slot measures in cqi but nothing declares a container — cqi would fall back to the viewport and be quietly wrong',
    )
  }

  assert.match(
    slot,
    /--iris-column-max/u,
    'the breakout must be computed from the bound it escapes, not from a repeated literal that can drift from it',
  )
})

test('the bound four surfaces align to is written once', () => {
  /*
   * It was copied into five places. That was survivable while it only had to
   * agree with itself; it stopped being survivable when the interface breakout
   * began subtracting it — a column at one width and a breakout computed from
   * another would misplace the card by exactly the difference.
   */
  const repeated = 'var(--iris-gutter) + var(--iris-measure) + 40px'
  for (const name of ['reading.css', 'panels.css', 'shell.css']) {
    const styles = readFileSync(join(here, '..', 'src', 'app', name), 'utf8')
    assert.equal(
      styles.includes(repeated),
      false,
      `${name} recomputes the column bound instead of using --iris-column-max`,
    )
  }
})
