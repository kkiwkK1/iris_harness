/**
 * The quote rule, against the kinds it names and the places it must not reach.
 *
 * Two halves, because the feature has two: a **string rule** transcribed from
 * `public/script.js:1845-1871`, which can be asserted the way upstream would
 * assert it, and a **DOM pass** that is the part Iris had to invent — the prose
 * renderer takes text and lets no HTML into the DOM, so the `<q>` elements are
 * made after rendering rather than before it (`notes/apps/iris-web/DEVIATIONS.md`
 * §121).
 *
 * **Everything below that does not name a scope runs under the default**, which
 * is `'dialogue'` — the three pairs that mark speech (§122). The scope is the
 * one thing about this rule that is Iris's rather than upstream's, so the pair
 * of tests that pins it says both halves: what `'dialogue'` refuses, and that
 * `'upstream'` still takes upstream's six.
 *
 * The DOM half asserts on `textContent` as often as on the elements. That is
 * the property that matters and the one a decoration pass can silently break:
 * a reader would notice a duplicated clause long before they noticed a missing
 * colour.
 *
 * @module iris-web/tests/quoted-dialogue
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import {
  clearQuotedDialogue,
  markQuotedDialogue,
  marksQuotedDialogue,
  quotedDialogueRuns,
  type QuoteScope,
} from '../src/app/quoted-dialogue.ts'

/**
 * The quoted substrings of a text, as the rule sees them.
 * @param text - the text to scan.
 * @param scope - which quote pairs count; the default when omitted.
 * @returns each run, marks included.
 */
function quoted(text: string, scope?: QuoteScope): string[] {
  return quotedDialogueRuns(text, scope).map(run => text.slice(run.start, run.end))
}

/**
 * A prose container holding the given markup.
 * @param html - the rendered prose.
 * @returns the container element.
 */
function prose(html: string): Element {
  const { window } = new JSDOM(`<!doctype html><html><body><div class="iris-msg__text">${html}</div></body></html>`)
  const root = window.document.querySelector('.iris-msg__text')
  assert.ok(root !== null, 'the fixture must have a prose container')
  return root
}

test('the three speech kinds wrap by default, marks and all', () => {
  assert.deepEqual(quoted('He said "hello" softly.'), ['"hello"'])
  assert.deepEqual(quoted('He said “hello” softly.'), ['“hello”'])
  assert.deepEqual(quoted('Il dit «bonjour» doucement.'), ['«bonjour»'])
  // And the default really is the default: the same three, named.
  assert.deepEqual(quoted('He said “hello” softly.', 'dialogue'), ['“hello”'])
})

test('the three bracket kinds are terms, not dialogue — unless the reader asks for upstream’s six', () => {
  /*
   * §122, and the owner's example is the whole argument: 「资格」转为「职责」 is
   * two terms in a sentence about duty, not two lines of speech. Colouring
   * them paints the page and points at nothing.
   */
  assert.deepEqual(quoted('从「资格」转为「职责」。'), [], 'corner brackets are not speech by default')
  assert.deepEqual(quoted('『こんにちは』と言った'), [])
  assert.deepEqual(quoted('＂hello＂ he said.'), [])

  // The compatibility floor, reachable from the settings panel: upstream's six.
  assert.deepEqual(quoted('「こんにちは」と言った', 'upstream'), ['「こんにちは」'])
  assert.deepEqual(quoted('『こんにちは』と言った', 'upstream'), ['『こんにちは』'])
  assert.deepEqual(quoted('＂hello＂ he said.', 'upstream'), ['＂hello＂'])
  // The three speech pairs are in both scopes, in upstream's order.
  assert.deepEqual(quoted('He said "hello" softly.', 'upstream'), ['"hello"'])
  assert.deepEqual(quoted('He said “hello” softly.', 'upstream'), ['“hello”'])
  assert.deepEqual(quoted('Il dit «bonjour» doucement.', 'upstream'), ['«bonjour»'])
})

test('a line of speech and a bracketed term in one sentence: one run by default, two upstream', () => {
  const line = '她说“我明白了”，然后把「资格」两个字念了一遍。'
  assert.deepEqual(quoted(line), ['“我明白了”'])
  assert.deepEqual(quoted(line, 'upstream'), ['“我明白了”', '「资格」'])
})

