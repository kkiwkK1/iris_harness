/**
 * The frame's scroll strategy: when a clamped frame scrolls itself, and when
 * it hands the wheel back to the page.
 *
 * The shell clamps a message frame to the visible band (`reading.css`
 * `max-height`), so a heavy card lives its whole life with content past its
 * own viewport. Whether that content is reachable — and whether the frame's
 * boundary stops the wheel or drags the page — is decided in the frame by
 * `overflowDecision` and `containDecision`, applied by `frame-entry.ts` to
 * `html` and `body` inline. Both decisions are pure, so the strategy is
 * asserted here directly, with the measured cards as the fixtures.
 *
 * @module iris-web/tests/frame-scroll
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  OVERFLOW_SLACK_PX,
  containDecision,
  contentExtent,
  overflowDecision,
  type ContentRulers,
} from '../src/sandbox/frame-height.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** The three rulers that are not `bodyScroll`, defaulted to a flat layout. */
const at = (height: number): Omit<ContentRulers, 'bodyScroll'> => ({
  docScroll: height,
  rangeHeight: height,
  childBottom: height,
})

test('the honest extent is the largest ruler that measures anything', () => {
  assert.equal(contentExtent({ bodyScroll: 100, ...at(300) }), 300)
  assert.equal(contentExtent({ bodyScroll: 900, ...at(300) }), 900)
  assert.equal(contentExtent({ bodyScroll: 0, ...at(0) }), 0)
})

test('a ruler a realm cannot produce is dropped, not maxed', () => {
  // `Math.max` with `NaN` is `NaN` — one unusable ruler would disarm the
  // scroll for every card, so it has to fall out of the set instead.
  assert.equal(
    contentExtent({ bodyScroll: 700, docScroll: Number.NaN, rangeHeight: 500, childBottom: 700 }),
    700,
  )
  assert.equal(
    contentExtent({
      bodyScroll: Number.NaN,
      docScroll: Number.NaN,
      rangeHeight: Number.NaN,
      childBottom: Number.NaN,
    }),
    0,
  )
})

test('content past the viewport scrolls the frame', () => {
  // The flagship measured card: 3401px of interface in a 546px band, and the
  // 858px band against 3193px at full width.
  assert.equal(overflowDecision(3401, 546), 'auto')
  assert.equal(overflowDecision(3193, 858), 'auto')
})

test('a card that lies to `bodyScroll` still gets the scroll', () => {
  // Measured: content 1069px in a 461px frame whose `body.scrollHeight` read
  // 100 — the card pins its own body, so the ruler the height path leans on
  // reports *under* the viewport and the old bodyScroll-only decision kept
  // `overflow:hidden` in force. The range over the body's contents cannot be
  // pinned that way.
  const rulers: ContentRulers = {
    bodyScroll: 100,
    docScroll: 461,
    rangeHeight: 1069,
    childBottom: 1040,
  }
  assert.equal(contentExtent(rulers), 1069)
  assert.equal(overflowDecision(contentExtent(rulers), 461), 'auto')
})

test('a fitting frame does not scroll — the wheel chains to the page', () => {
  // Measured fitting frames: 哈人冰恋's 482px interface in a 482px frame, and
  // 政经博弈's at 740 and 764. Nothing to scroll in-frame, so the only way a
  // reader reaches the rest of the conversation is the chain — a leftover
  // `auto` from an earlier, taller layout would swallow the wheel over the
  // interface entirely (measured: neither frame nor page moved).
  assert.equal(overflowDecision(482, 482), '')
  assert.equal(overflowDecision(740, 858), '')
  assert.equal(overflowDecision(764, 764), '')
})

test('the slack band holds on the way in and on the way out', () => {
  // The height travels to the shell as a message and is applied a frame later;
  // in that gap the content legitimately sits a pixel or two past the
  // viewport. The scroll does not flash on for it — and a frame one pixel past
  // the slack keeps its scroll rather than flapping.
  assert.equal(overflowDecision(546 + OVERFLOW_SLACK_PX, 546), '')
  assert.equal(overflowDecision(546 + OVERFLOW_SLACK_PX + 1, 546), 'auto')
})

