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

/**
 * Class names under one prefix, wherever they appear.
 * @param source - the component or stylesheet to scan.
 * @param prefix - the family of class names to collect.
 * @returns every distinct name found.
 */
function classesWithPrefix(source: string, prefix: string): Set<string> {
  const found = new Set<string>()
  let at = 0
  for (;;) {
    const start = source.indexOf(prefix, at)
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

/**
 * The class families guarded here, and where each half lives.
 *
 * A table rather than one test per family, because the failure is the same in
 * every one of them and the second family was added the hard way: the state
 * panel's rules were deleted in a redesign while a dev probe two directories away
 * went on emitting the old names. Nothing failed. The probe simply lost its
 * styling, and would have stayed that way until somebody opened it.
 */
const GUARDED: readonly { prefix: string, emitters: string[][], styles: string[] }[] = [
  {
    prefix: 'iris-interfaces',
    emitters: [['src', 'app', 'MessageInterfaces.tsx']],
    styles: ['src', 'app', 'reading.css'],
  },
  {
    prefix: 'iris-var',
    emitters: [['src', 'app', 'StatePanel.tsx'], ['src', 'dev', 'SandboxProbe.tsx']],
    styles: ['src', 'app', 'panels.css'],
  },
]

for (const family of GUARDED) {
  test(`every ${family.prefix} class emitted has a rule, and every rule is used`, () => {
    const emitted = new Set<string>()
    for (const emitter of family.emitters) {
      const source = readFileSync(join(here, '..', ...emitter), 'utf8')
      for (const name of classesWithPrefix(source, family.prefix)) emitted.add(name)
    }
    const styled = classesWithPrefix(
      readFileSync(join(here, '..', ...family.styles), 'utf8'),
      family.prefix,
    )

    assert.ok(emitted.size > 0, `nothing emits any ${family.prefix} class at all`)

    const unstyled = [...emitted].filter(name => !styled.has(name))
    assert.deepEqual(
      unstyled,
      [],
      'these are emitted with no rule — the failure is silent, and last time it cost an interface its height',
    )

    const unused = [...styled].filter(name => !emitted.has(name))
    assert.deepEqual(unused, [], 'these rules match nothing, and will be read as live by the next reader')
  })
}

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

test('prose, a card interface and the composer are one width: nothing capped, nothing escaping', () => {
  /*
   * The 「梅花」 ruling, expressed as three declarations that must not be there.
   *
   * This assertion replaces its own opposite, and the history is the point. It
   * used to pin a *breakout*: the prose was capped at a 68ch book measure, a
   * card computed negative inline margins in `100cqi` against
   * `--iris-column-max` to escape that cap, and this guard held the arithmetic
   * to the bound it subtracted — plus a pairing check that `.iris-scroll` really
   * declared a container, because a stray `cqi` with no container falls back to
   * the viewport and computes a plausible wrong number in silence.
   *
   * canvas.json removes the cause instead of repairing the effect — 正文、卡的
   * 界面、输入框三者同宽 … 不留死槽 — so there is no cap left to escape and the
   * arithmetic is gone with it. What is worth guarding is that nobody puts
   * either half back: a `max-width` on the prose column or on the composer
   * restores the dead channel, and a negative inline margin on the slot pulls a
   * card past the page's own flanks.
   *
   * Asserted as absences, which is weaker than asserting a number and is the
   * honest shape here — the three widths are one grid track's, so there is no
   * number in any stylesheet to compare them against.
   */
  const reading = readFileSync(join(here, '..', 'src', 'app', 'reading.css'), 'utf8')
  const panels = readFileSync(join(here, '..', 'src', 'app', 'panels.css'), 'utf8')

  /** One rule's declarations, comments stripped and whitespace collapsed. */
  const rule = (styles: string, selector: string): string => {
    const at = styles.indexOf(selector)
    assert.notEqual(at, -1, `${selector} is gone`)
    // Comments first, and that is not tidiness: each of these rules explains
    // itself at length, and the words `max-width` and `cqi` appear in that
    // prose. Scanning the comment would make every assertion here vacuous.
    return dense(styles.slice(at, styles.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, ''))
  }

  const column = rule(reading, '.iris-column {')
  assert.ok(!column.includes('max-width'), 'the reading column is capped again, which is the dead channel back')

  const slot = rule(reading, '.iris-interfaces__slot {')
  assert.ok(
    !slot.includes('margin-inline-start') && !slot.includes('cqi'),
    'the interface slot is escaping the column again, and there is no cap left for it to escape',
  )

  const inner = rule(panels, '.iris-composer__inner {')
  assert.ok(!inner.includes('max-width'), 'the composer is capped again, so it no longer matches the prose')
})

test('the old book measure is still written once, wherever it is still read', () => {
  /*
   * It was copied into five places. That was survivable while it only had to
   * agree with itself; it stopped being survivable when the interface breakout
   * began subtracting it — a column at one width and a breakout computed from
   * another would misplace the card by exactly the difference.
   *
   * The breakout is gone and so is every layout consumer, but the formula still
   * has one reader: `--iris-column-max` feeds the `--sheldWidth` SillyTavern
   * alias (`theme/tokens.css`), which a card's inline HTML may read. So the
   * guard stands, one rung lower — retyping the formula is still how the alias
   * and the token drift apart.
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
