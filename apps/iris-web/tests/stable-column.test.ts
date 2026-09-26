/**
 * The reading column does not move or resize when a flank opens or folds.
 *
 * Owner ruling 2026-09-26 (web §135). Measured before it: at ~2000px wide the
 * 920px column's centre sat at x≈1000 with both flanks folded and at x≈868
 * with the variable margin open, because the column was centred in whatever
 * track the flanks left. A move is the visible half; the costly half is a
 * width change, which reflows the column and re-measures every card frame in
 * it — on a heavy card, a visible stall per toggle.
 *
 * **This file evaluates the stylesheet's own declarations** rather than a
 * TypeScript copy of them: the anchor (`--iris-column-left`, `shell.css`) and
 * the places that read it — the column, the composer, the masthead's inset,
 * the card-interface toggle — are pulled out of the CSS and computed for every
 * flank state at 1920 and 1440. What the file does carry itself is which
 * track each flank state produces at a width, which is the table the
 * stylesheet's media blocks encode and `breakpoints.test.ts` holds; a real
 * browser caliper (`qa/stable-column-caliper.mjs`) closes the rest — layout,
 * the actual lane, and whether a frame re-measured.
 *
 * The teeth this has: a formula that centred in the track again, or read the
 * margin's width, gives four different boxes for the four states and fails
 * the equality below — which is the exact shape of the defect the owner
 * reported.
 *
 * @module iris-web/tests/stable-column
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ASIDE_FROM,
  ASIDE_TRACK,
  COLUMN_TRACK,
  FLANK_SLIDE_MS,
  FLANKS_DOCK_FROM,
  SCROLLBAR_LANE,
  SIDEBAR_RAIL,
  SIDEBAR_TRACK,
} from '../src/app/state-panel.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const shell = readFileSync(join(SRC, 'app', 'shell.css'), 'utf8')
const panels = readFileSync(join(SRC, 'app', 'panels.css'), 'utf8')
const reading = readFileSync(join(SRC, 'app', 'reading.css'), 'utf8')
const tokens = readFileSync(join(SRC, 'theme', 'tokens.css'), 'utf8')
const navigator = readFileSync(join(SRC, 'app', 'TurnNavigator.module.css'), 'utf8')

/** Stylesheet text with comments removed, so prose cannot satisfy a match. */
function bare(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * The value of one declaration inside the first rule whose selector is exactly
 * `selector` — exactly, because `.iris-shell .iris-sidebar__full` contains
 * `.iris-sidebar__full {` and a substring search reads the wrong rule.
 */
function declaration(css: string, selector: string, property: string): string {
  const rule = [...bare(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)].find(match => (match[1] ?? '').trim() === selector)
  assert.ok(rule !== undefined, `${selector} has no rule`)
  const body = rule[2] ?? ''
  const match = new RegExp(`(?:^|;|\\s)${property.replace(/[-]/g, '\\-')}\\s*:([^;]+);`).exec(body)
  assert.ok(match !== null, `${selector} declares no ${property}`)
  return (match[1] ?? '').trim()
}

/** A value's space-separated words, splitting only outside parentheses. */
function words(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0 && /\s/.test(character)) {
      if (current !== '') out.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') out.push(current)
  return out
}

/** A numeric custom property from the token sheet's structural block. */
function token(name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+)px;`).exec(tokens)
  assert.ok(match !== null, `${name} is not a pixel token`)
  return Number(match[1])
}

const COLUMN_MAX = token('--iris-column-max')
const GUTTER = token('--iris-gutter')
const ANCHOR = declaration(shell, '.iris-shell', '--iris-column-left')

/** The inputs one CSS expression is evaluated against. */
interface Box {
  /** The viewport width, for `100vw`. */
  vw: number
  /** The width `100%` resolves against, in the box of the rule reading it. */
  percent: number
  /** The sidebar's track width, `--iris-dock-left`. */
  dock: number
}

/**
 * Evaluate a length expression the way the browser would for these inputs.
 *
 * Covers exactly the vocabulary the anchor and its readers use — `calc`,
 * `min`, `max`, px, `100vw`, `100%` and the four custom properties — and fails
 * loudly on anything else, so a formula that grew a new term cannot be
 * evaluated as something it is not.
 */
function evaluate(expression: string, box: Box): number {
  let js = expression
    .replaceAll('var(--iris-column-left)', `(${ANCHOR})`)
    .replaceAll('var(--iris-column-left, 0px)', `(${ANCHOR})`)
  js = js
    .replaceAll('var(--iris-column-max)', String(COLUMN_MAX))
    .replaceAll('var(--iris-dock-left)', String(box.dock))
    .replaceAll('var(--iris-gutter)', String(GUTTER))
    .replaceAll('100vw', String(box.vw))
    .replaceAll('100%', String(box.percent))
    .replace(/(\d+(?:\.\d+)?)px/g, '$1')
    .replace(/\bcalc\(/g, '(')
    .replace(/\b(min|max)\(/g, 'Math.$1(')
  assert.match(js, /^[\d\s+\-*/().,Mathminax]*$/, `unevaluated term left in: ${js}`)
  return Number(new Function(`return (${js})`)())
}

/** The four flank states, named as a reader would. */
const STATES = [
  { name: 'both folded', nav: false, aside: false },
  { name: 'margin open', nav: false, aside: true },
  { name: 'sidebar open', nav: true, aside: false },
  { name: 'both open', nav: true, aside: true },
] as const

/**
 * Which tracks the flanks take at a width, in the state given — the table the
 * media blocks encode (`breakpoints.test.ts` holds its shape).
 */
function tracks(vw: number, nav: boolean, aside: boolean): { dock: number, right: number } {
  const docked = vw >= FLANKS_DOCK_FROM
  const dock = docked && nav ? SIDEBAR_TRACK : SIDEBAR_RAIL
  const right = vw < ASIDE_FROM ? 0 : docked && aside ? ASIDE_TRACK : token('--iris-aside-rail')
  return { dock, right }
}

for (const vw of [1920, 1440]) {
  test(`at ${String(vw)}px the column, composer, masthead and card toggle hold still in all four flank states`, () => {
    const seen = new Map<string, string[]>()
    for (const state of STATES) {
      const { dock, right } = tracks(vw, state.nav, state.aside)
      const sheet = vw - dock - right
      const scroller = sheet - SCROLLBAR_LANE

      // The column, in its scroller: margin-left is the anchor, width the cap.
      const columnLeft = evaluate(words(declaration(reading, '.iris-column', 'margin'))[3] ?? '', { vw, percent: scroller, dock })
      const columnWidth = Math.min(COLUMN_MAX, scroller - columnLeft)
      // The composer's box, in the sheet.
      const composerLeft = evaluate(words(declaration(panels, '.iris-composer__inner', 'margin'))[3] ?? '', { vw, percent: sheet, dock })
      const composerWidth = Math.min(COLUMN_MAX, sheet - composerLeft)
      // The masthead's content box, in the sheet.
      const padding = words(declaration(shell, '.iris-masthead', 'padding'))
      const mastLeft = evaluate(padding[3] ?? '', { vw, percent: sheet, dock })
      const mastRight = evaluate(padding[1] ?? '', { vw, percent: sheet, dock })
      // The card-interface toggle's right edge, in the card stage (the sheet).
      const toggleRight = evaluate(declaration(panels, '.iris-overlay-toggle', 'right'), { vw, percent: sheet, dock })
      // The turn rail, in the scroller.
      const rail = evaluate(declaration(navigator, '.rail', 'left'), { vw, percent: scroller, dock })

      // Everything in viewport coordinates: the sheet starts after the sidebar's track.
      const box = {
        column: [dock + columnLeft, columnWidth],
        composer: [dock + composerLeft, composerWidth],
        masthead: [dock + mastLeft, dock + sheet - mastRight],
        toggle: [dock + sheet - toggleRight],
        rail: [dock + rail],
      }
      for (const [what, value] of Object.entries(box)) {
        const list = seen.get(what) ?? []
        list.push(`${state.name}: ${value.join(' / ')}`)
        seen.set(what, list)
      }

      // Centred on the viewport, the cap wide, and — where the flanks dock —
      // clear of both of them, lane included.
      assert.equal(dock + columnLeft, (vw - COLUMN_MAX) / 2, `${state.name}: the column is not centred on the viewport`)
      assert.equal(columnWidth, COLUMN_MAX, `${state.name}: the column is not the cap wide`)
      assert.ok(columnLeft >= 0, `${state.name}: the column runs under the sidebar's track`)
      assert.ok(dock + columnLeft + columnWidth <= vw - right - SCROLLBAR_LANE, `${state.name}: the column runs into the margin's track`)
      // The field sits exactly under the prose.
      assert.deepEqual(box.composer, box.column, `${state.name}: the composer and the column part company`)
      assert.equal(dock + mastLeft, dock + columnLeft + GUTTER, `${state.name}: the title is not over the prose`)
    }
    // The ruling itself: every placement is one value across the four states.
    for (const [what, list] of seen) {
      const values = new Set(list.map(line => line.slice(line.indexOf(':') + 2)))
      assert.equal(values.size, 1, `the ${what} moves between flank states at ${String(vw)}px:\n  ${list.join('\n  ')}`)
    }
    assert.equal(seen.get('column')?.length, STATES.length, 'not every flank state was compared')
  })
}

