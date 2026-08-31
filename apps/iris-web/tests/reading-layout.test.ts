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
   * Pinned by token rather than by measured ratio: the ratio lives in the token,
   * and asserting the number here would duplicate a value that belongs to the
   * palette and would go stale the moment the palette moved.
   */
  const record = block(".iris-rail--record .iris-rail__tick")
  assert.ok(record !== undefined, 'the recorded tick rule is missing')
  assert.match(record, /background:\s*var\(--iris-rule-strong\)/, 'the recorded tick is back below visibility')

  const count = block(".iris-rail--record .iris-rail__count")
  assert.ok(count !== undefined, 'the recorded count rule is missing')
  // Text, so a text-weight ink. `--iris-ink-faint` was 2.80:1.
  assert.match(count, /color:\s*var\(--iris-ink-tertiary\)/, 'the recorded count is back to a faint ink')
})