test('an unborn frame decides nothing', () => {
  // A frame still being laid out reports a 0 viewport; deciding on it is the
  // self-reinforcing zero the height path records, read the other way round.
  assert.equal(overflowDecision(1200, 0), '')
  assert.equal(overflowDecision(Number.NaN, 546), '')
  assert.equal(overflowDecision(1200, Number.NaN), '')
})

test('a frame with real scroll range holds the wheel at its boundary', () => {
  // Measured on the un-fixed build: the frame scrolled to its end and the next
  // six wheel notches dragged the reading column from 68px to 146px.
  assert.equal(containDecision(2855), 'contain')
  assert.equal(containDecision(209), 'contain')
  // The card whose `body` lies (1069px of content in a 461px frame): the
  // overflow decision makes the 100px body the scroller — range 940 — so the
  // containment binds to the element that can actually scroll.
  assert.equal(containDecision(940), 'contain')
})

test('a frame with no scroll range chains — containment must not swallow the wheel', () => {
  // The `sizing` contract: a card that pinned itself to its viewport clips its
  // own overflow inside its own descendant and never gains a document range.
  // A zero-range scroller with `contain` would stop the chain from passing
  // through it — the wheel over the interface would move nothing at all, and
  // the reader could not scroll past a screen-filling interface.
  assert.equal(containDecision(0), '')
  assert.equal(containDecision(OVERFLOW_SLACK_PX), '')
  assert.equal(containDecision(Number.NaN), '')
})