test('the docking width is arithmetic over the declared widths, and the stylesheets use it', () => {
  assert.equal(COLUMN_TRACK, COLUMN_MAX, '`COLUMN_TRACK` is no longer --iris-column-max')
  assert.equal(SIDEBAR_RAIL, Number(/--iris-dock-left:\s*(\d+)px;/.exec(bare(shell))?.[1]), 'the base dock width is not the rail')
  assert.equal(FLANKS_DOCK_FROM, COLUMN_TRACK + 2 * Math.max(SIDEBAR_TRACK, ASIDE_TRACK + SCROLLBAR_LANE))
  // At the boundary each docked flank fits in its side space; one pixel under
  // it the margin's side cannot hold panel plus lane.
  const side = (FLANKS_DOCK_FROM - COLUMN_TRACK) / 2
  assert.ok(side >= SIDEBAR_TRACK && side >= ASIDE_TRACK + SCROLLBAR_LANE)
  assert.ok((FLANKS_DOCK_FROM - 1 - COLUMN_TRACK) / 2 < ASIDE_TRACK + SCROLLBAR_LANE)
  assert.ok(bare(shell).includes(`@media (min-width: ${String(FLANKS_DOCK_FROM)}px)`), 'the sidebar does not dock at FLANKS_DOCK_FROM')
  assert.ok(bare(panels).includes(`@media (min-width: ${String(FLANKS_DOCK_FROM)}px)`), 'the margin does not dock at FLANKS_DOCK_FROM')
  assert.ok(
    tokens.includes(`--iris-flank-slide: ${String(FLANK_SLIDE_MS)}ms`),
    'the margin keeps its tree mounted for a different time than its panel slides',
  )
})

