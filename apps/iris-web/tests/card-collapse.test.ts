/**
 * 「收起卡片界面」 with sandbox plugins in the frame: the card's interface goes,
 * the plugins' panel and styles stay.
 *
 * The defect this pins: the collapse control hid the overlay surface element,
 * and the card-script frame inside it holds the sandbox plugins too
 * (`docs/SANDBOX-PLUGINS.md` §5.1, §5.5) — so collapsing the card hid the
 * reader's own plugins with it. The fix hides the card **inside** the frame
 * (`sandbox/card-collapse.ts`) and leaves the surface visible when there are
 * plugins (`collapsedSurfaceVisibility`). Both halves are pinned here, in a real
 * DOM for the frame half, with the panel and style built by the product's own
 * sinks rather than by hand.
 *
 * @module iris-web/tests/card-collapse
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import { collapsedSurfaceVisibility } from '../src/app/overlay-surface.ts'
import {
  applyCardCollapse,
  CARD_COLLAPSED_ATTRIBUTE,
  collapsedRoots,
} from '../src/sandbox/card-collapse.ts'
import {
  createPluginPanelSink,
  createPluginStyleSink,
  PLUGIN_PANELS_ATTRIBUTE,
  PLUGIN_STYLE_ATTRIBUTE,
} from '../src/sandbox/plugin-surface.ts'
import { parseToFrame } from '../src/sandbox/protocol.ts'

/**
 * A card-script frame document: a card interface with an inner element that
 * declares its own `visibility: visible` (the case a parent-only rule misses),
 * then a mounted plugin with a panel and a sheet.
 * @returns the document, its window, and the elements read below.
 */
function frame(): {
  document: Document
  window: Window & typeof globalThis
  card: Element
  inner: Element
  cell: Element
} {
  const { window } = new JSDOM(
    '<!doctype html><html><head><style>.card-inner { visibility: visible; }</style></head>'
    + '<body><div id="card-app"><span class="card-inner">card UI</span></div></body></html>',
  )
  const { document } = window
  const realm = window as never
  createPluginStyleSink(document, realm).insert('01-bar', '[data-qa-probe] { color: rgb(1, 2, 3); }')
  createPluginPanelSink(document, realm).mount('01-bar', '<b data-qa-probe>plugin panel</b>')
  const card = document.querySelector('#card-app')
  const inner = document.querySelector('.card-inner')
  const cell = document.querySelector('[data-qa-probe]')
  assert.ok(card !== null && inner !== null && cell !== null, 'the fixture did not build')
  return { document, window, card, inner, cell }
}

test('collapsed: the card interface is hidden, the plugin panel and its style are not', () => {
  const { document, window, card, inner, cell } = frame()
  applyCardCollapse(document, true)

  // The control: collapse still hides the card's own UI, inner element included.
  assert.equal(window.getComputedStyle(card).visibility, 'hidden')
  assert.equal(window.getComputedStyle(inner).visibility, 'hidden',
    'a card element declaring visibility:visible re-appeared under the collapse')
  // The subject: the plugin's panel is shown, and its sheet is still applied.
  assert.equal(window.getComputedStyle(cell).visibility, 'visible',
    'the collapse hid the sandbox plugin panel')
  assert.equal(document.querySelectorAll(`[${PLUGIN_STYLE_ATTRIBUTE}="01-bar"]`).length, 1)
  assert.equal(window.getComputedStyle(cell).color, 'rgb(1, 2, 3)', 'the plugin sheet stopped applying')
})

test('collapsed: the clip is measured from the panel container alone', () => {
  const { document, card } = frame()
  const roots = [...document.body.children].filter(child => child.tagName !== 'STYLE')
  // Not collapsed: every root, the card included.
  assert.deepEqual(collapsedRoots(document, roots), roots)
  applyCardCollapse(document, true)
  const measured = collapsedRoots(document, roots)
  assert.equal(measured.length, 1)
  assert.ok(measured[0]?.hasAttribute(PLUGIN_PANELS_ATTRIBUTE))
  assert.ok(!measured.includes(card), 'a hidden card node would cut a hole that catches clicks')
})

test('restoring shows the card again and leaves one sheet, however often it is toggled', () => {
  const { document, window, card } = frame()
  applyCardCollapse(document, true)
  applyCardCollapse(document, false)
  applyCardCollapse(document, true)
  applyCardCollapse(document, false)
  assert.equal(window.getComputedStyle(card).visibility, 'visible')
  assert.equal(document.documentElement.hasAttribute(CARD_COLLAPSED_ATTRIBUTE), false)
  assert.equal(document.querySelectorAll('style[data-iris-card-collapse]').length, 1)
})

test('the surface is hidden from outside only when there are no sandbox plugins', () => {
  // A card alone: the original escape hatch, unchanged.
  assert.equal(collapsedSurfaceVisibility(true, false), 'hidden')
  // With plugins the surface stays up and the frame does the hiding.
  assert.equal(collapsedSurfaceVisibility(true, true), 'visible')
  assert.equal(collapsedSurfaceVisibility(false, false), 'visible')
  assert.equal(collapsedSurfaceVisibility(false, true), 'visible')
})

test('card:collapse is a two-sided message and refuses a non-boolean', () => {
  assert.deepEqual(
    parseToFrame('tok', { iris: 'tok', type: 'card:collapse', collapsed: true }),
    { iris: 'tok', type: 'card:collapse', collapsed: true },
  )
  assert.equal(parseToFrame('tok', { iris: 'tok', type: 'card:collapse', collapsed: 'yes' }), undefined)
  assert.equal(parseToFrame('tok', { iris: 'other', type: 'card:collapse', collapsed: true }), undefined)
})