test('the scope reaches the DOM pass, and it is the same default there', () => {
  const html = '<p>她说“我明白了”，然后把「资格」两个字念了一遍。</p>'
  assert.equal(markQuotedDialogue(prose(html)), 1, 'the bracketed term was coloured by default')
  assert.equal(markQuotedDialogue(prose(html), 'dialogue'), 1)
  assert.equal(markQuotedDialogue(prose(html), 'upstream'), 2, 'upstream’s six did not reach the marking pass')

  const upstream = prose(html)
  markQuotedDialogue(upstream, 'upstream')
  assert.deepEqual(
    [...upstream.querySelectorAll('q')].map(mark => mark.textContent),
    ['“我明白了”', '「资格」'],
    'the marks are inside the elements under either scope',
  )
})

test('two quoted runs on one line are two runs, and the prose between them is not one', () => {
  assert.deepEqual(
    quoted('"Yes," she said. "No," he answered.'),
    ['"Yes,"', '"No,"'],
  )
})

test('an empty quotation is still a quotation, because upstream’s `.*?` matches nothing', () => {
  assert.deepEqual(quoted('He said "" and left.'), ['""'])
})

test('a quotation cannot cross a line, because upstream’s regex has no `s` flag', () => {
  assert.deepEqual(quoted('He said "hello\nworld" softly.'), [])
  assert.deepEqual(quoted('"one"\n"two"'), ['"one"', '"two"'])
})

test('an unbalanced quote mark is left alone, and an odd count wraps only the pair', () => {
  assert.deepEqual(quoted('He said "hello and left.'), [])
  assert.deepEqual(quoted('"one" and "two'), ['"one"'])
})

test('nesting is the outer pair, because the scan resumes past the run it took', () => {
  assert.deepEqual(
    quoted('“he said "hi" then”'),
    ['“he said "hi" then”'],
  )
  assert.deepEqual(
    quoted('"he said “hi” then"'),
    ['"he said “hi” then"'],
  )
})

test('quotes inside code are not dialogue — all five of upstream’s code alternatives', () => {
  assert.deepEqual(quoted('a `say "hi"` b'), [])
  assert.deepEqual(quoted('a ``say "hi"`` b'), [])
  assert.deepEqual(quoted('a ```\nsay "hi"\n``` b'), [])
  assert.deepEqual(quoted('a ~~~\nsay "hi"\n~~~ b'), [])
  assert.deepEqual(quoted('a <style>p::after{content:"x"}</style> b'), [])
})

test('quotes inside a tag are attribute values, not dialogue', () => {
  assert.deepEqual(quoted('<div class="panel">text</div>'), [])
  assert.deepEqual(
    quoted('<div class="panel">he said "hi"</div>'),
    ['"hi"'],
    'the guard hides the attribute and nothing else',
  )
})

test('the gate is upstream’s one condition, plus the streaming one Iris adds', () => {
  assert.equal(marksQuotedDialogue('assistant', false), true)
  assert.equal(marksQuotedDialogue('user', false), true, 'upstream never asks isUser')
  assert.equal(marksQuotedDialogue('system', false), false, 'upstream’s `if (!isSystem)`')
  assert.equal(marksQuotedDialogue('assistant', true), false, '§121: settled prose only')
})

test('a quoted run in rendered prose becomes a <q> with the marks inside it', () => {
  const root = prose('<p>She said "hello" softly.</p>')
  const before = root.textContent

  assert.equal(markQuotedDialogue(root), 1)
  const marks = root.querySelectorAll('q')
  assert.equal(marks.length, 1)
  assert.equal(marks[0]?.textContent, '"hello"', 'upstream keeps the marks inside the element')
  assert.equal(root.textContent, before, 'the reader’s characters are unchanged')
})

test('a quote that spans inline markup is coloured across it', () => {
  const root = prose('<p>She said "hello <em>world</em>" softly.</p>')
  const before = root.textContent

  const made = markQuotedDialogue(root)
  assert.equal(made, 3, 'one <q> per text node the run reaches — see §121')
  assert.equal(
    [...root.querySelectorAll('q')].map(mark => mark.textContent).join(''),
    '"hello world"',
    'together they cover exactly the run upstream would have wrapped once',
  )
  assert.ok(
    root.querySelector('em > q') !== null,
    'the emphasised half is inside the emphasis, where the renderer put it',
  )
  assert.equal(root.textContent, before)
})

