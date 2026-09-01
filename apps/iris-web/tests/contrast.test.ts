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

const TOKENS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme', 'tokens.css'),
  'utf8',
)

/**
 * Read one token's hex value from a theme block.
 * @param name - the custom property, without the leading dashes.
 * @param theme - which block to read: the bare `:root`, or the dark override.
 * @returns the hex string.
 */
function token(name: string, theme: 'light' | 'dark'): string {
  // The dark block is the second definition of every token in this file, which
  // is the same order the cascade relies on.
  const all = [...TOKENS.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))]
  const at = theme === 'light' ? 0 : 1
  const found = all[at]?.[1]
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

for (const theme of ['light', 'dark'] as const) {
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
