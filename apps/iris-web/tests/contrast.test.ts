/**
 * Contrast floors, computed from the tokens rather than trusted.
 *
 * This file exists because judgment failed twice on one 2px mark. The variant
 * rail's ticks shipped at 1.34:1 — a value that reads as a colour in a
 * stylesheet and as nothing at all on a screen. The fix moved them to 1.66:1,
 * which is 0.07 above the ratio this project had already condemned elsewhere as
 * a grey smudge, and it took someone opening the real page to notice that the
 * mark was legible only next to a brighter one beside it.
 *
 * A number in a comment did not prevent either round, because both times the
 * number was written by the same judgment that chose the colour. Computing it is
 * the only version of this check that can disagree with its author.
 *
 * @module iris-web/tests/contrast
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { SERIES_TOKENS, UNATTRIBUTED_STYLE } from '../src/app/usage-stats.ts'

const TOKENS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme', 'tokens.css'),
  'utf8',
)

/**
 * Read one theme's palette block and take one token's hex value from it.
 * @param name - the custom property, without the leading dashes.
 * @param theme - which block to read: the light palette (the second bare
 *   `:root` — the first holds typography, which no theme overrides), or one
 *   of the `data-iris-theme` override blocks.
 * @returns the hex string.
 */
function token(name: string, theme: 'light' | 'dark' | 'parchment'): string {
  let block: string | undefined
  if (theme === 'light') {
    const bare = [...TOKENS.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1])
    block = bare[1]
  } else {
    block = TOKENS.match(new RegExp(`:root\\[data-iris-theme='${theme}'\\]\\s*\\{([^}]*)\\}`))?.[1]
  }
  assert.ok(block !== undefined, `tokens.css has no ${theme} block`)
  const found = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
  assert.ok(found !== undefined, `--${name} has no ${theme} value`)
  return found
}

/** sRGB channel to linear light. */
function channel(value: number): number {
  const unit = value / 255
  return unit <= 0.03928 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4)
}

/** WCAG relative luminance of a hex colour. */
function luminance(hex: string): number {
  const packed = Number.parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((packed >> 16) & 255) +
    0.7152 * channel((packed >> 8) & 255) +
    0.0722 * channel(packed & 255)
  )
}

/**
 * WCAG contrast ratio between two hex colours.
 * @param one - a hex colour.
 * @param other - a hex colour.
 * @returns the ratio, between 1 and 21.
 */