test('a flank moves by transform only: no width transition, a still panel, and none at all under reduced motion', () => {
  /*
   * The track changes at once and the column does not read it; the motion is
   * a 400px panel sliding. A `width` transition anywhere on a flank would put
   * the reflow back on every frame of the gesture — the fold did exactly that,
   * over 220ms, until web §135.
   */
  for (const [file, css] of [['shell.css', shell], ['panels.css', panels]] as const) {
    const rules = [...bare(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    for (const [, selector = '', body = ''] of rules) {
      if (!/iris-sidebar|iris-aside/.test(selector)) continue
      const transition = /transition\s*:([^;]+);/.exec(body)?.[1] ?? ''
      assert.doesNotMatch(transition, /(^|[\s,])width\b/, `${file}: ${selector.trim()} transitions its width`)
    }
  }
  for (const [selector, css] of [['.iris-sidebar__full', shell], ['.iris-aside__panel', panels]] as const) {
    assert.match(declaration(css, selector, 'width'), /^(400px|var\(--iris-aside\))$/, `${selector} is not a fixed-width panel`)
    const properties = declaration(css, selector, 'transition').split(',').map(part => part.trim().split(/\s+/)[0])
    assert.deepEqual(properties.sort(), ['transform', 'visibility'], `${selector} animates more than its transform`)
    assert.match(declaration(css, selector, 'transition'), /var\(--iris-flank-slide\) var\(--iris-ease-out\)/)
  }
  for (const [selector, css] of [['.iris-sidebar__full', shell], ['.iris-aside__panel', panels]] as const) {
    const reduced = [...bare(css).matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(match => match[1] ?? '')
    assert.ok(
      reduced.some(block => new RegExp(`${selector.replace(/[.]/g, '\\.')}[^{]*\\{\\s*transition:\\s*none`).test(block)),
      `${selector} still slides under prefers-reduced-motion`,
    )
  }
})

test('while the branch compare mode is up, Escape belongs to it, not to a flank panel', () => {
  /*
   * The compare mode (web §134) leaves on Escape through a document listener
   * (`TreeMap.tsx`). The margin's panel handles Escape on the aside and stops
   * propagation — which, before the rebase that met §134, would have swallowed
   * the compare mode's key and closed the panel under the comparison instead.
   * Both flank handlers must step aside while comparing, and the margin's must
   * do so before it stops the event.
   */
  const panel = readFileSync(join(SRC, 'app', 'StatePanel.tsx'), 'utf8')
  const handler = panel.slice(panel.indexOf("if (event.key !== 'Escape' || !showing || !overlayNow()) return"))
  const yieldAt = handler.indexOf('|| comparing) return')
  const stopAt = handler.indexOf('event.stopPropagation()')
  assert.ok(yieldAt !== -1 && stopAt !== -1 && yieldAt < stopAt, 'the margin panel takes Escape from the compare mode')
  const sidebar = readFileSync(join(SRC, 'app', 'Sidebar.tsx'), 'utf8')
  assert.match(sidebar, /if \(comparing\) return\s*\n[^\n]*\n[^\n]*const target = event\.target/, 'the sidebar panel folds on the compare mode\u2019s Escape')
})
