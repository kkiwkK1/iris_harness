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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  claimFrontendBlocks,
  frontendMarker,
  splitAroundInterfaces,
} from '../src/sandbox/frontend-blocks.ts'
import { planFrames, type FrameCandidate } from '../src/app/frame-budget.ts'

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

test('an interface replaces its block rather than following the message', () => {
  /*
   * Observed on the sample card: the first cut appended frames after the whole
   * message, so a reader scrolled through 360 KiB of source before reaching the
   * interface that source describes. Upstream hides the block and puts the frame
   * where it was. Side by side is not a milder version of replacement.
   */
  const source = ['before', '', fenced('html', '<body>panel'), '', 'after'].join(NL)
  const segments = splitAroundInterfaces(source, claimFrontendBlocks(source))

  assert.deepEqual(
    segments.map(segment => segment.kind),
    ['text', 'interface', 'text'],
    'the interface belongs between the prose, not after it',
  )
  const first = segments[0]
  const last = segments[2]
  assert.ok(first?.kind === 'text' && first.text.includes('before'))
  assert.ok(last?.kind === 'text' && last.text.includes('after'))

  // The source of the claimed block must not survive into any prose segment —
  // that is the whole point.
  const prose = segments.filter(s => s.kind === 'text').map(s => (s.kind === 'text' ? s.text : '')).join('')
  assert.ok(!prose.includes('<body>panel'))
})

test('two interfaces keep their order and their surrounding prose', () => {
  const source = [
    fenced('html', '<body>one'),
    '',
    'between them',
    '',
    fenced('text', '<body>two'),
  ].join(NL)
  const segments = splitAroundInterfaces(source, claimFrontendBlocks(source))

  assert.deepEqual(
    segments.map(segment => segment.kind),
    ['interface', 'text', 'interface'],
  )
  assert.deepEqual(
    segments.filter(s => s.kind === 'interface').map(s => (s.kind === 'interface' ? s.instance : -1)),
    [0, 1],
    'instances must stay in source order',
  )
})

test('whitespace between interfaces is not rendered as prose', () => {
  // A gap of blank lines is not a paragraph, and emitting one would put an empty
  // block between two panels.
  const source = [fenced('html', '<body>one'), '', '   ', '', fenced('html', '<body>two')].join(NL)
  const segments = splitAroundInterfaces(source, claimFrontendBlocks(source))

  assert.deepEqual(segments.map(segment => segment.kind), ['interface', 'interface'])
})

test('a message with no interfaces is one piece of prose, unchanged', () => {
  const source = 'just some narration'
  assert.deepEqual(splitAroundInterfaces(source, []), [{ kind: 'text', text: source }])
})

/*
 * The bare-HTML composer (`claimMessageSurfaces`). These fixtures are card
 * shapes, not inventions: the widget is the MVU status panel shape (a `<div>`
 * with a `<style>`, no fence anywhere), the fragment shape is the 936-floor
 * corpus's fragment band, and the fence shapes are the fence pipeline's own.
 */
import { claimMessageSurfaces } from '../src/sandbox/frontend-blocks.ts'

test('a bare status widget is claimed where a fence would be, with its exact text', () => {
  const widget = [
    '<div class="de24-update-widget">',
    '<style>.de24-update-widget{color:red}</style>',
    '</div>',
  ].join(NL)
  const source = ['她抬头看了一眼。', '', widget, '', '然后低头继续。'].join(NL)
  const { blocks, refused } = claimMessageSurfaces(source)

  assert.deepEqual(refused, [])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'bare-html')
  assert.equal(blocks[0]?.body, widget, 'the frame runs the widget itself, not the message around it')
  assert.equal(blocks[0]?.matched, '<div')
  // The span is spliced by offset, so it must round-trip against the source.
  assert.equal(source.slice(blocks[0]?.start ?? 0, blocks[0]?.end ?? 0), widget)
})

test('a fenced block is claimed once, and its body never opens a bare region', () => {
  // The fence body's line-initial tags sit at line start exactly like a bare
  // region's would. Fence-first composition means the fence wins and nothing
  // is double-claimed.
  const source = [
    '前言。',
    '',
    fenced('html', '<body>\n<div>inside a fence</div>'),
    '',
    '<div>bare tail</div>',
  ].join(NL)
  const { blocks } = claimMessageSurfaces(source)

  assert.equal(blocks.length, 2, 'the fence and the bare tail, and nothing claimed twice')
  assert.equal(blocks[0]?.kind, 'fenced')
  assert.ok(blocks[0]?.body.includes('<div>inside a fence</div>'), 'the fence body stays whole in its own claim')
  assert.equal(blocks[1]?.kind, 'bare-html')
  assert.equal(blocks[1]?.body, '<div>bare tail</div>')
})

test('an unclaimed fence is code, not a leaked pair of backticks', () => {
  // A fence whose body carries no marker is not an interface upstream either —
  // but if the bare-HTML split read past its fence, the widget inside would be
  // claimed while the fence markers themselves fell into the prose. Rendering
  // source as source is upstream's answer; rendering it as a panel plus stray
  // backticks is nobody's.
  const source = ['看这段：', '', fenced('html', '<div>not an interface</div>'), '', '完事。'].join(NL)
  const { blocks } = claimMessageSurfaces(source)

  assert.deepEqual(blocks, [], 'a marker-less fence is claimed by neither claimer')
})

