/**
 * The built-in themes: their tables, their floors, and their scrollbars.
 *
 * A theme in Iris is a table of `--iris-*` overrides (`theme/presets.ts`) and,
 * at the same time, a block of the same properties in `theme/tokens.css` — the
 * block exists so the stored theme paints before the bundle does, the table so
 * the same palette can be exported, imported and drawn as preview swatches.
 * Saying a palette twice is how the two copies drift, so this file holds them
 * together: it parses `tokens.css` and compares it, value for value, against
 * the tables.
 *
 * It also computes the readability floors from the values rather than trusting
 * them, because judgment failed twice on one 2px mark before this project
 * learned that a number in a comment is written by the same judgment that
 * chose the colour (see `contrast.test.ts` for that history). Every built-in
 * is held to: body ink ≥ 4.5:1 on the page, secondary ink ≥ 4.5:1, the
 * variant-rail tick ≥ 3:1 (WCAG 1.4.11 — a mark that carries information), and
 * the accent clearly louder than the tick.
 *
 * @module iris-web/tests/theme-presets
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { THEME_PRESETS, THEME_TOKENS } from '../src/theme/presets.ts'

const TOKENS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme', 'tokens.css'),
  'utf8',
)

/** The ids, in the order the blocks appear in `tokens.css`. */
const THEME_IDS = ['light', 'dark', 'parchment'] as const

/**
 * Read one theme's palette block out of `tokens.css`.
 *
 * The light palette lives in the second bare `:root` block (the first holds
 * typography and rhythm, which no theme overrides); the others live under
 * their `data-iris-theme` attribute, which is the same selector the cascade
 * resolves.
 */
function blockOf(theme: (typeof THEME_IDS)[number]): string {
  if (theme === 'light') {
    const bare = [...TOKENS.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1])
    const second = bare[1]
    assert.ok(second !== undefined, 'tokens.css has no light palette block')
    return second
  }
  const match = TOKENS.match(new RegExp(`:root\\[data-iris-theme='${theme}'\\]\\s*\\{([^}]*)\\}`))
  const body = match?.[1]
  assert.ok(body !== undefined, `tokens.css has no ${theme} block`)
  return body
}

/**
 * Parse a block into a token map, values kept verbatim (hex, `rgb()`,
 * multi-part shadows — whatever the cascade would receive).
 */
function tokensOf(theme: (typeof THEME_IDS)[number]): Record<string, string> {
  const table: Record<string, string> = {}
  for (const match of blockOf(theme).matchAll(/(--iris-[a-z-]+):\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name === undefined || value === undefined) continue
    table[name] = value.trim()
  }
  return table
}

for (const id of THEME_IDS) {
  const parsed = tokensOf(id)
  const preset = THEME_PRESETS.find(row => row.id === id)
  assert.ok(preset !== undefined, `${id} has no preset table`)

  test(`the ${id} preset table and its tokens.css block are the same palette`, () => {
    assert.deepEqual(preset.tokens, parsed)
  })

  test(`every built-in sets exactly the palette properties in ${id}`, () => {
    assert.deepEqual(Object.keys(preset.tokens).sort(), [...THEME_TOKENS].sort())
    assert.deepEqual(Object.keys(parsed).sort(), [...THEME_TOKENS].sort())
  })

  test(`body ink clears the text floor in ${id}`, () => {
    // The prose the product exists to carry. 4.5:1 is WCAG 1.4.3's floor for
    // body text; ink is the darkest colour a theme owns, so everything set in
    // it is covered by this one number.
    const ratio = contrast(preset.tokens['--iris-ink'], preset.tokens['--iris-bg-page'])
    assert.ok(ratio >= 4.5, `--iris-ink is ${ratio.toFixed(2)}:1 on the page in ${id}`)
  })

  test(`secondary ink clears the text floor in ${id}`, () => {
    const ratio = contrast(preset.tokens['--iris-ink-secondary'], preset.tokens['--iris-bg-page'])
    assert.ok(ratio >= 4.5, `--iris-ink-secondary is ${ratio.toFixed(2)}:1 in ${id}`)
  })

  test(`the rail tick clears the non-text floor in ${id}`, () => {
    const ratio = contrast(preset.tokens['--iris-tick'], preset.tokens['--iris-bg-page'])
    assert.ok(ratio >= 3, `--iris-tick is ${ratio.toFixed(2)}:1 in ${id}, below the 3:1 floor`)
  })

  test(`the accent still outranks the tick in ${id}`, () => {
    const accent = contrast(preset.tokens['--iris-accent'], preset.tokens['--iris-bg-page'])
    const tick = contrast(preset.tokens['--iris-tick'], preset.tokens['--iris-bg-page'])
    assert.ok(accent > tick * 1.3, `accent ${accent.toFixed(2)}:1 does not stand out from tick ${tick.toFixed(2)}:1`)
  })
}

test('the scrollbar follows the theme (the task-O token acceptance)', () => {
  /*
   * The scrollbar's colour is two tokens consumed by one rule drawn once for
   * every surface (`tokens.css`), so "the bar follows the theme" reduces to a
   * data claim: each theme defines its own pair, and no two themes agree — a
   * dark page that kept the light desk's scrollbar would fail exactly here.
   */
  const bars = THEME_IDS.map(id => [
    THEME_PRESETS.find(row => row.id === id)?.tokens['--iris-scrollbar'],
    THEME_PRESETS.find(row => row.id === id)?.tokens['--iris-scrollbar-strong'],
  ])
  for (const [at, one] of bars.entries()) {
    assert.ok(one[0] !== undefined && one[1] !== undefined, `theme ${THEME_IDS[at]} defines no scrollbar`)
  }
  for (let a = 0; a < bars.length; a += 1) {
    for (let b = a + 1; b < bars.length; b += 1) {
      assert.notDeepEqual(bars[a], bars[b], `${THEME_IDS[a]} and ${THEME_IDS[b]} share a scrollbar`)
    }
  }
})

test('no two built-ins are the same theme', () => {
  const pages = THEME_IDS.map(id => THEME_PRESETS.find(row => row.id === id)?.tokens['--iris-bg-page'])
  assert.deepEqual(new Set(pages).size, THEME_IDS.length)
})

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
 * @returns the ratio, between 1 and 21.
 */
function contrast(one: string, other: string): number {
  const a = luminance(one)
  const b = luminance(other)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
