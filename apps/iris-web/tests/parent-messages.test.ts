/**
 * What a card's upward `postMessage` does, and what it says while doing it.
 *
 * The module under test is the whole consumer: `frame.ts` bridges the name and
 * hands the argument over, so every decision about what a message *means* is
 * here. Two properties are worth more than the rest and both have already been
 * got wrong in a draft:
 *
 * - a resize request is measured **every** time, not only when it is reported;
 * - the report budget is decided when a shape is first seen, so the ninth
 *   distinct shape does not silence the eight before it.
 *
 * @module iris-web/tests/parent-messages
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  HEIGHT_REQUEST_TYPES,
  REPORT_LIMIT,
  createParentMessages,
  describeMessage,
  heightRequest,
} from '../src/sandbox/parent-messages.ts'

/** A sink with the two levers a test needs to see. */
function sink(): {
  post: (message: unknown, targetOrigin?: unknown, transfer?: unknown) => void
  measured: () => number
  notes: () => string[]
} {
  let measured = 0
  const notes: string[] = []
  const post = createParentMessages({
    remeasure: () => { measured += 1 },
    note: message => { notes.push(message) },
  })
  return { post, measured: () => measured, notes: () => notes }
}

test('a resize request is answered by measuring this frame, and says so once', () => {
  const it = sink()
  it.post({ type: 'resizeIframe', height: 912 }, '*')

  assert.equal(it.measured(), 1, 'the resize request did not reach the height reporter')
  assert.equal(it.notes().length, 1)
  // The claimed height is in the report because it is the one number a reader
  // can compare against the frame's own "height sources" line — the comparison
  // that would show the re-measure answering the wrong quantity.
  assert.match(it.notes()[0] ?? '', /912px/)
  assert.match(it.notes()[0] ?? '', /measuring this frame's own content/)
})

test('every spelling on the list is answered, because the list is the dispatch', () => {
  /*
   * `resizeIframe` is what all 15 measured sites send; `iframeResize` is what
   * the one upstream listener that consumes an upward message matches
   * (ST-Prompt-Template `src/utils/iframe.ts:112`). Honouring one would either
   * serve nobody here or diverge from the only consumer that exists, so both
   * are on the list — and the list is walked rather than copied, so a spelling
   * added to it is a spelling this test covers.
   */
  for (const type of HEIGHT_REQUEST_TYPES) {
    const it = sink()
    it.post({ type, height: 100 })
    assert.equal(it.measured(), 1, `${type} was not answered`)
  }
  assert.deepEqual([...HEIGHT_REQUEST_TYPES], ['resizeIframe', 'iframeResize'])
})

test('a resize request with no usable height is still a resize request', () => {
  // The card is saying "my layout changed"; the height is advisory, and
  // requiring it would drop the request on exactly the card that had trouble
  // producing one. Each is its own sink: they are one shape, and a shared sink
  // would report only the first.
  for (const message of [
    { type: 'resizeIframe' },
    { type: 'resizeIframe', height: 0 },
    { type: 'resizeIframe', height: -40 },
    { type: 'resizeIframe', height: Number.NaN },
    { type: 'resizeIframe', height: '400' },
  ]) {
    const it = sink()
    it.post(message)
    assert.equal(it.measured(), 1, `${JSON.stringify(message)} was not answered`)
    assert.match(it.notes()[0] ?? '', /no usable height/)
  }
})

test('the four-thousandth resize request is measured too, and reported at each ten-fold', () => {
  /*
   * The property a draft got wrong: the measurement sat inside the report gate,
   * so a card's resizes worked once and then silently stopped — a card that
   * posts from a `requestAnimationFrame` callback (one measured sender does)
   * would have been sized by its very first layout and never again.
   */
  const it = sink()
  for (let at = 0; at < 100; at += 1) it.post({ type: 'resizeIframe', height: 500 + at })

  assert.equal(it.measured(), 100, 'requests past the first were not measured')
  assert.equal(it.notes().length, 3, 'the reports are not the 1st, 10th and 100th')
  assert.match(it.notes()[1] ?? '', /10 requests so far/)
  assert.match(it.notes()[2] ?? '', /100 requests so far/)
})

test('a message nothing consumes is dropped, counted, and named — not thrown', () => {
  const it = sink()
  // The bare string in the corpus: 不要被神隐挑战's 论坛覆盖层 posts
  // `'toggle-forum-overlay'` upward, twice in one script body. A consumer that
  // assumed an object would have thrown on it, which is the fault this replaces.
  it.post('toggle-forum-overlay', '*')

  assert.equal(it.measured(), 0, 'a message that is not a resize request moved the frame')
  assert.equal(it.notes().length, 1)
  assert.match(it.notes()[0] ?? '', /toggle-forum-overlay/)
  assert.match(it.notes()[0] ?? '', /nothing here consumes/)
})

test('nothing a card can post makes the member throw', () => {
  /*
   * The whole fault, stated as a property. Upstream `window.parent` is a real
   * window: the post either lands on a listener or is dropped, and the card's
   * next statement runs either way. Here it threw, and because the sender is
   * markup that runs while the document parses, the throw took the rest of the
   * interface with it.
   *
   * A function and a symbol are included deliberately: a real `postMessage`
   * refuses those with a `DataCloneError`, so this is a divergence rather than
   * an oversight — being more permissive than the platform cannot break a card
   * that the platform would have refused.
   */
  const it = sink()
  for (const message of [
    undefined, null, 0, '', false, Symbol('x'), () => undefined,
    { type: 42 }, { type: '' }, [], new Map(), Object.create(null) as object,
  ]) {
    // Labelled through `describeMessage`, not `String`: a null-prototype
    // object cannot be converted to a primitive, and a failure message that
    // throws would replace the finding with its own stack.
    assert.doesNotThrow(
      () => { it.post(message, undefined, undefined) },
      `threw on ${describeMessage(message)}`,
    )
  }
  assert.equal(it.measured(), 0)
})

test('a shape discovered past the report budget is counted, and silences nothing before it', () => {
  /*
   * The second draft bug. Checking the cap on every call would have made the
   * ninth distinct shape stop the reports for the eight already being tracked —
   * so a card that invents a type per post would take every other diagnostic
   * down with it. The cap is applied when a shape is first seen instead.
   */
  const it = sink()
  for (let at = 0; at < REPORT_LIMIT; at += 1) it.post({ type: `shape-${String(at)}` })
  assert.equal(it.notes().length, REPORT_LIMIT, 'the budget did not cover its own limit')

  it.post({ type: 'one-too-many' })
  assert.equal(it.notes().length, REPORT_LIMIT, 'a shape past the budget was reported')

  // And the shapes already tracked keep escalating: nine more of the first one
  // reaches its tenth, which is the report the naive cap would have eaten.
  for (let at = 0; at < 9; at += 1) it.post({ type: 'shape-0' })
  assert.equal(it.notes().length, REPORT_LIMIT + 1, 'a tracked shape stopped escalating')
  assert.match(it.notes().at(-1) ?? '', /10 of them/)
})

test('two shapes are two rows, so one card does not hide behind another', () => {
  const it = sink()
  it.post('toggle-forum-overlay')
  it.post({ event: '__devtools-kit-broadcast-messaging-event-key__' })

  assert.equal(it.notes().length, 2)
  assert.match(it.notes()[1] ?? '', /an object with event/)
})

test('describeMessage names the value a reader would go looking for', () => {
  assert.equal(describeMessage('toggle-forum-overlay'), "'toggle-forum-overlay'")
  assert.equal(describeMessage({ type: 'resizeIframe' }), "type 'resizeIframe'")
  assert.equal(describeMessage({ event: 'x', data: 1 }), '(an object with event, data)')
  assert.equal(describeMessage({}), '(an object with no keys)')
  assert.equal(describeMessage(7), '(a number)')
  assert.equal(describeMessage(null), '(a object)')
  // A card's string is a card's length. Truncated so one message cannot fill
  // the panel, with the ellipsis saying that it was.
  const long = describeMessage('x'.repeat(200))
  // The cap plus its own punctuation, written as the sum rather than as 67: the
  // number is not the invariant, "64 characters of the card's string" is.
  assert.equal(long.length, 64 + "'…'".length, long)
  assert.match(long, /…'$/)
})

test('the frame entry wires the sink to the height reporter, out of the member table', () => {
  /*
   * The seam. Every assertion above holds if `frame-entry.ts` hands the sink a
   * `remeasure` that measures nothing, or builds the sink by importing this
   * module directly — the first is a card whose resizes are counted and
   * ignored, the second puts the module back in the per-frame bootstrap that
   * had 47 bytes of headroom. Both are invisible from either side of the seam,
   * so they are pinned on the wiring itself, the way `frame-scroll.test.ts`
   * pins the single overflow decision.
   */
  const entry = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sandbox', 'frame-entry.ts'),
    'utf8',
  )

  // Out of the fetched table, not imported into the bootstrap.
  assert.match(entry, /postToParent: members\.createParentMessages\(/u)
  assert.equal(
    entry.includes("from './parent-messages.ts'"),
    false,
    'the policy was imported into the per-frame bootstrap instead of read off the member table',
  )

  // And the nudge is the height reporter's own schedule, not a no-op.
  assert.match(entry, /remeasure: \(\) => \{ requestRemeasure\?\.\(\) \}/u)
  assert.match(entry, /requestRemeasure = reportHeight\(run, post\)/u)
  /*
   * The schedule, not `send`: it is rAF-coalesced, and one measured sender
   * posts from inside a `requestAnimationFrame` callback already. Whole line,
   * because a bracket-counting regex over a nested call is the kind of
   * instrument that passes for the wrong reason.
   */
  const returned = entry.split(/\r?\n/u).filter(line => /^\s{2}return schedule$/u.test(line))
  assert.equal(returned.length, 1, 'reportHeight does not hand back exactly its own schedule')
})

test('heightRequest separates the three answers it has to separate', () => {
  assert.equal(heightRequest({ type: 'resizeIframe', height: 912 }), 912)
  assert.equal(heightRequest({ type: 'iframeResize', height: 1 }), 1)
  assert.equal(heightRequest({ type: 'resizeIframe' }), true)
  assert.equal(heightRequest({ type: 'yinqi_meta_updated' }), false)
  assert.equal(heightRequest('resizeIframe'), false, 'a bare string named the type')
  assert.equal(heightRequest(null), false)
})
