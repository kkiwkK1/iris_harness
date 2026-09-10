import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * The shell page's own head, as the browser receives it.
 *
 * These are facts about `index.html` rather than about any module, so the test
 * reads the file the build ships — the same document the browser parses.
 */

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
const tokens = readFileSync(fileURLToPath(new URL('../src/theme/tokens.css', import.meta.url)), 'utf8')

test('the page declares an icon, so a load never asks the host for /favicon.ico', () => {
  // Measured during the six-card QA run: with no icon declared, every page load
  // fetched `/favicon.ico`, the host answered 404, and the failure sat in the
  // console beside the card reports a reader is meant to trust. A `data:` URI
  // answers the browser's own request without adding an asset or a host route,
  // which is still true now that the icon is a drawing rather than an empty one.
  assert.match(html, /<link\s+rel="icon"\s+href="data:/)
})

test('the tab icon is drawn in the accent it is drawn in everywhere else', () => {
  /*
   * A favicon has no stylesheet and therefore no tokens, so the plum is a
   * literal here — the same situation the pre-paint script's ground colours are
   * in, and the same answer: duplicate it, then make the duplicate go red when
   * it stops agreeing.
   *
   * 雪's palette is the one to compare against because it is the bare `:root`
   * block, the one a page with no theme attribute paints from. A favicon cannot
   * follow the theme at all — the browser draws it in the tab strip, outside
   * the document — so the light palette's accent is not a preference here, it
   * is the only value that could be right.
   */
  const accent = /^\s*--iris-accent:\s*(#[0-9a-f]{6});/mu.exec(tokens)?.[1]
  assert.ok(accent !== undefined, 'the accent token could not be read: this test compares against nothing')
  const icon = /<link\s+rel="icon"\s+href="([^"]+)"/u.exec(html)?.[1]
  assert.ok(icon !== undefined, 'no icon is declared')
  assert.match(icon, /^data:image\/svg\+xml,/u, 'the tab icon is not a drawing any more')
  // Both circles — the ring and the shut hole — are painted in it, and `#` is
  // percent-encoded inside a data URI.
  const painted = [...icon.matchAll(/%23([0-9a-f]{6})/gu)].map(match => `#${match[1] ?? ''}`)
  assert.ok(
    painted.length >= 2,
    `the icon paints ${String(painted.length)} colour(s); the closed aperture is a ring and a hole`,
  )
  for (const colour of painted) {
    assert.equal(colour, accent, `the tab icon is drawn in ${colour} while the product's accent is ${accent}`)
  }
})
