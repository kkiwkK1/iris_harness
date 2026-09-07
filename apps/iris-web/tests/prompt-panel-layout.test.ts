/**
 * The itemization dialog's measure.
 *
 * The primitive's dialog card is 380px wide and `overflow: hidden` — a
 * confirmation's measure. The itemization is a four-column table (kind, label,
 * share, tokens); left in a 380px card the two right columns fell outside it
 * and were clipped, which a reader saw as "rows without their numbers". The
 * width has to live on the card, because the clip does; a wider body inside a
 * narrow card was exactly the broken state.
 *
 * @module iris-web/tests/prompt-panel-layout
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]): string => readFileSync(join(here, '..', ...parts), 'utf8')

const PRIMITIVE_DIALOG_WIDTH_PX = 380

/** The `width:` declaration of one selector's block, or undefined. */
function widthOf(css: string, selector: string): string | undefined {
  const block = css.match(new RegExp(`${selector.replace(/[.]/gu, '\\.')}\\s*\\{([^}]*)\\}`, 'u'))
  return declarationOf(block?.[1] ?? '', 'width')
}

/** One property's value inside a declaration block, or undefined. */
function declarationOf(block: string, property: string): string | undefined {
  return block.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`, 'u'))?.[1]?.trim()
}

test('the dialog card, not the table, carries the wider measure', () => {
  const panel = read('src', 'app', 'PromptPanel.tsx')
  const css = read('src', 'app', 'panels.css')

  // The class reaches the card: the primitive's `className` prop is the only
  // hook that lands on the element with the clip.
  assert.match(panel, /<Modal[\s\S]*?className="iris-prompt-dialog"[\s\S]*?>/u, 'the dialog is not given its class')

  const width = widthOf(css, '.iris-prompt-dialog')
  assert.ok(width !== undefined, 'the dialog class has no width rule — the primitive\'s 380px clip is back')
  const px = width.match(/min\((\d+)px,\s*100%\)/u)
  assert.ok(px !== null, `the dialog width is not a capped fluid measure: ${width}`)
  assert.ok(Number(px[1]) > PRIMITIVE_DIALOG_WIDTH_PX, `the dialog is no wider than the primitive's clip: ${width}`)
})

test('the body fills the card rather than asking for a minimum the card cannot give', () => {
  const css = read('src', 'app', 'panels.css')
  const block = css.match(/\.iris-prompt\s*\{([^}]*)\}/u)?.[1]
  assert.ok(block !== undefined, '.iris-prompt has no rule')
  // Read the value, not its absence: a `(?!0)` lookahead after `\s*` backtracks
  // past the space and matches `min-width: 0` too.
  const minWidth = declarationOf(block, 'min-width')
  assert.ok(minWidth === undefined || minWidth === '0', `a non-zero min-width on the body reproduces the clipped table: ${minWidth}`)
})

test('the primitive dialog is still the width this test assumes', () => {
  // A wider primitive would make the override redundant, not wrong; a narrower
  // one would make the pin above too lax. Either way the constant here is a
  // measurement of a dependency and has to be checked against it.
  const modal = read('node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'Modal.module.css')
  assert.equal(widthOf(modal, '.dialog'), `min(${PRIMITIVE_DIALOG_WIDTH_PX}px, 100%)`)
})
