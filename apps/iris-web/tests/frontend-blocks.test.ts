/**
 * The message-frame predicate, and the ways it is meant to be surprising.
 *
 * Step one of the pipeline is only this caliper, so these assertions are the
 * whole of what can be checked before a frame exists. Three of them pin
 * behaviour that reads as a bug until you know it is upstream's, and one pins a
 * mistake this design made and retracted before implementation.
 *
 * @module iris-web/tests/frontend-blocks
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { claimFrontendBlocks, frontendMarker } from '../src/sandbox/frontend-blocks.ts'

/** A fence, built from code points so no escape has to survive being written. */
const TICKS = String.fromCharCode(96, 96, 96)
const NL = String.fromCharCode(10)

/** Assemble a fenced block. */
function fenced(info: string, body: string): string {
  return [TICKS + info, body, TICKS].join(NL)
}

test('a block is claimed by its content, never by its fence label', () => {
  /*
   * The most surprising thing the predicate does, and not hypothetical: the one
   * real block in the local corpus is labelled `text`. Routing by language would
   * claim nothing at all.
   */
  for (const info of ['text', 'html', 'json', '']) {
    const claimed = claimFrontendBlocks(fenced(info, '<body><h1>hi</h1></body>'))
    assert.equal(claimed.length, 1, `a block labelled "${info}" should be claimed`)
    assert.equal(claimed[0]?.matched, '<body')
  }
})

test('the label is recorded even though it is never consulted', () => {
  // Carried for the diagnostic, which has to be able to say "claimed a block
  // labelled `text`" — the fact a reader will not believe otherwise.
  const claimed = claimFrontendBlocks(fenced('text', '<body>'))
  assert.equal(claimed[0]?.info, 'text')
})

test('an ordinary code block is not claimed', () => {
  const claimed = claimFrontendBlocks(fenced('js', 'const x = 1'))
  assert.deepEqual(claimed, [])
})

test('each of upstream’s three markers claims, with its own odd shape', () => {
  /*
   * The three are not spelled consistently, and copying them exactly matters
   * more than tidying them:
   *
   * - `'html>'` has no opening bracket, so it matches `</html>` as well as
   *   `<html>`;
   * - `'<head>'` is a whole tag, so `<head class="x">` does **not** match it;
   * - `'<body'` has no closing bracket, so `<body class="x">` does.
   *
   * An earlier version of this test asserted "none is a whole tag", which is
   * false of the middle one — the test caught the description, not the code.
   */
  assert.equal(frontendMarker('</html>'), 'html>')
  assert.equal(frontendMarker('<head>'), '<head>')
  assert.equal(frontendMarker('<body class="x">'), '<body')

  assert.equal(frontendMarker('<head class="x">'), undefined, 'the whole-tag marker is literal')
  assert.equal(frontendMarker('<div>nothing here</div>'), undefined)
})

test('an indented block is claimed too, not only a fenced one', () => {
  /*
   * Upstream tests `<pre>` elements, and an indented block becomes one just as a
   * fence does. A caliper counting only fences under-counts; the corpus happens
   * to have none, which is luck rather than licence.
   */
  const source = ['some prose', '', '    <body>', '    <h1>hi</h1>', '', 'after'].join(NL)
  const claimed = claimFrontendBlocks(source)

  assert.equal(claimed.length, 1)
  assert.equal(claimed[0]?.kind, 'indented')
  // The indentation is removed: what a frame runs is the card's markup, not the
  // markup shifted four spaces into a `<pre>`.
  assert.equal(claimed[0]?.body.startsWith('<body>'), true)
})

test('indented prose continuing a paragraph is not a block', () => {
  /*
   * CommonMark: indented code cannot interrupt a paragraph. Without this rule,
   * ordinary wrapped narration that happens to be indented would be scanned as
   * code — and any of it mentioning `<body` claimed as an interface.
   */
  const source = ['a sentence that wraps', '    and continues with <body> in it'].join(NL)
  assert.deepEqual(claimFrontendBlocks(source), [])
})

