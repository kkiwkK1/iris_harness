/**
 * SillyTavern's theme variable names, present on the Iris page root.
 *
 * Upstream renders a message's inline HTML into the page, where a card's
 * `var(--SmartThemeBodyColor)` resolves against the page's own theme. Iris does
 * the same rendering (`app/inline-html.ts`, `app/card-css.ts`) and so must have
 * the same names, or the same declaration silently falls away here. The aliases
 * live in `theme/tokens.css`, whose comment carries the reasoning (upstream has
 * the mechanism; the corpus has 0 of 29 cards using it; added by mechanism
 * anyway, and only on the page root — a card frame has none of these upstream
 * either).
 *
 * The name list is the table in `notes/UPSTREAM-THEME-VARS.md` §七, which reads
 * `[ST] public/style.css` lines 71-104 (2026-09-06): 16 `--SmartTheme*` names
 * declared there, plus 7 typography and geometry names. Two are deliberately
 * absent: `--SmartThemeFastUIBGColor` is commented out upstream, so a card
 * reading it resolves to nothing there too, and `--SmartThemeCheckboxBgColorA`
 * is written only by JS and consumed by nothing. Retyped rather than read from
 * the install, because a test that skips without a SillyTavern checkout would
 * move the corpus-skip count that `scripts/check-corpus-skips.mjs` pins, and
 * this list changes on the order of years.
 *
 * @module iris-web/tests/st-theme-aliases
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const TOKENS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme', 'tokens.css'),
  'utf8',
)

/** `[ST] style.css:71-87` — the colour names a theme picker rewrites, one value per theme. */
const THEMED = [
  '--SmartThemeBodyColor',
  '--SmartThemeEmColor',
  '--SmartThemeUnderlineColor',
  '--SmartThemeQuoteColor',
  '--SmartThemeBlurTintColor',
  '--SmartThemeChatTintColor',
  '--SmartThemeUserMesBlurTintColor',
  '--SmartThemeBotMesBlurTintColor',
  '--SmartThemeShadowColor',
  '--SmartThemeBorderColor',
  '--SmartThemeCheckboxBgColorR',
  '--SmartThemeCheckboxBgColorG',
  '--SmartThemeCheckboxBgColorB',
] as const

/**
 * `[ST] style.css:80, 86-89, 92-104` — names whose value is a formula over the
 * others or a setting no theme changes, defined once on the root.
 */
const INVARIANT = [
  '--SmartThemeBlurStrength',
  '--SmartThemeCheckboxTickColorValue',
  '--SmartThemeCheckboxTickColor',
  '--mainFontFamily',
  '--monoFontFamily',
  '--mainFontSize',
  '--fontScale',
  '--sheldWidth',
  '--blurStrength',
  '--shadowWidth',
] as const

/** The bare `:root` blocks in file order: structural first, light palette second. */
const BARE = [...TOKENS.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1] ?? '')

/** One theme's palette block; the same selectors `contrast.test.ts` reads. */
function palette(theme: 'light' | 'dark' | 'parchment'): string {
  if (theme === 'light') {
    const block = BARE[1]
    assert.ok(block !== undefined, 'tokens.css has no light palette block')
    return block
  }
  const block = TOKENS.match(new RegExp(`:root\\[data-iris-theme='${theme}'\\]\\s*\\{([^}]*)\\}`))?.[1]
  assert.ok(block !== undefined, `tokens.css has no ${theme} block`)
  return block
}

