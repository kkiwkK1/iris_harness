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
  const composer = ruleBody(panelsCss, '.iris-composer {')
  assert.ok(composer !== undefined, 'the composer rule disappeared')
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

test('the composer still shares the message prose’s left inset', () => {
  /*
   * The midline arithmetic rests on this pair: the prose starts one gutter in
   * from the column's content edge (`.iris-msg`'s marginalia track), and the
   * composer's inner starts one gutter in from its own. Removing either side
   * of that symmetry moves one midline and not the other.
   */
  const inner = ruleBody(panelsCss, '.iris-composer__inner {')
  assert.ok(inner !== undefined, 'the inner rule disappeared')
  assert.match(dense(inner), /padding-left:var\(--iris-gutter\)/)
  const readingCss = readFileSync(join(src, 'app', 'reading.css'), 'utf8')
  const msg = ruleBody(readingCss, '.iris-msg {')
  assert.ok(msg !== undefined)
  assert.match(dense(msg), /grid-template-columns:var\(--iris-gutter\)/)
})
