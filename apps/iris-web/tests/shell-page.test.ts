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

test('the page refuses to render framed, and does it before anything else runs', () => {
  /*
   * The click-jacking substitute. `frame-ancestors` is ignored in a `<meta>`
   * and no header on this response is Iris's to set — the fallback seat belongs
   * to an external package with no hook — so the page checks for itself
   * (`notes/apps/iris-web/DEVIATIONS.md` §93).
   *
   * **Position is half the assertion.** A guard that runs after the module
   * entry has been fetched, or after the theme script has written to the root,
   * is a guard that let something happen first. This pins that the refusal is
   * the page's *first* script; that it actually stops the document is measured
   * in a real browser by `apps/iris/tests/shell-csp-live.test.ts`, because "the
   * parser stopped" is not a property of a string.
   */
  const guardAt = html.indexOf('window.top === window.self')
  assert.ok(guardAt !== -1, 'the framing guard is gone from index.html')

  const firstScript = html.indexOf('<script')
  assert.ok(firstScript !== -1)
  const secondScript = html.indexOf('<script', firstScript + 1)
  assert.ok(secondScript !== -1, 'this page has one script; the position assertion below compares nothing')
  assert.ok(guardAt < secondScript, 'the framing guard is no longer in the first script of the page')

  assert.match(html, /window\.stop\(\)/, 'the guard no longer stops the parser')
  assert.match(html, /data-iris-framed/, 'the guard leaves no mark a test in a browser can read')
})

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
