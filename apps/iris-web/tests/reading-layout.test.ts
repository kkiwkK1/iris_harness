import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../src/app/reading.css', import.meta.url)), 'utf8')

/*
 * Comments are stripped from the whole file BEFORE it is split into rules, not
 * from each selector afterwards. The first version of this helper did it the
 * other way round and could not find a rule whose preceding comment contained a
 * comma: splitting the selector list on `,` cut the comment in half, and a half
 * comment no longer matches a comment pattern.
 */
const reading = source.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration block of one selector, or undefined. */
function block(selector: string): string | undefined {
  for (const rule of reading.split('}')) {
    const [head, body] = rule.split('{')
    if (head === undefined || body === undefined) continue
    // Whole-selector comparison. Matching a substring would find the selector
    // inside a descendant rule and read the wrong block — the exact mistake that
    // once had this project "confirming" a bug that was not there.
    if (head.split(',').map(part => part.trim()).includes(selector)) return body
  }
  return undefined
}

test('the reading column bottom-anchors as a set of three coupled declarations', () => {
  // These only work together. Drop `min-height: 100%` and the column shrinks to
  // its content, at which point `justify-content: flex-end` has no free space to
  // distribute and silently does nothing — a regression with no symptom until
  // someone opens a short conversation on a tall screen.
  const column = block('.iris-column')
  assert.ok(column !== undefined, '.iris-column rule is missing')

  assert.match(column, /min-height:\s*100%/, 'the column no longer fills the scroller')
  assert.match(column, /display:\s*flex/, 'the column is not a flex container')
  assert.match(column, /flex-direction:\s*column/, 'the column is not stacking vertically')
  assert.match(column, /justify-content:\s*flex-end/, 'the conversation no longer sits on the composer')
  // Padding is part of the column's own height with `min-height: 100%`, so
  // without this the bottom padding pushes a full-height column into overflow.
  assert.match(column, /box-sizing:\s*border-box/, 'the column would overflow by its padding')
})

test('the blank above a short conversation is free space, and grows with the window', () => {
  /*
   * Settled by the cascade rather than by measurement, because the measurement
   * is the part that went wrong: an attempt to check this in a browser resized
   * the scroll region rather than the viewport, and reported a constant gap.
   *
   * `min-height: 100%` resolves against the scroller's definite height, so the
   * column's height is max(content, scroller). `flex-end` puts every pixel of the
   * difference above the content. The blank is therefore exactly
   * `scrollerHeight - contentHeight` and tracks the window 1:1 — 216px at a
   * 1297px viewport, and proportionally more on a taller one.
   *
   * That is kept, not fixed. It is what bottom-anchoring costs, and the
   * alternative spends the same pixels between the last reply and the composer,
   * which is the separation this layout exists to remove. This test records the
   * relationship so the next person to see a tall screen knows it is a decision.
   */
  const column = block('.iris-column')
  assert.ok(column !== undefined)

  // No cap: a max-height here would silently reintroduce a bottom gap once it
  // engaged, which is the failure mode this layout was changed to avoid.
  assert.doesNotMatch(column, /max-height/, 'a cap here changes where the free space goes')
})

test('the turn ordinal outweighs the rule it marks', () => {
  // Measured at 1.59:1 against the paper before this, against a rule at 1.18:1 —
  // the same volume as the divider, which means no mark at all. The number is
  // the page's only locating mark, so it carries weight the rule does not.
  const ordinal = block('.iris-turn__ordinal')
  assert.ok(ordinal !== undefined, '.iris-turn__ordinal rule is missing')

  assert.match(ordinal, /color:\s*var\(--iris-ink-secondary\)/, 'the ordinal is back to a faint ink')
  assert.match(ordinal, /font-weight:\s*600/, 'the ordinal no longer outweighs the rule')
})

