/**
 * The three SillyTavern anchors, exercised the way the measured cards use them.
 *
 * @module iris-web/tests/st-anchors
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { KNOWN_ST_IDS, createStAnchors } from '../src/sandbox/st-anchors.ts'

/** The anchors over a stubbed shell, with everything a test needs to see. */
function anchors(options?: { generating?: boolean }) {
  let draft = ''
  let generating = options?.generating ?? false
  const sends: number[] = []
  const reports: { message: string, failed: boolean }[] = []

  const built = createStAnchors({
    draft: () => draft,
    setDraft: text => { draft = text },
    send: () => sends.push(Date.now()),
    generating: () => generating,
    report: (message, failed) => reports.push({ message, failed }),
  })

  return {
    textarea: built['send_textarea'] as Record<string, unknown>,
    button: built['send_but'] as Record<string, unknown>,
    stop: built['mes_stop'] as Record<string, unknown>,
    draft: () => draft,
    sends: () => sends.length,
    reports,
    generate: (running: boolean) => { generating = running },
  }
}

test('writing the value is what tells the shell, because one variant dispatches nothing', () => {
  /*
   * **Two measured variants, and the pair of them is the design.** One writes
   * `.value`, dispatches `input` and `change`, waits 300 ms and clicks
   * `#send_but`. The other uses jQuery `.val()`, **dispatches nothing**, and
   * triggers the click straight away. So the send path may not depend on having
   * seen an event — the value setter is the only point both variants pass
   * through.
   */
  const it = anchors()

  it.textarea['value'] = 'from the card'
  assert.equal(it.draft(), 'from the card', 'the shell was never told')
  assert.equal(it.textarea['value'], 'from the card', 'the card must read back what it wrote')

  // And the event, when a card does send one, is accepted and silent: it is
  // redundant by construction, so reporting it would put a line in the panel on
  // the path that works.
  assert.equal((it.textarea['dispatchEvent'] as () => boolean)(), true)
  assert.deepEqual(it.reports, [])
})

test('a value is coerced, as a real textarea coerces it', () => {
  const it = anchors()
  it.textarea['value'] = 42
  assert.equal(it.draft(), '42')
})

test('the composer reads visible to jQuery, which does not read style.display', () => {
  /*
   * jQuery's `:visible` is `offsetWidth || offsetHeight || getClientRects().length`.
   * A stand-in reporting zeros would read as hidden, and a card gating on it
   * would skip the composer entirely — silently, since skipping is not an error.
   */
  const it = anchors()
  assert.ok((it.textarea['offsetWidth'] as number) > 0)
  assert.ok((it.textarea['offsetHeight'] as number) > 0)
  assert.equal((it.textarea['getClientRects'] as () => unknown[])().length, 1)
})

test('clicking send sends once, and says so every time', () => {
  /*
   * **Reported every time, and not deduplicated.** A card sending a message on
   * the reader's behalf is a card function upstream has, so it is not refused —
   * but it is an outward action, and the note is what carries its visibility.
   * Two sends are two events; a deduplicated report would show one.
   */
  const it = anchors()
  it.textarea['value'] = 'hello'
  ;(it.button['click'] as () => void)()
  ;(it.button['click'] as () => void)()

  assert.equal(it.sends(), 2)
  const said = it.reports.filter(row => row.message.includes('sent a message through the composer'))
  assert.equal(said.length, 2, 'two sends must read as two events')
  assert.equal(said[0]?.failed, false, 'an upstream-supported action is not a failure')
})

test('clicking send during a generation is ignored, as upstream ignores its own button', () => {
  const it = anchors({ generating: true })
  ;(it.button['click'] as () => void)()

  assert.equal(it.sends(), 0)
  assert.match(it.reports[0]?.message ?? '', /already running/)
})

test('disabled is both a property and a class, because cards read both', () => {
  // Upstream's `#send_but` is a div carrying the class; a card reading one
  // spelling must not disagree with a card reading the other.
  const it = anchors()
  assert.equal(it.button['disabled'], false)
  assert.equal((it.button['classList'] as { contains: (n: string) => boolean }).contains('disabled'), false)
  assert.equal(it.button['className'], '')

  it.generate(true)
  assert.equal(it.button['disabled'], true)
  assert.equal((it.button['classList'] as { contains: (n: string) => boolean }).contains('disabled'), true)
  assert.equal(it.button['className'], 'disabled')
})

