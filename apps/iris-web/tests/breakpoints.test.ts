/**
 * The window's width intervals, and that each flank has a rule in every one.
 *
 * The shell has three width breakpoints and four intervals, and the audit that
 * produced this file was looking for two failures a stylesheet never reports: an
 * interval where two rules disagree, and an interval where the thing has **no**
 * rule at all. One of each turned up — the settings drawer taking a column while
 * the variable margin also had one (fixed in `state-panel.ts`, 让位), and the
 * sidebar's dismiss scrim, which the shell renders from `navOpen` alone and
 * which therefore covered the whole page, invisibly, at every width above the
 * one where the sidebar slides.
 *
 * ```
 *   ≤ 880      sidebar slides over the page   margin hidden   drawer overlays
 *   881–1303   sidebar is a column            margin hidden   drawer overlays
 *   1304–1359  sidebar is a column            margin hidden   drawer is a track
 *   1360–1539  sidebar is a column            236 or 36 …     drawer is a track
 *              …and an open drawer takes the margin's column (ASIDE_YIELD_QUERY)
 *   ≥ 1540     sidebar is a column            236 or 36       drawer is a track
 * ```
 *
 * What is asserted is the *shape* of that table, not its numbers: each of the
 * three flanks has a base rule and exactly one width rule that overrides it, so
 * no interval is left to a default nobody chose. The one number pinned is the
 * **set** of breakpoints, because a fourth one is a fifth interval, and the
 * table above is then out of date without anything saying so.
 *
 * @module iris-web/tests/breakpoints
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ASIDE_FROM, DRAWER_TRACK_FROM } from '../src/app/state-panel.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app')

/** The stylesheets that lay the shell out. `reading.css` styles inside it. */
const SHEETS = ['shell.css', 'panels.css', 'reading.css'] as const

/** One `@media` block: its condition, and the text between its braces. */
interface MediaBlock {
  condition: string
  body: string
}

/**
 * Split a stylesheet into its `@media` blocks and everything else.
 *
 * Brace-counted rather than pattern-matched, because a media block contains
 * whole rules and `[^}]*` stops at the first inner brace — a bug that would
 * make every assertion below read only the first rule of each block.
 * @param css - the stylesheet.
 * @returns the media blocks, and the base text with them removed.
 */
function split(css: string): { blocks: MediaBlock[], base: string } {
  const blocks: MediaBlock[] = []
  let base = ''
  let at = 0
  for (;;) {
    const start = css.indexOf('@media', at)
    if (start === -1) {
      base += css.slice(at)
      break
    }
    base += css.slice(at, start)
    const open = css.indexOf('{', start)
    if (open === -1) {
      base += css.slice(start)
      break
    }
    let depth = 0
    let close = open
    for (let scan = open; scan < css.length; scan += 1) {
      const character = css.charAt(scan)
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          close = scan
          break
        }
      }
    }
    blocks.push({
      condition: css.slice(start + '@media'.length, open).trim(),
      body: css.slice(open + 1, close),
    })
    at = close + 1
  }
  return { blocks, base }
}

/** Every width breakpoint in one stylesheet, as `min`/`max` and the pixels. */
function widths(css: string): { edge: string, px: number }[] {
  return split(css).blocks.flatMap(one =>
    [...one.condition.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)]
      .map(match => ({ edge: match[1] ?? '', px: Number(match[2]) })))
}

test('the shell has exactly the three width breakpoints the interval table covers', () => {
  /*
   * Not a count for its own sake: a breakpoint is an interval boundary, and an
   * interval nobody enumerated is an interval nobody checked the sidebar, the
   * margin and the drawer in. If a fourth is added on purpose, add it to the
   * table in this file's header at the same time — that is the whole point of
   * the assertion, and bumping the list without the table defeats it.
   */
  const found = SHEETS.flatMap(sheet => widths(readFileSync(join(APP, sheet), 'utf8')))
  const seen = [...new Set(found.map(one => `${one.edge}:${String(one.px)}`))].sort()
  assert.deepEqual(seen, ['max:880', `min:${String(DRAWER_TRACK_FROM)}`, `min:${String(ASIDE_FROM)}`].sort(), [
    'the width breakpoints changed. The interval table in this file describes',
    'the sidebar, the variable margin and the settings drawer at every width;',
    'update it, then update this list.',
  ].join(' '))
})

