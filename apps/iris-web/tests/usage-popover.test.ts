/**
 * The usage hover card, pinned where a server render cannot reach.
 *
 * The card is closed until a pointer dwells, a keyboard focus lands, or a
 * touch taps — none of which a server render or this file can do — so what is
 * asserted here is the wiring, read off the sources: the two triggers carry no
 * native `title` any more, the card opens on hover and focus and closes on
 * Escape, and it is anchored by the shared primitive rather than a second
 * positioning engine. `tools/render-check.tsx` holds the rendered side.
 *
 * @module iris-web/tests/usage-popover
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))

/** One app source file, by name. */
function source(name: string): string {
  return readFileSync(join(HERE, '..', 'src', 'app', name), 'utf8')
}

test('neither usage trigger carries a native title any more', () => {
  /*
   * The two spots the native `title` bubble lived: the per-turn chip in a
   * reply's actions row, and the composer's session strip. Message.tsx has no
   * other `title=` in it, so there the ban is whole-file; Composer.tsx still
   * titles its two capsules, so the strip is pinned by its own class and by
   * the old assembly (`stats.join`) that used to feed the attribute.
   */
  const message = source('Message.tsx')
  assert.ok(!message.includes('title='), 'Message.tsx still carries a native title somewhere')
  assert.match(message, /<UsagePopover/, 'the per-turn chip does not open the hover card')
  assert.match(message, /usageDetailRows\(/, 'the chip breakdown is not built from the shared rows')

  const composer = source('Composer.tsx')
  assert.doesNotMatch(composer, /title=\{stats\.join/, 'the strip still titles itself with its own line')
  assert.doesNotMatch(
    composer,
    /iris-composer__stats"[^>]*title=/,
    'the strip still carries a native title',
  )
  assert.match(
    composer,
    /<UsagePopover\s+className="iris-composer__stats"/,
    'the strip does not open the hover card',
  )
  assert.match(composer, /usageSummaryRows\(usage, lang\)/, 'the strip card is not built from the shared rows')
  // The split-by-source sentence the old native `title` carried now rides as
  // the card's note — how the composer strip's hover card (#36) keeps the
  // card's own share (#39) reachable without adding a fourth group to the
  // strip. Pinned here so dropping the note from the trigger is caught at the
  // source even though the card is closed to any server render.
  assert.match(
    composer,
    /note=\{usageScriptShareSentence\(scriptUsage, lang\)\}/,
    'the strip card does not carry the card-script share as its note',
  )
})

test('the card opens on hover and on keyboard focus, and closes on Escape', () => {
  const popover = source('UsagePopover.tsx')
  // Hover: a dwell opens, and the leave is graced so the trip from trigger to
  // portaled card does not close what the reader is on their way to.
  assert.match(popover, /onPointerEnter=/, 'hover does not open the card')
  assert.match(popover, /OPEN_DWELL_MS/, 'hover opens without a dwell')
  assert.match(popover, /CLOSE_GRACE_MS/, 'pointer-out closes with no grace')
  // Keyboard: focus opens at once, and Escape is heard at document level while
  // open — the ContextCard idiom — so it closes no matter where focus sits.
  assert.match(popover, /onFocus=/, 'keyboard focus does not open the card')
  assert.match(popover, /onBlur=/, 'blur does not close the card')
  assert.match(popover, /event\.key === 'Escape'/, 'Escape does not close the card')
  assert.match(popover, /document\.addEventListener\('keydown', onKeyDown\)/, 'Escape is not heard while the card is open')
  // Touch: a tap toggles, and the focus a tap drags along is not read as a
  // keyboard focus on top of it.
  assert.match(popover, /pointerType === 'touch'/, 'touch has no path of its own')
  assert.match(popover, /pinned: !reasons\.pinned/, 'a touch tap does not toggle the card')
  // Both dismissal listeners attach only while open, and the card is a portal.
  assert.match(popover, /createPortal/, 'the card is not portaled out of the scroll containers')
  assert.match(popover, /if \(!open\) return/, 'the dismissal listeners are not always attached')
  assert.match(popover, /aria-expanded=\{open\}/, 'the trigger does not state its open state')
})

test('the card is anchored by the shared primitive and drawn from the tokens', () => {
  const popover = source('UsagePopover.tsx')
  // The same package the model capsule's menu comes from — anchoring, viewport
  // clamping, and re-placement on scroll and resize are its engine's job, and
  // a second implementation here would be a second popover that clamps
  // differently.
  assert.match(
    popover,
    /import \{ useAnchoredPosition \} from '@deepseek-ai\/dsh-client-ui-primitives'/,
    'the card does not use the shared anchoring primitive',
  )
  assert.match(popover, /useAnchoredPosition\(\{/, 'the anchoring primitive is imported but not used')
  assert.doesNotMatch(
    popover,
    /getBoundingClientRect/,
    'the card measures the anchor itself instead of through the primitive',
  )

  // The rows are a two-column definition list, so a screen reader hears the
  // pairing rather than a run-on line.
  assert.match(popover, /<dl className="iris-usage-card__rows">/, 'the rows are not a dl')
  assert.match(popover, /<dt>/, 'the rows have no terms')
  assert.match(popover, /<dd>/, 'the rows have no definitions')

  // The stylesheet draws the card only out of the design tokens.
  const css = source('panels.css')
  const at = css.indexOf('.iris-usage-card {')
  assert.ok(at >= 0, 'panels.css has no .iris-usage-card block')
  const block = css.slice(at, css.indexOf('}', at))
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'the card paints a hardcoded colour')
  assert.match(block, /z-index: var\(--iris-drop-z\)/, 'the card does not sit on the dropdown layer')
  assert.match(block, /var\(--iris-hairline\)/, 'the card does not use the hairline token')
  assert.match(block, /var\(--iris-radius\)/, 'the card does not use the radius token')
})