test('a code span is opaque: its quotes are not dialogue and its text is not joined to the prose', () => {
  const root = prose('<p>Type <code>say "hi"</code> to speak.</p>')
  assert.equal(markQuotedDialogue(root), 0)
  assert.equal(root.querySelectorAll('q').length, 0)
})

test('a fenced block is opaque too, and the prose around it still marks', () => {
  const root = prose('<p>He said "go".</p><pre><code>print("go")</code></pre><p>She said "no".</p>')
  assert.equal(markQuotedDialogue(root), 2)
  assert.equal(root.querySelectorAll('pre q').length, 0, 'nothing inside the fence')
  assert.deepEqual([...root.querySelectorAll('q')].map(mark => mark.textContent), ['"go"', '"no"'])
})

test('a quote opened in one paragraph and closed in the next is not a quote', () => {
  const root = prose('<p>She said "hello</p><p>world" he answered.</p>')
  assert.equal(
    markQuotedDialogue(root),
    0,
    'two paragraphs are two lines upstream, and `.` never crossed a newline',
  )
})

test('a <br> is a line break for the rule as well as for the reader', () => {
  const root = prose('<p>She said "hello<br>world" softly.</p>')
  assert.equal(markQuotedDialogue(root), 0)
})

test('an interface slot and a folded scaffold are not prose', () => {
  const root = prose(
    '<div class="iris-interfaces__slot"><p>panel "state"</p></div>'
    + '<details class="iris-bodyleak"><div>plan: say "hi"</div></details>'
    + '<p>She said "hello".</p>',
  )
  assert.equal(markQuotedDialogue(root), 1)
  assert.equal(root.querySelectorAll('.iris-interfaces__slot q').length, 0)
  assert.equal(root.querySelectorAll('.iris-bodyleak q').length, 0)
})

test('marking twice is marking once', () => {
  const root = prose('<p>She said "hello" softly.</p>')
  const before = root.textContent

  assert.equal(markQuotedDialogue(root), 1)
  assert.equal(markQuotedDialogue(root), 1)
  assert.equal(root.querySelectorAll('q').length, 1, 'the second pass took the first one off')
  assert.equal(root.textContent, before)
})

test('clearing puts the tree back exactly as React built it', () => {
  const root = prose('<p>She said "hello" softly.</p>')
  const paragraph = root.querySelector('p')
  assert.ok(paragraph !== null)
  const host = paragraph.firstChild
  const before = root.innerHTML

  markQuotedDialogue(root)
  clearQuotedDialogue(root)

  assert.equal(root.innerHTML, before)
  assert.equal(paragraph.childNodes.length, 1, 'no leftover text nodes')
  assert.equal(paragraph.firstChild, host, 'the node React holds is the node that came back')
})

test('when React has rewritten the host, the clear drops our copy and keeps React’s text', () => {
  const root = prose('<p>She said "hello" softly.</p>')
  const paragraph = root.querySelector('p')
  assert.ok(paragraph !== null)
  const host = paragraph.firstChild
  assert.ok(host !== null)

  markQuotedDialogue(root)
  // What React does on an edit or a swipe that reuses this row: it writes the
  // whole new reading into the text node it owns. This pass had emptied that
  // node, which is exactly how the clear below can tell.
  host.nodeValue = 'She whispered "goodbye" instead.'
  clearQuotedDialogue(root)

  assert.equal(
    root.textContent,
    'She whispered "goodbye" instead.',
    'the old reading’s <q> is gone rather than left beside the new one',
  )
  assert.equal(root.querySelectorAll('q').length, 0)
})

test('a message with no dialogue keeps the exact nodes React built', () => {
  const root = prose('<p>She walked to the window and said nothing.</p>')
  const paragraph = root.querySelector('p')
  assert.ok(paragraph !== null)
  const host = paragraph.firstChild
  const before = root.innerHTML

  assert.equal(markQuotedDialogue(root), 0)

  assert.equal(root.innerHTML, before)
  /*
   * Node identity, not just the serialisation. An empty text node serialises
   * to nothing, so a pass that emptied React's node and hung an identical copy
   * beside it would print the same `innerHTML` and still have moved the text
   * out from under React — which is the one thing this module must never do
   * silently.
   */
  assert.equal(paragraph.childNodes.length, 1, 'no copy was hung beside the original')
  assert.equal(paragraph.firstChild, host, 'and the original is still the one holding the text')
  assert.equal(host?.nodeValue, 'She walked to the window and said nothing.')
})
