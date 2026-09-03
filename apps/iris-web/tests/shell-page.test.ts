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

test('the page declares an icon, so a load never asks the host for /favicon.ico', () => {
  // Measured during the six-card QA run: with no icon declared, every page load
  // fetched `/favicon.ico`, the host answered 404, and the failure sat in the
  // console beside the card reports a reader is meant to trust. `data:` answers
  // the browser's own request without adding an asset or a host route.
  assert.match(html, /<link\s+rel="icon"\s+href="data:/)
})
