/**
 * Two guards born of one acceptance round, kept together because both assert
 * a wiring decision a unit test cannot reach:
 *
 * 1. an interface frame's faults reach the notice log. `node --test` cannot
 *    load a `.tsx`, so the call site is asserted at source level — the same
 *    trade `interface-styles.test.ts` makes for class names, applied to a
 *    channel: the error went to the graded report list and **only** there,
 *    and the notice panel — the surface whose whole job is "what did this
 *    session say" — stayed empty while real cards failed. A guard on the
 *    source is the cheapest honest check that the two channels stay wired.
 *
 * 2. the composer reserves the reading surface's scrollbar lane and sizes the
 *    field inside its box, so the two midlines cannot drift apart again. Both
 *    failures were silent geometry: the field overflowing `__inner` by its own
 *    padding, and a half-scrollbar offset between the message column's centre
 *    and the composer's, measured at 19px combined on HEAD.
 *
 * @module iris-web/tests/notice-channels
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')

/** The component source, once. */
const messageInterfaces = readFileSync(join(src, 'app', 'MessageInterfaces.tsx'), 'utf8')
const panelsCss = readFileSync(join(src, 'app', 'panels.css'), 'utf8')

/**
 * The body of the CSS rule whose selector matches, braces balanced.
 * @param css - the stylesheet.
 * @param selectorText - the selector, without braces.
 * @returns the rule's declarations, or undefined when no rule matches.
 */
function ruleBody(css: string, selectorText: string): string | undefined {
  const at = css.indexOf(selectorText)
  if (at === -1) return undefined
  const open = css.indexOf('{', at)
  let depth = 1
  let end = open
  while (depth > 0) {
    end += 1
    const character = css.charAt(end)
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
  }
  return css.slice(open + 1, end)
}

/** A declaration with every space removed, so comparisons ignore formatting. */
function dense(text: string): string {
  return [...text].filter(character => character > ' ').join('')
}

test('an interface frame fault reaches the notice log, not only the report list', () => {
  /*
   * The handler must raise the notice on the same site that grades the
   * report — the script-frame side (`useCardScripts`'s `onFailure`) has
   * always done both, and the interface side is the same species of event.
   */
  const onErrorAt = messageInterfaces.indexOf('onError: message =>')
  assert.ok(onErrorAt !== -1, 'the interface frame host no longer declares onError')
  const handler = messageInterfaces.slice(onErrorAt, messageInterfaces.indexOf('onBlocked', onErrorAt))
  assert.match(
    dense(handler),
    /notify\('error',message\)/,
    'an interface fault must raise an error notice beside the graded report',
  )
  assert.match(
    dense(handler),
    /addCardReport\(message,\{/,
    'the graded report record must stay as well — both channels, not one instead of the other',
  )
})

test('the composer reserves the reading surface’s scrollbar lane', () => {
  /*
   * Read from `__inner`, not `.iris-composer`, and the move is load-bearing.
   *
   * A scroll container clips its absolutely-positioned children — `overflow-y:
   * auto` computes `overflow-x` to `auto` as well — and the 「梅花」 composer has
   * one: the plum branch that crosses its top edge. So the lane reservation and
   * the panel's padding moved one box inward, and the paint-and-position box
   * declares no overflow at all. Asserting the old element would have passed
   * only while the branch was clipped.
   */
  const composer = ruleBody(panelsCss, '.iris-composer__inner {')
  assert.ok(composer !== undefined, 'the composer inner rule disappeared')
  const body = dense(composer)
  assert.match(body, /scrollbar-gutter:stable/, 'the lane reservation is the midline parity')
  assert.match(body, /overflow-y:auto/, 'the reservation needs a scroll container')
  assert.match(
    body,
    /min-height:max-content/,
    'a scroll container loses its automatic minimum; without it a short window squashes the composer',
  )
  // The reading surface reserves the same lane — the two declarations are the
  // parity. If the scroller's `stable` goes, this pair goes with it.
  const readingCss = readFileSync(join(src, 'app', 'reading.css'), 'utf8')
  assert.match(dense(ruleBody(readingCss, '.iris-scroll {') ?? ''), /scrollbar-gutter:stable/)
})

test('the composer field is sized inside its box', () => {
  const field = ruleBody(panelsCss, '.iris-composer__field {')
  assert.ok(field !== undefined, 'the field rule disappeared')
  assert.match(
    dense(field),
    /box-sizing:border-box/,
    'a content-box textarea overflows __inner by its own padding and border, pushing its midline right',
  )
})

test('the composer and the prose share both flanks, not just the left one', () => {
  /*
   * The arithmetic this pins got simpler, and grew a second half.
   *
   * It used to be a one-sided symmetry: the prose started one gutter in from
   * the column's content edge (`.iris-msg`'s marginalia track), the composer's
   * inner had a matching `padding-left`, and the right sides deliberately had no
   * twin — so what was checked was that one midline had not moved away from the
   * other. 「梅花」 makes the reading area `46px | 1fr | 46px` on both sides
   * (canvas.json: 阅读区左右各留 46px 对称,输入框居中不偏), so the composer's
   * flanks are now a plain `padding: 30px var(--iris-gutter) 22px` and the
   * column's right flank is a gutter too.
   *
   * All three are read from the shorthand rather than from `padding-left`,
   * because the shorthand is what the files now write — a `padding-left`
   * assertion would have failed against a stylesheet that was correct.
   */
  const inner = ruleBody(panelsCss, '.iris-composer__inner {')
  assert.ok(inner !== undefined, 'the inner rule disappeared')
  assert.match(
    dense(inner),
    /padding:30pxvar\(--iris-gutter\)22px/,
    'the composer no longer takes its flanks from the gutter token',
  )

  const readingCss = readFileSync(join(src, 'app', 'reading.css'), 'utf8')
  const msg = ruleBody(readingCss, '.iris-msg {')
  assert.ok(msg !== undefined)
  assert.match(
    dense(msg),
    /grid-template-columns:var\(--iris-gutter\)/,
    'the prose lost its marginalia track, which is the reading column\u2019s left flank',
  )

  const column = ruleBody(readingCss, '.iris-column {')
  assert.ok(column !== undefined, 'the column rule disappeared')
  assert.match(
    dense(column.replace(/\/\*[\s\S]*?\*\//g, '')),
    /padding:40pxvar\(--iris-gutter\)28px0/,
    'the reading column\u2019s right flank no longer matches its marginalia track, so the two are asymmetric again',
  )
})
