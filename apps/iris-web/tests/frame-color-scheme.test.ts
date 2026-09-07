/**
 * Both card-frame kinds render with a light colour scheme, as upstream does.
 *
 * The fact (`notes/UPSTREAM-THEME-VARS.md` §六, measured 2026-09-06): SillyTavern
 * writes `color-scheme: only light` on `body` (`[ST] public/style.css:167`) and
 * the TavernHelper frame documents write no `color-scheme` at all, so under the
 * spec's rule for embedded documents an upstream frame's preferred scheme is the
 * embedding element's — light — whatever theme the reader chose. Form controls
 * and scrollbars inside a card were light in ST's dark theme, and card authors
 * built against that.
 *
 * Iris used to write `normal` on the message frame and nothing on the overlay
 * frame, and `inherit` inside the frame document. All three resolve to "the
 * page's scheme", and the page declares one per theme — so both frames followed
 * the theme, which upstream's never did. This pins the parity in source text:
 * the value is a stylesheet and an inline write, and no unit test can observe a
 * computed scheme.
 *
 * @module iris-web/tests/frame-color-scheme
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Read one source file under `src/`. */
function source(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

const PARITY = 'upstream frames are light under every theme (UPSTREAM-THEME-VARS.md §六)'

test('the message frame element is light, not the page scheme', () => {
  const css = source('app', 'reading.css')
  const rule = css.match(/\.iris-interfaces__slot iframe\s*\{([^}]*)\}/)?.[1]
  assert.ok(rule !== undefined, 'reading.css no longer has the `.iris-interfaces__slot iframe` rule')
  assert.match(rule, /color-scheme:\s*light;/, `the message frame does not declare color-scheme: light — ${PARITY}`)
  assert.doesNotMatch(css, /color-scheme:\s*normal/, `a frame rule still says \`normal\`, which means "follow the theme" — ${PARITY}`)
})

test('the overlay frame element is set light when it is attached', () => {
  const attach = source('app', 'useCardScripts.tsx')
  assert.match(
    attach,
    /style\.setProperty\('color-scheme', 'light'\)/,
    `the overlay attach does not write color-scheme: light on the frame — ${PARITY}`,
  )
})

test('the frame document says light on its own root, and no template says inherit', () => {
  // `inherit` on a root element is the initial value `normal` — a no-op that
  // read as a decision. Both templates (script frame and message frame) carry
  // the reset, so both must say it.
  const srcdoc = source('sandbox', 'srcdoc.ts')
  const resets = srcdoc.match(/html,body\{[^}]*\}/g) ?? []
  assert.ok(resets.length >= 2, `expected the script and message frame resets, found ${resets.length}`)
  for (const reset of resets) {
    assert.ok(reset.includes('color-scheme:light'), `a frame reset does not say color-scheme:light — ${PARITY}: ${reset}`)
  }
  assert.ok(!srcdoc.includes('color-scheme:inherit'), 'srcdoc.ts still writes color-scheme:inherit, the no-op')
})
