/**
 * The two places a sandbox plugin touches the frame's document, in a real DOM.
 *
 * `plugin-tree.test.ts` drives the tree against recorded sinks, which proves the
 * checklist **calls** them. It cannot prove the calls take anything away, and
 * that is the half the acceptance script reads with
 * `document.querySelectorAll('[data-iris-plugin-style]').length === 0` — so it
 * is worth a DOM rather than another stub.
 *
 * @module iris-web/tests/plugin-surface
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import {
  createPluginPanelSink,
  createPluginStyleSink,
  PLUGIN_PANEL_ATTRIBUTE,
  PLUGIN_PANELS_ATTRIBUTE,
  PLUGIN_STYLE_ATTRIBUTE,
} from '../src/sandbox/plugin-surface.ts'

/**
 * A frame document.
 * @returns the document and its realm.
 */
function frame(): { document: Document, realm: { CSS?: { escape?: (value: string) => string } } } {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  return { document: window.document, realm: window as never }
}

test('a plugin sheet is tagged with its owner and comes away by that tag', () => {
  const { document, realm } = frame()
  const styles = createPluginStyleSink(document, realm)

  styles.insert('1-a', 'body{background:#000}')
  styles.insert('1-a', 'p{color:red}')
  styles.insert('2-b', 'p{color:blue}')

  assert.equal(document.querySelectorAll(`[${PLUGIN_STYLE_ATTRIBUTE}]`).length, 3)
  assert.equal(
    document.querySelector(`[${PLUGIN_STYLE_ATTRIBUTE}="1-a"]`)?.textContent,
    'body{background:#000}',
  )

  assert.equal(styles.clear('1-a'), 2, 'both of that plugin’s sheets, and it says how many')
  assert.equal(document.querySelectorAll(`[${PLUGIN_STYLE_ATTRIBUTE}="1-a"]`).length, 0)
  assert.equal(
    document.querySelectorAll(`[${PLUGIN_STYLE_ATTRIBUTE}="2-b"]`).length,
    1,
    'and not the neighbour’s — the DOM has no ownership, the attribute is all there is',
  )
})

test('a plugin sheet never shares the message preset’s tag', () => {
  /*
   * `data-iris-style` means "the message preset put this here"
   * (`message-preset-styles.ts`). Sharing it would let either side's clean-up
   * take the other's sheets — a plugin unmount silently removing FontAwesome,
   * which reads as the card losing its icons for no reason anyone can trace.
   */
  const { document, realm } = frame()
  createPluginStyleSink(document, realm).insert('1-a', 'body{}')

  assert.equal(document.querySelectorAll('[data-iris-style]').length, 0)
})

test('the panel container is built once and outlives every cell', () => {
  const { document, realm } = frame()
  const panel = createPluginPanelSink(document, realm, 'https://iris.test')

  panel.mount('2-b', '<b>second</b>')
  panel.mount('1-a', '<i>first</i>')

  const container = document.querySelectorAll(`[${PLUGIN_PANELS_ATTRIBUTE}]`)
  assert.equal(container.length, 1, 'one container per frame, not one per plugin')
  assert.deepEqual(
    [...(container[0]?.children ?? [])].map(cell => cell.getAttribute(PLUGIN_PANEL_ATTRIBUTE)),
    ['1-a', '2-b'],
    'cells sit in id order, so the container reads in the order the tree mounts in',
  )

  panel.remove('1-a')
  assert.equal(document.querySelectorAll(`[${PLUGIN_PANEL_ATTRIBUTE}="1-a"]`).length, 0)
  assert.equal(
    document.querySelectorAll(`[${PLUGIN_PANELS_ATTRIBUTE}]`).length,
    1,
    'the container belongs to the frame, so a teardown must not take it',
  )
})

test('a cell takes an element as well as a string, and replaces what was there', () => {
  const { document, realm } = frame()
  const panel = createPluginPanelSink(document, realm, 'https://iris.test')

  panel.mount('p', '<span>one</span>')
  const node = document.createElement('div')
  node.textContent = 'two'
  panel.mount('p', node)

  const cell = document.querySelector(`[${PLUGIN_PANEL_ATTRIBUTE}="p"]`)
  assert.equal(cell?.textContent, 'two')
  assert.equal(cell?.children.length, 1, 'a second mount replaces rather than appending')
})

test('hiding the container is an attribute, so nothing needs to remember what was there', () => {
  const { document, realm } = frame()
  const panel = createPluginPanelSink(document, realm, 'https://iris.test')
  panel.mount('p', 'x')

  panel.setVisible(false)
  assert.equal(document.querySelector(`[${PLUGIN_PANELS_ATTRIBUTE}]`)?.hasAttribute('hidden'), true)
  panel.setVisible(true)
  assert.equal(document.querySelector(`[${PLUGIN_PANELS_ATTRIBUTE}]`)?.hasAttribute('hidden'), false)
  assert.equal(document.querySelector(`[${PLUGIN_PANEL_ATTRIBUTE}="p"]`)?.textContent, 'x')
})