test('entities are NOT decoded, which is the retraction this design made', () => {
  /*
   * The first draft required decoding, reasoning that upstream reads `.text()`
   * and `.text()` decodes. The layer in between settles it: showdown escapes a
   * block's body on the way in (`&` → `&amp;`, `<` → `&lt;`), so the two steps
   * compose to the identity and `.text()` returns the author's own characters.
   *
   * Decoding here would claim blocks upstream leaves alone. Both censuses found
   * zero affected blocks, so **no test against the local corpus could have
   * caught this** — it would have shipped as a silent divergence.
   */
  const encoded = claimFrontendBlocks(fenced('html', '&lt;body&gt;<h1>hi</h1>'))
  assert.deepEqual(encoded, [], 'an encoded entity is a literal, not a tag')

  const literal = claimFrontendBlocks(fenced('html', '<body><h1>hi</h1>'))
  assert.equal(literal.length, 1, 'a real tag still claims')
})

test('a block that merely mentions the marker is claimed, and that is upstream', () => {
  /*
   * The false-positive surface, tested rather than avoided. Substring
   * containment means a tutorial, a bug report, or a census of this very
   * predicate becomes an interface. Upstream behaves this way and has no switch
   * for it; narrowing would drop real cards, and the safety argument is the
   * sandbox wall, not the predicate's precision.
   *
   * This test exists so that a later reader who decides to "fix" it has to
   * delete an assertion that says why not.
   */
  const prose = fenced('md', 'To make a card interface, start your block with <body and')
  assert.equal(claimFrontendBlocks(prose).length, 1)
})

test('two interfaces in one message are claimed separately, in order', () => {
  const source = [fenced('html', '<body>first'), '', 'prose between', '', fenced('text', '<body>second')].join(NL)
  const claimed = claimFrontendBlocks(source)

  assert.equal(claimed.length, 2)
  assert.ok(claimed[0]?.body.includes('first'))
  assert.ok(claimed[1]?.body.includes('second'))
  assert.ok((claimed[0]?.end ?? 0) <= (claimed[1]?.start ?? 0), 'spans must not overlap')
})

test('the reported span covers the block, so a caller can replace it', () => {
  const before = 'prose before' + NL + NL
  const source = before + fenced('html', '<body>x')
  const claimed = claimFrontendBlocks(source)

  assert.equal(claimed.length, 1)
  const span = source.slice(claimed[0]?.start ?? 0, claimed[0]?.end ?? 0)
  assert.ok(span.startsWith(TICKS), `span should start at the fence, got: ${span.slice(0, 20)}`)
  assert.ok(span.trimEnd().endsWith(TICKS), 'span should end at the closing fence')
  assert.ok(!span.includes('prose before'))
})

test('an unclosed fence still claims, because a streaming reply looks like that', () => {
  // Half an interface is still that interface; whether to wait for the rest is
  // the caller's decision, not the caliper's.
  const source = [TICKS + 'html', '<body>', '<h1>still arriving'].join(NL)
  const claimed = claimFrontendBlocks(source)

  assert.equal(claimed.length, 1)
  assert.equal(claimed[0]?.end, source.length)
})

test('a tilde fence works, and a backtick run inside an info string does not', () => {
  const tildes = String.fromCharCode(126, 126, 126)
  const claimed = claimFrontendBlocks([tildes + 'html', '<body>', tildes].join(NL))
  assert.equal(claimed.length, 1)

  // A backtick in a backtick fence's info string is not a fence (CommonMark),
  // or every inline code span would open one.
  const inline = claimFrontendBlocks(TICKS + 'x`y' + NL + '<body>' + NL + TICKS)
  assert.deepEqual(inline, [])
})

test('a message with no blocks claims nothing, and says so by being empty', () => {
  assert.deepEqual(claimFrontendBlocks('just prose with <body> loose in it'), [])
})