function contrast(one: string, other: string): number {
  const a = luminance(one)
  const b = luminance(other)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

for (const theme of ['light', 'dark', 'parchment'] as const) {
  test(`the rail tick clears the non-text contrast floor in ${theme}`, () => {
    /*
     * 3:1 is WCAG 1.4.11, the floor for a UI component that carries meaning
     * rather than decorates. A tick reports how many readings a passage had and
     * which one is in the text, so it is information; the hairline borders it
     * used to share a colour with are not, which is why it has its own token.
     */
    const ratio = contrast(token('iris-tick', theme), token('iris-bg-page', theme))

    assert.ok(
      ratio >= 3,
      `--iris-tick is ${ratio.toFixed(2)}:1 on the page in ${theme}, below the 3:1 floor`,
    )
  })

  test(`the current tick still outranks the recorded ones in ${theme}`, () => {
    // Raising the floor must not flatten the rail. The mark for "you are here"
    // has to stay obviously louder than the marks for "this exists".
    const current = contrast(token('iris-accent', theme), token('iris-bg-page', theme))
    const recorded = contrast(token('iris-tick', theme), token('iris-bg-page', theme))

    assert.ok(
      current > recorded * 1.3,
      `the current tick (${current.toFixed(2)}:1) no longer stands out from the recorded ones (${recorded.toFixed(2)}:1)`,
    )
  })

  test(`the turn ordinal stays readable in ${theme}`, () => {
    /*
     * The other mark this project got wrong by measurement. It sat at 1.59:1 and
     * was correctly called a smudge; it is text, so 4.5:1 is its floor, and the
     * live reading confirmed 8.28:1 in dark.
     */
    const ratio = contrast(token('iris-ink-secondary', theme), token('iris-bg-page', theme))

    assert.ok(ratio >= 4.5, `--iris-ink-secondary is ${ratio.toFixed(2)}:1 in ${theme}`)
  })
}

/**
 * The usage chart's series palette, computed against the card it is drawn on.
 *
 * The chart's lines are the reason this block exists rather than a comment: a
 * series a reader cannot see is a model whose cost is invisible, which is the
 * exact opposite of that page's purpose, and the palette was chosen by reading
 * hex values out of `tokens.css` — the judgment this file's header records
 * failing twice.
 *
 * **3:1, against `--iris-bg-raised`.** WCAG 1.4.11: a line on a chart carries
 * meaning rather than decorating, and `--iris-bg-raised` is what
 * `.iris-usage__plot` paints behind it. Two candidates were rejected on this
 * measurement — `--iris-accent-quiet` (2.93:1 in dark) and `--iris-tick`
 * (2.79:1 in dark, where its own floor is against `--iris-bg-page`) — so the
 * check has already changed the palette once and is not decoration.
 *
 * The token list is imported rather than copied, so a seventh colour added to
 * the chart is measured here without anyone remembering to add it.
 */
for (const theme of ['light', 'dark', 'parchment'] as const) {
  test(`every usage-chart series colour clears the non-text floor in ${theme}`, () => {
    const names = SERIES_TOKENS.map(reference => {
      const found = /^var\(--([a-z-]+)\)$/u.exec(reference)?.[1]
      assert.ok(found !== undefined, `${reference} is not a plain token reference`)
      return found
    })
    // A floor on the sample: an empty palette would pass this loop in silence.
    assert.ok(names.length >= 4, `only ${String(names.length)} series colours were checked`)

    for (const name of names) {
      const ratio = contrast(token(name, theme), token('iris-bg-raised', theme))
      assert.ok(
        ratio >= 3,
        `--${name} is ${ratio.toFixed(2)}:1 on the chart card in ${theme}, below the 3:1 floor`,
      )
    }
  })

  test(`the unattributed line clears the same floor in ${theme}`, () => {
    /*
     * **The line every reader has today**, and it was outside this loop.
     * `SERIES_TOKENS` is the palette for *named* models, and the records that
     * name none were drawn in `--iris-tick` — one of the two tokens this file
     * had already rejected from that palette, at 2.79:1 in 墨. Measured over
     * the corpus on 2026-09-08 every usage record is unattributed, so the
     * failing colour was the only line most readers would ever see, and the
     * check that would have said so was reading the other list.
     *
     * The constant is imported rather than named here, so moving it moves this
     * measurement with it.
     */
    const name = /^var\(--([a-z-]+)\)$/u.exec(UNATTRIBUTED_STYLE.color)?.[1]
    assert.ok(name !== undefined, `${UNATTRIBUTED_STYLE.color} is not a plain token reference`)
    const ratio = contrast(token(name, theme), token('iris-bg-raised', theme))
    assert.ok(
      ratio >= 3,
      `--${name} is ${ratio.toFixed(2)}:1 on the chart card in ${theme}, below the 3:1 floor`,
    )
  })

  test(`the usage chart's gridlines stay quieter than its lines in ${theme}`, () => {
    // The gridlines are scaffolding and the series are the data. If a rule were
    // as loud as a line, the chart would read as more series than it has.
    // Both rules the chart draws: the interior gridlines and the baseline, which
    // is deliberately one step louder than they are and still must not reach the
    // faintest line — including the unattributed one, which is quieter than
    // every named model's colour and is therefore the binding case.
    const quietest = Math.min(...[...SERIES_TOKENS, UNATTRIBUTED_STYLE.color].map(reference => {
      const name = /^var\(--([a-z-]+)\)$/u.exec(reference)?.[1] ?? ''
      return contrast(token(name, theme), token('iris-bg-raised', theme))
    }))
    for (const name of ['iris-rule-faint', 'iris-rule']) {
      const rule = contrast(token(name, theme), token('iris-bg-raised', theme))
      assert.ok(
        quietest > rule,
        `the faintest line (${quietest.toFixed(2)}:1) is no louder than --${name} (${rule.toFixed(2)}:1)`,
      )
    }
  })
}