test('a class a card adds itself is remembered beside the live one', () => {
  // A card that marks the button and later checks its own mark should find it.
  const it = anchors()
  const list = it.button['classList'] as {
    add: (n: string) => void
    contains: (n: string) => boolean
    remove: (n: string) => void
  }
  list.add('my-mark')
  assert.equal(list.contains('my-mark'), true)
  it.generate(true)
  assert.equal(list.contains('my-mark'), true, 'the live class must not displace the card’s')
  assert.equal(list.contains('disabled'), true)
  list.remove('my-mark')
  assert.equal(list.contains('my-mark'), false)
})

test('send_but is a div, because upstream’s is', () => {
  // A card that checks `tagName` or styles it as a button would be wrong about
  // a real SillyTavern too, so agreeing with upstream is the compatible answer.
  const it = anchors()
  assert.equal(it.button['tagName'], 'DIV')
})

test('mes_stop is visible exactly while a generation runs', () => {
  /*
   * The only thing this element is read for. And it must be visible in
   * **jQuery's** sense: `display:none` alone would not do it, because `:visible`
   * does not read `style.display`.
   */
  const it = anchors()
  const rects = () => (it.stop['getClientRects'] as () => unknown[])()

  assert.equal(it.stop['offsetHeight'], 0)
  assert.equal(rects().length, 0)
  assert.equal((it.stop['style'] as { display: string }).display, 'none')

  it.generate(true)
  assert.ok((it.stop['offsetHeight'] as number) > 0)
  assert.equal(rects().length, 1)
  assert.equal((it.stop['style'] as { display: string }).display, 'block')
})

test('stopping a generation is refused as a fault, since that arm is not built', () => {
  // A card clicking `#mes_stop` expects the generation to stop. Nothing here
  // stops it, so this is one of the few reads on these anchors where "nothing
  // happened" is a failure rather than a note.
  const it = anchors({ generating: true })
  ;(it.stop['click'] as () => void)()
  assert.equal(it.reports[0]?.failed, true)
  assert.match(it.reports[0]?.message ?? '', /nothing was stopped/)
})

test('an unbuilt member is reported once and answers undefined', () => {
  /*
   * `undefined` rather than a throw, because `document.readyState` already
   * proved a throw too expensive — it killed a whole script over a benign read.
   * Reported because these are *drivers*: a card that reads an unbuilt member
   * and carries on has a working-looking path that does nothing.
   */
  const it = anchors()
  assert.equal(it.textarea['selectionStart'], undefined)
  assert.equal(it.textarea['selectionStart'], undefined)
  const said = it.reports.filter(row => row.message.includes('selectionStart'))
  assert.equal(said.length, 1, 'reported once, not once per read')
  assert.equal(said[0]?.failed, false)
})

test('an unknown write is kept, because upstream’s real element keeps it', () => {
  // Cards park state on these elements. Refusing would be a divergence with no
  // safety argument behind it; the report keeps the surface's real extent
  // visible without changing behaviour.
  const it = anchors()
  it.textarea['_cardFlag'] = 7
  assert.equal(it.textarea['_cardFlag'], 7)
  assert.equal(it.reports.filter(row => row.message.includes('_cardFlag')).length, 1)
})

test('a known member is not reported, so the report means something', () => {
  // Without this the report would fire on every access and stop being a signal.
  const it = anchors()
  void it.textarea['value']
  void it.button['disabled']
  void it.stop['offsetHeight']
  assert.deepEqual(it.reports, [])
})

test('the ids Iris knows about but does not provide are named', () => {
  /*
   * So a lookup can say "this is SillyTavern's X and Iris has no stand-in"
   * rather than answering `null` and letting the card die a line later on
   * `null.querySelector` — which is how 不要被神隐's script fails today.
   */
  assert.ok(KNOWN_ST_IDS.includes('send_form'))
  assert.ok(KNOWN_ST_IDS.includes('sheld'))
  // And the three that *are* provided are not in the list, or a lookup would
  // report a gap for something it just answered.
  for (const id of ['send_textarea', 'send_but', 'mes_stop']) {
    assert.equal(KNOWN_ST_IDS.includes(id), false, `${id} is provided, so it is not a known gap`)
  }
})