test('the recorded rail is legible, not merely present', () => {
  /*
   * This started at `--iris-rule`, which measures 1.34:1 against the paper in
   * light — the same range a reviewer measured this project's turn ordinal at and
   * called a grey smudge. The whole argument for keeping an inert rail is that it
   * still reports how many readings a passage had, and a mark below the threshold
   * of being seen reports nothing.
   *
   * This test used to pin the token *name* and argued, in this comment, that
   * asserting a ratio here would duplicate something owned by the palette. That
   * was wrong in a way worth keeping: a name says which colour is used, never
   * whether it can be seen. The palette moved under this assertion and it stayed
   * green across the entire period the tick was invisible — a test named "is
   * legible" that could not observe legibility.
   *
   * The ratio is now computed in `contrast.test.ts`, from the token itself, so
   * the two halves are split honestly: that file asserts the mark clears 3:1,
   * and this one asserts the rail is still wired to the token that carries the
   * floor rather than to a decorative hairline.
   */
  const record = block(".iris-rail--record .iris-rail__tick")
  assert.ok(record !== undefined, 'the recorded tick rule is missing')
  assert.match(record, /background:\s*var\(--iris-tick\)/, 'the recorded tick is back on a decorative colour')

  const count = block(".iris-rail--record .iris-rail__count")
  assert.ok(count !== undefined, 'the recorded count rule is missing')
  // Text, so a text-weight ink. `--iris-ink-faint` was 2.80:1.
  assert.match(count, /color:\s*var\(--iris-ink-tertiary\)/, 'the recorded count is back to a faint ink')
})

test('marginalia keeps a stacking position above the interface breakout', () => {
  /*
   * An interface slot escapes the reading measure with negative inline margins
   * and reclaims the air beside the prose — air that includes the margin column,
   * where the variant rail and the floor number live. The frame is opaque (a
   * card paints its own background) and later in the DOM, so without a stacking
   * position here it painted **over** the rail: measured at 240px² of rail
   * hidden under a card interface on a real card, with nothing reporting a
   * fault. The repair is exactly this stacking position — the box never moves,
   * the breakout keeps its width, and the marginalia keep their layer — and it
   * is two declarations, which is why it can disappear in a refactor with no
   * test failing and no screenshot taken.
   *
   * Verified live over CDP (qa/measure-z3-occlusion.mjs): with these in place,
   * `elementFromPoint` at the rail's own box answers the rail's children even
   * where the frame's rectangle overlaps it; without them it answered IFRAME.
   */
  const margin = block('.iris-msg__margin')
  assert.ok(margin !== undefined, '.iris-msg__margin rule is missing')
  assert.match(margin, /position:\s*relative/, 'the margin column has no stacking position — the rail paints under interface frames again')
  assert.match(margin, /z-index:\s*1/, 'the margin column lost its layer above the breakout')

  // The turn ordinal rides the same margin and needs the same answer: it sits
  // on the turn rule in the air the breakout reclaims.
  const ordinal = block('.iris-turn__ordinal')
  assert.ok(ordinal !== undefined, '.iris-turn__ordinal rule is missing')
  assert.match(ordinal, /z-index:\s*1/, 'the turn ordinal paints under interface frames again')
})

test('the interface frame is clamped to the band and the band has a fallback', () => {
  /*
   * The publisher (`ChatPane`, via `frame-fit.ts`) is only half of the clamp's
   * truth; the other half is the fallback that covers the gap before the
   * publisher's first write lands. `var()` with no definition is invalid at
   * computed-value time and `height` reverts to `auto` — **150px**, the
   * collapsed frame that nearly shipped once when the token was left behind in
   * `tokens.css`. The rule names the variable, so the default must outlive any
   * commit order.
   */
  const tokens = readFileSync(fileURLToPath(new URL('../src/theme/tokens.css', import.meta.url)), 'utf8')
  assert.match(tokens, /--iris-app-frame-height:\s*100vh/, 'the band variable has no default — an unbuilt publisher collapses every frame to 150px')
})
