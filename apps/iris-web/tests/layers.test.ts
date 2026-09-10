/**
 * The page's stacking ladder, held to its rule rather than to its numbers.
 *
 * The ladder lives in `theme/tokens.css` (the `layers` section, which also
 * says why: content under shell, shell under the destructive question). What
 * broke before it existed was not a number but an order: the settings drawer
 * sat at 30 and a card's overlay surface at 40, so the shell panel that could
 * collapse a card was itself painted under it. Five literals in four files, each
 * correct alone, wrong together.
 *
 * So the assertions here are the order and the wiring, not the values — the
 * values may move as long as the order survives and every consumer keeps
 * reading from the ladder.
 *
 * @module iris-web/tests/layers
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

/**
 * The ladder as `tokens.css` declares it, name → integer.
 *
 * Read from the structural block only (the first bare `:root`), which is where
 * the layers section is; a palette block redefining a layer would be a theme
 * changing the stacking order, which is not a thing a theme gets to do.
 */
function ladder(): Record<string, number> {
  const tokens = source('theme', 'tokens.css')
  const structural = [...tokens.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1])[0]
  assert.ok(structural !== undefined, 'tokens.css has no structural :root block')
  const table: Record<string, number> = {}
  for (const match of structural.matchAll(/(--iris-[a-z-]+-z):\s*(\d+);/g)) {
    table[match[1] ?? ''] = Number(match[2])
  }
  return table
}

test('the ladder orders content under shell, and shell under the cleaning offer', () => {
  const z = ladder()
  const step = (lower: string, upper: string): void => {
    const a = z[lower]
    const b = z[upper]
    assert.ok(a !== undefined, `${lower} is not on the ladder`)
    assert.ok(b !== undefined, `${upper} is not on the ladder`)
    assert.ok(a < b, `${lower} (${a}) must be under ${upper} (${b})`)
  }
  step('--iris-scrim-z', '--iris-sidebar-z')
  step('--iris-sidebar-z', '--iris-drop-z')
  step('--iris-drop-z', '--iris-overlay-z')
  // The collapse toggle is `overlay + 5`, computed in panels.css: the drawer
  // has to clear that too, or the toggle would poke through the drawer.
  assert.ok((z['--iris-overlay-z'] ?? 0) + 5 < (z['--iris-drawer-z'] ?? 0), 'the drawer does not clear the overlay toggle')
  step('--iris-overlay-z', '--iris-drawer-z')
  /*
   * A card's own popup sits between the two halves of the rule, so both halves
   * are asserted. Over the overlay **and its toggle**, because a card's
   * fullscreen interface would otherwise cover the question that same card is
   * blocked on; under the drawer, because it is content asking.
   */
  assert.ok(
    (z['--iris-overlay-z'] ?? 0) + 5 < (z['--iris-card-popup-z'] ?? 0),
    'a card popup does not clear the overlay toggle',
  )
  step('--iris-card-popup-z', '--iris-drawer-z')
  step('--iris-drawer-z', '--iris-cleanup-z')
})

/**
 * The one selector allowed to order siblings with a literal, and why.
 *
 * A row lifted by a drag has to paint over the rows it is passing. That is an
 * order **inside one list**, between siblings that share a parent - the same
 * kind of statement as `reading.css`'s two `z-index: 1`, which order a
 * message's marginalia against its own interface slot and are excluded from
 * this test for exactly that reason. Neither meets the page ladder: the shell's
 * layers are things that cover the *page*, and a row cannot cover anything
 * outside the panel it scrolls in.
 *
 * Named rather than pattern-matched, and asserted to still exist below, so that
 * deleting the drag makes this exception go red instead of standing for ever as
 * a licence nothing uses.
 */
const LOCAL_STACKING = ['.iris-row-shell--lifted']

test('every shell layer reads its z-index from the ladder, none from a literal', () => {
  // `reading.css` is deliberately not in this list: its two `z-index: 1` order
  // a message's marginalia against its own interface slot inside `.iris-msg`
  // and never meet the page ladder (tokens.css says the same).
  for (const file of ['panels.css', 'shell.css']) {
    const css = source('app', file)
    // Each declaration with the selector that carries it, so the exception can
    // be granted to a rule rather than to a value - a bare `z-index: 3`
    // allow-list would have excused the next one anywhere in the file.
    const rules = [...css.matchAll(/([^{};]+)\{[^{}]*z-index:\s*([^;]+);/g)]
      .map(match => ({ selector: (match[1] ?? '').trim(), value: (match[2] ?? '').trim() }))
    assert.ok(rules.length > 0, `${file} has no z-index at all; the consumers moved`)
    for (const rule of rules) {
      if (LOCAL_STACKING.some(allowed => rule.selector.includes(allowed))) continue
      assert.match(
        rule.value,
        /var\(--iris-[a-z-]+-z/,
        `${file} has a literal z-index: ${rule.value} on ${rule.selector}`,
      )
    }
  }
})

test('the local-stacking exception is still used by the rule it was granted to', () => {
  // An allow-list nothing uses is a licence waiting for the next literal. This
  // is what makes deleting the drag delete its exception too.
  const css = source('app', 'shell.css')
  for (const selector of LOCAL_STACKING) {
    assert.ok(
      css.includes(`${selector} {`),
      `${selector} is gone, so its permission to order siblings by hand should go with it`,
    )
  }
})

test('each named layer has exactly its consumer, and the overlay surface reads the same token', () => {
  const panels = source('app', 'panels.css')
  const shell = source('app', 'shell.css')
  const pairs: [string, string, string][] = [
    ['.iris-drawer', '--iris-drawer-z', panels],
    ['.iris-drop', '--iris-drop-z', panels],
    ['.iris-sidebar', '--iris-sidebar-z', panels],
    ['.iris-cleanup', '--iris-cleanup-z', panels],
    ['.iris-scrim', '--iris-scrim-z', shell],
  ]
  for (const [selector, token, css] of pairs) {
    const block = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*z-index:\\s*var\\(${token}\\)`)
    assert.match(css, block, `${selector} does not take its z-index from ${token}`)
  }
  // The surface is styled inline (a stylesheet rule could be overridden by a
  // card's CSS, useCardScripts.tsx explains), so it is checked as source text.
  assert.match(source('app', 'useCardScripts.tsx'), /zIndex: 'var\(--iris-overlay-z/, 'the overlay surface no longer reads --iris-overlay-z')
  assert.match(panels, /\.iris-overlay-toggle\s*\{[^}]*z-index:\s*calc\(var\(--iris-overlay-z/, 'the collapse toggle no longer follows the overlay token')
})