test('both decisions run on every measurement, before the height signal', () => {
  /*
   * The fault this pins: the scroll decision used to live *after* the height
   * signal's early returns, so a `sizing` frame or an echo measurement —
   * precisely the states a pinned or clamped card sits in — never reached it
   * and kept the reset's `overflow:hidden` forever. The scroll answers "is
   * the content reachable", a question the height signal's silences do not
   * pause; the call site must sit **before** `heightSignal`'s, where the
   * early returns cannot skip it.
   */
  const entry = readFileSync(
    join(here, '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )
  const send = entry.slice(entry.indexOf('const send = (): void => {'))
  const decisionAt = send.indexOf('overflowDecision(contentExtent(')
  const containmentAt = send.indexOf('containDecision(')
  const signalAt = send.indexOf('heightSignal(')
  assert.notEqual(decisionAt, -1, 'the frame no longer decides its overflow')
  assert.notEqual(containmentAt, -1, 'the frame no longer decides its containment')
  assert.notEqual(signalAt, -1, 'the height signal vanished from the frame')
  assert.ok(decisionAt < signalAt, 'the overflow decision runs after the height signal — the early returns skip it')
  assert.ok(containmentAt < signalAt, 'the containment decision runs after the height signal — the early returns skip it')
})

test('the containment is decided from the range that exists after the overflow applies', () => {
  // The containment reads `scrollHeight - clientHeight` back *after* the
  // overflow style is written — a chicken-and-egg the file resolves in one
  // send: apply, flush, measure, then seal. Pin the read so it cannot drift
  // back to deciding containment off the extent alone.
  const entry = readFileSync(
    join(here, '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )
  const applyAt = entry.indexOf("applyScrollStyles(document.documentElement, 'overflow-y'")
  const rangeAt = entry.indexOf('const scrollRange =')
  const containAt = entry.indexOf('const containment = containDecision(')
  assert.ok(applyAt !== -1 && rangeAt !== -1 && containAt !== -1)
  assert.ok(applyAt < rangeAt, 'the range is read before the overflow is applied — it measures the pre-scroll layout')
  assert.ok(rangeAt < containAt, 'the containment is decided before the range is read')
})

test('the applied properties cover both chained scrollers, inline and important', () => {
  /*
   * `html` and `body` are one scroll chain: whichever element the card's own
   * CSS turns into the scroller, the guarantee only holds if the property is
   * on **that** element — so both get both, inline `!important`, because the
   * rule being beaten (the reset's `overflow:hidden`) is itself `!important`.
   */
  const entry = readFileSync(
    join(here, '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )
  const applied = entry.match(/applyScrollStyles\((document\.documentElement|document\.body), '(overflow-y|overscroll-behavior)'/gu) ?? []
  const targets = new Set(applied.map(line => line.includes('documentElement') ? 'html' : 'body'))
  assert.deepEqual([...targets].sort(), ['body', 'html'], 'a scroller is missed')
  assert.equal(applied.length, 4, 'each scroller gets exactly the two properties')
  const apply = entry.slice(entry.indexOf('function applyScrollStyles'))
  assert.match(apply, /setProperty\(property, value, 'important'\)/u)
})

test('the measurement schedule survives a frame that never paints', () => {
  /*
   * Measured in the project's own headless harness: every sandboxed frame of a
   * chat sat `document.hidden === false` with a queued `requestAnimationFrame`
   * that never fired — render-throttled children get no animation frames, so
   * the rAF-only schedule meant the frame's *first* synchronous measurement
   * was also its *last*. A card whose interface builds its DOM after the
   * bootstrap (an async `$(fn)`, the way 政经博弈's reply interface does) never
   * got a second measurement: no height ever posted, and the scroll decision —
   * which runs inside that same measurement — never ran either. `reportRegions`
   * already carries the 500ms rescue for the same fixed point; the height
   * schedule must keep it.
   */
  const entry = readFileSync(
    join(here, '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )
  const schedule = entry.slice(
    entry.indexOf('const schedule = (): void => {', entry.indexOf('function reportHeight')),
    entry.indexOf('new ResizeObserver', entry.indexOf('function reportHeight')),
  )
  assert.match(schedule, /requestAnimationFrame\(send\)/u)
  assert.match(schedule, /setTimeout\(\(\) => \{\s*if \(scheduled\) send\(\)\s*\}, 500\)/u)
})

test('the reset keeps upstream overflow:hidden — the scroll is the exception, not the rule', () => {
  // The clamp plus this scroll replaced what `hidden` once did badly; the
  // `hidden` itself stays, because a card that sized itself against no
  // scrollbar must keep laying out against one until the content overruns.
  const srcdoc = readFileSync(join(here, '..', 'src', 'sandbox', 'srcdoc.ts'), 'utf8')
  assert.match(srcdoc, /overflow:hidden!important/u)
})

test('the frame decides its overflow once, from the honest extent, and never again from bodyScroll alone', () => {
  /*
   * Two decisions once lived in the same send: the extent path above the height
   * signal, and a second one after the report that asked `body.scrollHeight`
   * alone - the ruler a self-pinning card lies to. On such a card the second
   * removed the `auto` the first had just set, in the same pass, and nothing
   * put it back: the early returns on the next measurement never reach either.
   * So the file may write `overflow-y` from exactly one predicate.
   */
  const entry = readFileSync(join(here, '..', 'src', 'sandbox', 'frame-entry.ts'), 'utf8')
  assert.equal(entry.includes('applyScrollCapability'), false, 'a second scroll decision came back')
  // Whole lines, because the value is a nested call and a bracket-counting
  // regex is exactly the kind of instrument that passes for the wrong reason.
  const writers = entry.split(/\r?\n/u).filter(line => /applyScrollStyles\((document\.documentElement|document\.body), 'overflow-y'/u.test(line))
  assert.equal(writers.length, 2, 'overflow-y must be written for html and body, once each')
  for (const line of writers) {
    assert.match(line, /overflowDecision\(contentExtent\(rulers\), viewport\)/u, `an overflow-y writer is not fed the honest extent: ${line}`)
  }
})