test('each flank has a base rule and one width rule, so no interval is a default', () => {
  /*
   * The failure this catches is the one shape a stylesheet cannot report: a
   * selector styled only inside a media block, so that below (or above) it the
   * element falls back to whatever the UA and the cascade happen to give it. The
   * drawer's own comment argues the same discipline from the other side — the
   * safe form is the base rule, the wide form is the override.
   */
  const shell = readFileSync(join(APP, 'shell.css'), 'utf8')
  const panels = readFileSync(join(APP, 'panels.css'), 'utf8')

  const cases: { what: string, selector: string, base: string, over: string, edge: string }[] = [
    // The sidebar is a grid column by default and slides on a narrow window.
    { what: 'the sidebar', selector: '.iris-sidebar', base: shell, over: panels, edge: '(max-width: 880px)' },
    // The margin is absent by default and appears where there is room for it.
    { what: 'the variable margin', selector: '.iris-aside', base: panels, over: panels, edge: `(min-width: ${String(ASIDE_FROM)}px)` },
    // The drawer overlays by default and becomes a track on a wide window.
    { what: 'the settings drawer', selector: '.iris-drawer', base: panels, over: panels, edge: `(min-width: ${String(DRAWER_TRACK_FROM)}px)` },
  ]

  for (const one of cases) {
    const { base } = split(one.base)
    assert.ok(
      base.includes(`${one.selector} {`),
      `${one.what} has no rule outside a media query: one interval is left to the cascade`,
    )
    const block = split(one.over).blocks.find(candidate => candidate.condition === one.edge)
    assert.ok(block !== undefined, `${one.what} lost its ${one.edge} block`)
    assert.ok(
      block.body.includes(`${one.selector} {`),
      `${one.edge} no longer says anything about ${one.what}`,
    )
  }
})

test('the dismiss scrim exists only where there is a sliding sidebar to dismiss', () => {
  /*
   * The gap this closes, measured by reading `App.tsx`: the scrim renders from
   * `navOpen` and nothing else, and `navOpen` survives a window that got wider —
   * a rotated tablet, a dragged frame, a phone layout opened and then maximised.
   * Above 880px the sidebar is a column that overlays nothing, so the scrim was
   * a full-viewport click-catcher with no background: invisible, and the
   * reader's next click anywhere on the page was spent dismissing it.
   *
   * Fixed in CSS rather than in the shell's state, deliberately. The scrim is
   * *for* the overlay sidebar, so its lifetime belongs to the same media query
   * that creates the overlay — and a state fix would have had `App` watching a
   * width to decide whether to render a div.
   */
  const shell = readFileSync(join(APP, 'shell.css'), 'utf8')
  const panels = readFileSync(join(APP, 'panels.css'), 'utf8')

  const base = split(shell).base
  const rule = base.slice(base.indexOf('.iris-scrim {'))
  assert.ok(rule.startsWith('.iris-scrim {'), 'the scrim has no base rule')
  assert.match(
    rule.slice(0, rule.indexOf('}')),
    /display:\s*none/,
    'the scrim is displayed at every width again; above 880px it covers the page invisibly',
  )

  const narrow = split(panels).blocks.find(one => one.condition === '(max-width: 880px)')
  assert.ok(narrow !== undefined, 'the narrow block is gone')
  assert.match(
    narrow.body,
    /\.iris-scrim\s*\{[^}]*display:\s*block/,
    'the narrow layout no longer brings the scrim back, so the sliding sidebar cannot be dismissed by tapping past it',
  )
})