/** Declarations of `name` in a block, values trimmed. */
function valuesOf(block: string, name: string): string[] {
  return [...block.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map(match => match[1]?.trim() ?? '')
}

const THEMES = ['light', 'dark', 'parchment'] as const

test('every themed SillyTavern colour name is defined once in each of the three palette blocks', () => {
  for (const theme of THEMES) {
    const block = palette(theme)
    for (const name of THEMED) {
      const values = valuesOf(block, name)
      assert.equal(values.length, 1, `${theme}: ${name} defined ${values.length} times`)
    }
  }
})

test('the themed names map to the same Iris tokens in every theme; only the channel literals differ', () => {
  // The aliases are one policy, not three: a theme is allowed to change what
  // `--iris-ink` is, not what `--SmartThemeBodyColor` means. Channels are the
  // exception, checked in the next test.
  const [reference, ...others] = THEMES
  for (const name of THEMED) {
    if (name.startsWith('--SmartThemeCheckboxBgColor')) continue
    const expected = valuesOf(palette(reference), name)[0]
    assert.match(expected ?? '', /^var\(--iris-[a-z-]+\)$/, `${name} is not an alias of one Iris token: ${expected}`)
    for (const theme of others) {
      assert.equal(valuesOf(palette(theme), name)[0], expected, `${theme}: ${name} maps differently from ${reference}`)
    }
  }
})

test('the checkbox channels are the body colour written out, per theme, as upstream relates them', () => {
  // `[ST] style.css:71,83-85`: BodyColor rgb(220,220,210) and channels
  // 220/220/210 — the checkbox ground is the body colour. Ours aliases body to
  // `--iris-ink`, so the channels must be that hex, recomputed here rather than
  // trusted, because a retyped channel is a number nobody re-reads.
  for (const theme of THEMES) {
    const block = palette(theme)
    assert.equal(valuesOf(block, '--SmartThemeBodyColor')[0], 'var(--iris-ink)')
    const ink = block.match(/--iris-ink:\s*#([0-9a-fA-F]{6});/)?.[1]
    assert.ok(ink !== undefined, `${theme} has no hex --iris-ink`)
    const expected = [0, 2, 4].map(at => Number.parseInt(ink.slice(at, at + 2), 16))
    const actual = ['R', 'G', 'B'].map(channel => Number(valuesOf(block, `--SmartThemeCheckboxBgColor${channel}`)[0]))
    assert.deepEqual(actual, expected, `${theme}: checkbox channels are not --iris-ink #${ink}`)
  }
})

test('the invariant names are defined once, on the structural root, and in no palette block', () => {
  const structural = BARE[0]
  assert.ok(structural !== undefined, 'tokens.css has no structural :root block')
  for (const name of INVARIANT) {
    assert.equal(valuesOf(structural, name).length, 1, `${name} is not defined once on the structural root`)
    for (const theme of THEMES) {
      assert.equal(valuesOf(palette(theme), name).length, 0, `${theme} redefines ${name}, which no theme changes upstream`)
    }
  }
  // The two fonts are the Iris stacks, not a retyped list: a stack written twice
  // is the drift `tokens.css` already warns about for the token tables.
  assert.equal(valuesOf(structural, '--mainFontFamily')[0], 'var(--iris-font-prose)')
  assert.equal(valuesOf(structural, '--monoFontFamily')[0], 'var(--iris-font-mono)')
})

test('the three multipliers stay unitless, as upstream multiplies them', () => {
  // `[ST] style.css:80,96,140`: `calc(var(--blurStrength) * 1px)`,
  // `calc(var(--fontScale) * 15px)`, `calc(var(--shadowWidth) * 1px)`. A unit on
  // any of these makes every upstream `calc()` over it invalid, and a card
  // copying upstream's idiom would lose the effect with no error anywhere.
  const structural = BARE[0] ?? ''
  for (const name of ['--fontScale', '--blurStrength', '--shadowWidth']) {
    const value = valuesOf(structural, name)[0]
    assert.match(value ?? '', /^\d+(\.\d+)?$/, `${name} must be a bare number, got: ${value}`)
  }
})

test('the aliases stay on the page root: nothing under src/sandbox names them', () => {
  // A card frame has none of these upstream (its document is its own origin),
  // so handing them to our frames would be an invention, not parity — tracked
  // separately, per tokens.css. This pins the "only the page root" half.
  const sandbox = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox')
  const offenders = readdirSync(sandbox, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx|css)$/.test(entry.name))
    .filter(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8').includes('--SmartTheme'))
    .map(entry => entry.name)
  assert.deepEqual(offenders, [], 'sandbox code names SillyTavern theme variables')
})