test('prose between two bare regions stays prose', () => {
  const source = ['<div>一</div>', '', '中间这段是叙事。', '', '<div>二</div>'].join(NL)
  const { blocks } = claimMessageSurfaces(source)
  const segments = splitAroundInterfaces(source, blocks)

  assert.deepEqual(blocks.map(block => block.kind), ['bare-html', 'bare-html'])
  assert.deepEqual(
    segments.map(segment => segment.kind),
    ['interface', 'text', 'interface'],
  )
  const middle = segments[1]
  assert.ok(middle?.kind === 'text' && middle.text.includes('中间这段是叙事。'))
})

test('an unclosed bare region claims to the end and reports itself', () => {
  const source = ['<div>', '<span>x</span>', '', '后面还有叙事'].join(NL)
  const { blocks, refused } = claimMessageSurfaces(source)

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.end, source.length, 'the fallback takes the rest')
  assert.equal(refused.length, 1, refused.join(','))
  assert.match(refused[0] ?? '', /<div>/)
  assert.match(refused[0] ?? '', /never closed/)
})

test('deep-indented lines behind blank lines do not carve a bare region', () => {
  // Four leading spaces after a blank line is CommonMark indented code to the
  // fence pipeline, and card markup is written exactly that way. Excluding
  // indented spans from the split would cut the panel in half, so they are not
  // excluded — and the region comes out whole.
  const widget = ['<div class="panel">', '', '    <span>deep</span>', '', '</div>'].join(NL)
  const { blocks, refused } = claimMessageSurfaces(widget)

  assert.deepEqual(refused, [])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.body, widget)
})

test('a marker-carrying indented block outranks a region reaching into it', () => {
  // The one clash fence-first composition cannot prevent: a region whose span
  // crosses a claimed indented block. The claim wins and the region falls back
  // to the renderer — the behaviour the message had before this pipeline —
  // rather than half a panel being framed.
  const source = ['<div>', '', '    <body>', '    plain', '', '</div>'].join(NL)
  const { blocks } = claimMessageSurfaces(source)

  assert.equal(blocks.length, 1, 'the indented claim, and no overlapping region beside it')
  assert.equal(blocks[0]?.kind, 'indented')
})

test('bare HTML alone is invisible to the fence caliper, which keeps its census contract', () => {
  // `claimFrontendBlocks` feeds the corpus census and the fence pipeline's own
  // tests; its population must not silently grow to include regions.
  const source = ['<div>', '<span>x</span>', '</div>'].join(NL)
  assert.deepEqual(claimFrontendBlocks(source), [])
})

test('the budget plans over both kinds through one claim list', () => {
  // The wiring contract the frame budget depends on: candidates derived from
  // `claimMessageSurfaces` number fence claims and bare claims in one source
  // order, so planFrames rations them identically and a placeholder's instance
  // names the same surface the row spliced.
  const source = [
    '<div>first bare</div>',
    '',
    fenced('text', '<body>fenced'),
    '',
    '<div>second bare</div>',
  ].join(NL)
  const { blocks } = claimMessageSurfaces(source)
  const candidates: FrameCandidate[] = blocks.map((block, instance) => ({ floor: 7, instance, body: block.body }))
  const plan = planFrames(candidates, { granted: new Set<string>(), opened: new Set<string>() })

  assert.deepEqual(blocks.map(block => block.kind), ['bare-html', 'fenced', 'bare-html'])
  assert.equal(plan.refused.size, 0, 'a small message fits, whatever kind each surface is')
  assert.deepEqual(
    [...plan.render].sort(),
    ['7:0', '7:1', '7:2'],
    'instances run in source order across both kinds',
  )
})

test('every consumer of the claim claims the combined list, not the fence-only one', () => {
  /*
   * Three places derive surfaces from one message text: the budget plans over
   * it, the controller runs frames for it, and the row splices prose around it.
   * If any one of them went back to `claimFrontendBlocks`, its instance numbers
   * would disagree with the other two — a frame built into a neighbour's slot,
   * which is the fault the shared list exists to prevent. Read at the source
   * because the disagreement only shows across files, which no single-file test
   * can see.
   */
  const consumers = [
    '../src/app/FrameBudget.tsx',
    '../src/app/useMessageInterfaces.tsx',
    '../src/app/MessageInterfaces.tsx',
  ]
  for (const file of consumers) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    assert.match(source, /claimMessageSurfaces/, `${file} must claim the combined list`)
    assert.doesNotMatch(source, /claimFrontendBlocks/, `${file} must not claim fences only`)
  }
})

test('an unclosed region reaches the report channel from the row that rendered it', () => {
  // The note has a named destination (`addCardReport`, the frames' own channel)
  // — the split's `refused` must not stop at the component. Asserted at the
  // source alongside the composer's own refused test, which pins the note's
  // text; this pins its journey.
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/MessageInterfaces.tsx', import.meta.url)),
    'utf8',
  )
  assert.match(source, /refusedNote/, 'the row must hold the split notes')
  assert.match(source, /addCardReport[^]*?channel: 'interface'/, 'the note goes to the report channel')
})

