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

/*
 * The unknown-markup rule (`unwrapUnknownTagsOutsideCode`), which is the
 * policy of `app/inline-html.ts` plus the question of where it may run.
 */
import { unwrapUnknownTagsOutsideCode } from '../src/sandbox/frontend-blocks.ts'

/**
 * The shape of 灭仇家满门之后，我收养了想对我复仇的孤女's opening message.
 *
 * Its skeleton, not its 16 KiB: one `<Gui>` wrapper at column 0, a ```html
 * fence holding a complete document, the closing `</Gui>`, and a self-closing
 * `<StatusPlaceHolderImpl/>` after a blank line. Those four lines are the whole
 * of what the fault was about, and the interior is stubbed down to the parts
 * the claim predicate reads.
 */
function guiWrappedOpening(): string {
  return [
    '<Gui>',
    fenced('html', [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="UTF-8">',
      '<style>',
      '  #rvr-welcome{position:relative!important;width:100%!important}',
      '</style>',
      '</head>',
      '<body>',
      '<div id="rvr-welcome">初次见面。</div>',
      '</body>',
      '</html>',
    ].join(NL)),
    '</Gui>',
    '',
    '<StatusPlaceHolderImpl/>',
  ].join(NL)
}

test('the Gui wrapper and the placeholder leave the reading surface entirely', () => {
  /*
   * The fault as measured in the browser: the row showed the escaped text
   * `<Gui>`, then the interface, then `</Gui> <StatusPlaceHolderImpl/>`. The
   * card's author has never seen those lines, because upstream hands the whole
   * message to DOMPurify and an unrecognised name is removed with its children
   * hoisted (`purify.cjs.js:1894` → `:1743`) — nothing in the extension layer
   * touches them first (JS-Slash-Runner's own predicate reads already-rendered
   * `<pre>` text, `src/util/is_frontend.ts:1-3`).
   */
  const source = guiWrappedOpening()
  const { blocks, refused } = claimMessageSurfaces(source)

  assert.deepEqual(refused, [])
  assert.equal(blocks.length, 1, 'the document is one interface')
  assert.equal(blocks[0]?.kind, 'fenced')

  const segments = splitAroundInterfaces(source, blocks)
  /*
   * The fixture has teeth only if the wrapper really reaches a prose segment —
   * a fixture that never carried it would let the assertions below pass while
   * proving nothing.
   */
  assert.ok(
    segments.some(segment => segment.kind === 'text' && segment.text.includes('<Gui>')),
    'the split really does strand the wrapper in the prose',
  )

  const prose = segments
    .filter(segment => segment.kind === 'text')
    .map(segment => unwrapUnknownTagsOutsideCode(segment.text))
  assert.equal(prose.length, 2, 'prose above and below the interface')
  for (const text of prose) {
    assert.doesNotMatch(text, /Gui/, `wrapper survived: ${JSON.stringify(text)}`)
    assert.doesNotMatch(text, /StatusPlaceHolderImpl/, `placeholder survived: ${JSON.stringify(text)}`)
  }
  // And nothing is left to render: this opening *is* the interface, so the row
  // shows the frame and no stray paragraph where a wrapper used to be.
  assert.deepEqual(prose.filter(text => text.trim() !== ''), [])
})

test('the frame still gets the document it was going to get', () => {
  // The transform runs on the prose handed to the renderer, never on the
  // claimed span: a frame whose `<!DOCTYPE>` or `<body>` had been rewritten
  // would be a fix that broke the thing it was fixing around.
  const { blocks } = claimMessageSurfaces(guiWrappedOpening())
  const body = blocks[0]?.body ?? ''
  assert.ok(body.includes('<!DOCTYPE html>'), body.slice(0, 80))
  assert.ok(body.includes('<body>'), body.slice(0, 80))
  assert.ok(body.includes('<div id="rvr-welcome">初次见面。</div>'))
})

test('markup a card documents in code keeps its characters', () => {
  /*
   * Both code shapes, because the walk that finds them is the same one the
   * claim pipeline uses and it knows about both. Upstream keeps these too, one
   * layer down: showdown turns a fence into escaped `<pre><code>` before it
   * looks at raw HTML at all (`showdown.js:2504`).
   */
  const fence = ['写卡的人要包一层：', '', fenced('text', '<Gui>…</Gui>'), '', '就这样。'].join(NL)
  assert.equal(unwrapUnknownTagsOutsideCode(fence), fence)

  const indented = ['像这样：', '', '    <StatusPlaceHolderImpl/>', '', '记住了。'].join(NL)
  assert.equal(unwrapUnknownTagsOutsideCode(indented), indented)

  // Prose on either side of a fence is still prose.
  const mixed = ['<Gui>前言</Gui>', '', fenced('text', '<Gui>'), '', '<Gui>尾巴</Gui>'].join(NL)
  const cleaned = unwrapUnknownTagsOutsideCode(mixed)
  assert.ok(cleaned.includes(fenced('text', '<Gui>')), 'the fence survives whole')
  assert.equal(cleaned.split('<Gui>').length - 1, 1, 'exactly the one inside the fence is left')
  assert.ok(cleaned.startsWith('前言'), cleaned.slice(0, 40))
})

test('every string the row hands the renderer goes through the rule', () => {
  /*
   * Two call sites, and the quiet one is the dangerous one: a message with no
   * claimed block takes the early return, and that is the commoner half of the
   * population — the corpus has six cards writing `<StatusPlaceHolderImpl/>`
   * into `first_mes` and only some of them fence an interface beside it. Read
   * at the source because a missed call site is invisible to any test that
   * exercises the path it forgot.
   */
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/MessageInterfaces.tsx', import.meta.url)),
    'utf8',
  )
  const renders = [...source.matchAll(/<MarkdownText[\s\S]*?\/>/g)].map(hit => hit[0])
  assert.equal(renders.length, 2, `MarkdownText call sites: ${String(renders.length)}`)
  for (const render of renders) {
    assert.match(
      render,
      /text=\{(?:unwrapUnknownTagsOutsideCode\(|segment\.text)/,
      `a MarkdownText that skips the rule: ${render}`,
    )
  }
  // The segment form is pre-cleaned in the map above it, so that spelling is
  // only allowed while the map is there.
  assert.match(source, /unwrapUnknownTagsOutsideCode\(segment\.text\)/, 'segments must be cleaned before render')
})

/*
 * A message's own `<style>`: one sheet for the message, copied into the frames
 * its regions became, and gone from both the region list and the prose.
 *
 * The population, measured through this file's own claimer: **13 of 220
 * candidate texts (regex `replaceString`, `first_mes`, alternate greetings) in
 * 25 cards** put a bare HTML fragment, a blank line and a `<style>` in one
 * output — 9 cards, all of them variable-update panels. None of the 13 is a
 * sheet with no fragment beside it.
 */

/**
 * 爱衣's `[美化]完整变量更新` shape, desensitised.
 *
 * The structure, not the conversation: the wrapper, the `<details>` whose body
 * starts at `opacity: 0`, the blank line, and the sheet whose `[open]>div` rule
 * is the only thing that ever unhides it. `$2` becomes placeholder text.
 */
function variablePanel(): string {
  return [
    '<div style="width: 80%; margin: 20px auto;">',
    '  <details class="thinking-description" style="background: #2d2d2d;">',
    '    <summary>变量更新 - <span class="thinking-summary" data-close="点击查看" data-open="点击隐藏"></span></summary>',
    '    <div style="transform: translateY(-8px); opacity: 0;">',
    '    占位正文',
    '    </div>',
    '  </details>',
    '</div>',
    '',
    '<style>',
    '  .thinking-description[open]>div { transform: translateY(0) !important; opacity: 1 !important; }',
    '  .thinking-description[open] summary .thinking-summary::after { content: attr(data-open); }',
    '</style>',
  ].join(NL)
}

test('the panel and its sheet are one frame, and the sheet is what goes into it', () => {
  const source = ['她把袖口卷起来。', '', variablePanel(), '', '然后继续。'].join(NL)
  const { blocks, styles, css, refused } = claimMessageSurfaces(source)

  assert.deepEqual(refused, [], refused.join(','))
  assert.equal(blocks.length, 1, 'the sheet became a second frame again')
  assert.equal(blocks[0]?.kind, 'bare-html')
  assert.match(blocks[0]?.body ?? '', /<details class="thinking-description"/)
  assert.doesNotMatch(blocks[0]?.body ?? '', /<style/, 'the frame carries the sheet as markup')

  assert.equal(styles.length, 1, 'the sheet must come back with a span to splice')
  assert.equal(
    source.slice(styles[0]?.start ?? 0, styles[0]?.end ?? 0),
    ['<style>',
      '  .thinking-description[open]>div { transform: translateY(0) !important; opacity: 1 !important; }',
      '  .thinking-description[open] summary .thinking-summary::after { content: attr(data-open); }',
      '</style>'].join(NL),
    'the span does not name the whole element',
  )

  // Confined by `card-css.ts`, not pasted raw: the frame is one document and
  // the sheet is one message's, so the scope root is the body the markup went
  // into. The rule that unhides the panel has to survive that.
  assert.match(css, /@scope \(body\)/, 'the sheet reaches a frame unconfined')
  assert.match(css, /\.thinking-description\[open\]>div/)
  assert.match(css, /content: attr\(data-open\)/, 'the summary’s own text comes from this rule')
})

test('the sheet is neither a frame nor prose — the renderer never sees its text', () => {
  /*
   * The half that a region-list test cannot see. `MarkdownText` disables raw
   * HTML, so a `<style>` element handed to it is printed as **text**: dropping
   * the region without dropping the span would trade an empty 812px frame for a
   * screenful of escaped CSS in the middle of the message.
   */
  const source = ['她把袖口卷起来。', '', variablePanel(), '', '然后继续。'].join(NL)
  const { blocks, styles } = claimMessageSurfaces(source)
  const segments = splitAroundInterfaces(source, blocks, styles)

  const prose = segments.filter(segment => segment.kind === 'text').map(segment => segment.text).join('')
  assert.doesNotMatch(prose, /<style/, 'the stylesheet’s source reached the renderer')
  assert.doesNotMatch(prose, /thinking-description\[open\]/, 'its rules reached the renderer as text')
  assert.match(prose, /她把袖口卷起来。/, 'the narrative went with it')
  assert.match(prose, /然后继续。/)
  assert.equal(segments.filter(segment => segment.kind === 'interface').length, 1)
})

test('the row actually hands the style spans over, and takes neither shortcut', () => {
  /*
   * Written after the test above failed to notice a real mutation. Removing the
   * third argument at the row's call site left every assertion in this file
   * green: the split does drop spans it is given, and the row simply stopped
   * giving it any. Producer and consumer each tested, the hand-off between them
   * tested by nothing — so this reads the seam itself.
   *
   * Two shortcuts, and both are silent. Dropping the argument prints the
   * stylesheet as text in the middle of the message; leaving the early return
   * on `blocks.length === 0` alone does the same for a message whose only
   * markup *was* the sheet.
   */
  const source = readFileSync(
    fileURLToPath(new URL('../src/app/MessageInterfaces.tsx', import.meta.url)),
    'utf8',
  )
  const calls = [...source.matchAll(/splitAroundInterfaces\(([^)]*)\)/g)].map(hit => hit[1] ?? '')
  assert.equal(calls.length, 1, `splitAroundInterfaces call sites: ${String(calls.length)}`)
  assert.match(calls[0] ?? '', /\bstyles\b/, 'the row keeps the sheet’s characters in the prose')
  assert.match(
    source,
    /blocks\.length === 0 && styles\.length === 0/,
    'the no-block fast path would render a style-only message as source',
  )
})

test('a style span does not renumber the interfaces after it', () => {
  /*
   * The failure the merged walk is written to avoid: `instance` is the block's
   * index in `blocks`, and it is also the slot the row renders and the frame the
   * controller builds. A number assigned while walking a list that also holds
   * style spans would slip by one on any message with a sheet before a panel —
   * every later interface rendering into its neighbour's slot, with nothing
   * reporting anything.
   */
  const source = [
    '<style>.a{color:red}</style>',
    '',
    '<div>one</div>',
    '',
    '中间。',
    '',
    '<div>two</div>',
  ].join(NL)
  const { blocks, styles } = claimMessageSurfaces(source)
  const interfaces = splitAroundInterfaces(source, blocks, styles)
    .filter(segment => segment.kind === 'interface')

  assert.deepEqual(interfaces.map(segment => segment.instance), [0, 1])
  assert.deepEqual(
    interfaces.map(segment => segment.block.body),
    ['<div>one</div>', '<div>two</div>'],
    'an interface was built into a neighbour’s slot',
  )
})

test('a sheet with no HTML of its own is dropped, and the drop is reported', () => {
  /*
   * The one shape the fix cannot serve: there is no region frame to copy the
   * sheet into, so there is no equivalent of a message-wide scope. Silence here
   * would leave a card author looking for a panel whose CSS evaporated — the
   * corpus has cards that print their own explanation when a resource goes
   * missing, and an unexplained absence loses that race.
   */
  const source = ['开场。', '', '<style>.a{color:red}</style>', '', '结尾。'].join(NL)
  const { blocks, styles, css, refused } = claimMessageSurfaces(source)

  assert.deepEqual(blocks, [], 'a sheet must never be a frame')
  assert.equal(styles.length, 1, 'its characters still have to leave the prose')
  assert.equal(css, '', 'CSS with no destination must not be handed to one')
  assert.equal(refused.length, 1, refused.join(','))
  assert.match(refused[0] ?? '', /nothing to style/)

  const prose = splitAroundInterfaces(source, blocks, styles)
    .filter(segment => segment.kind === 'text').map(segment => segment.text).join('')
  assert.doesNotMatch(prose, /<style/, 'the dropped sheet was printed instead')
})

test('a fenced document keeps its own <style>, because upstream’s iframe keeps it too', () => {
  /*
   * A fenced block is not a message region: upstream renders it in an iframe of
   * its own, which its `.mes_text`-prefixed message sheet does not reach either.
   * So the `<style>` inside the fence is the card's document's, it stays exactly
   * where the author put it, and nothing about it becomes a message sheet.
   */
  const source = guiWrappedOpening()
  const { blocks, styles, css } = claimMessageSurfaces(source)

  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'fenced')
  assert.match(blocks[0]?.body ?? '', /<style>[\s\S]*#rvr-welcome/, 'the fence’s own sheet was taken out of it')
  assert.deepEqual(styles, [], 'a fenced sheet is not a message sheet')
  assert.equal(css, '')
})

test('the refusal list is the same list, and keyframe names are not', () => {
  /*
   * Two halves of "use `card-css.ts`, do not re-implement it".
   *
   * The refusals are unchanged: `@import` and `@font-face` fetch, and a frame's
   * sheet is no more allowed to than a message's.
   *
   * The keyframe **rename** is off for this path, and that is a measurement
   * rather than a preference: 5 of the 13 corpus sheets define keyframes their
   * message's markup names from a `style=` attribute (爱衣's `shimmer`,
   * 可攻略女主's `moon-halo` and `stars-twinkle`, …). The rewrite only reaches
   * `animation` declarations inside the sheet it renames, so renaming would
   * leave those attributes naming an animation nobody defines — a decoration
   * that stops with no error attached.
   */
  const source = [
    '<div style="animation: moon-halo 3s ease-in-out infinite;">panel</div>',
    '',
    '<style>',
    '@import url(https://fonts.example.test/x.css);',
    '@font-face { font-family: X; src: url(https://fonts.example.test/x.woff2) }',
    '@keyframes moon-halo { from { opacity: 0 } to { opacity: 1 } }',
    '.panel { animation: moon-halo 2s linear infinite }',
    '</style>',
  ].join(NL)
  const { css, refused } = claimMessageSurfaces(source)

  assert.ok(refused.includes('@import'), refused.join(','))
  assert.ok(refused.includes('@font-face'), refused.join(','))
  assert.doesNotMatch(css, /@import/)
  assert.doesNotMatch(css, /@font-face/)

  assert.match(css, /@keyframes moon-halo/, 'the markup’s style attribute names this animation')
  assert.doesNotMatch(css, /iris-cmsg-moon-halo/, 'a renamed keyframe strands the markup’s own reference')
  assert.match(css, /animation: moon-halo 2s linear infinite/, 'the sheet’s own reference must still match')
})

/*
 * The user floor. The claim has always been role-blind — these fixtures are the
 * shape that proved the *routing* was not: a console wrote its 建国档案 terminal
 * (a bare `<div style="width: 85%">` floor, 5.8 KiB, `<details
 * class="polsim-terminal">` with a nested variable panel) as a **user**
 * message, and the row showed the source. The data layer made the floor a user
 * row; the claim below is what the row would have rendered had the role not
 * gated the pipeline.
 */

test('a user floor carrying a bare console floor claims it whole', () => {
  const terminal = [
    '<div style="width: 85%; margin: 0 auto;">',
    '  <details class="polsim-terminal">',
    '    <summary>建国档案已提交</summary>',
    '    <div class="polsim-vars">👾变量更新</div>',
    '  </details>',
    '</div>',
  ].join(NL)
  const floor = ['（提交建国参数。）', '', terminal].join(NL)
  const { blocks, refused } = claimMessageSurfaces(floor)

  assert.deepEqual(refused, [])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'bare-html')
  assert.equal(blocks[0]?.body, terminal, 'the frame runs the terminal, not the floor around it')
  assert.equal(floor.slice(blocks[0]?.start ?? 0, blocks[0]?.end ?? 0), terminal)

  // And the splice: prose before, frame in place, nothing left over.
  const segments = splitAroundInterfaces(floor, blocks)
  assert.deepEqual(
    segments.map(segment => segment.kind),
    ['text', 'interface'],
    'the narration stays prose and the terminal takes its own place',
  )
})

test('a plain user floor claims nothing, so the row renders as it always has', () => {
  const floor = '（外交照会已递交。）\n\n等待对方回应——第二段也没有任何行首标签。'
  const { blocks, refused } = claimMessageSurfaces(floor)

  assert.deepEqual(blocks, [])
  assert.deepEqual(refused, [])
})

test('the row routes every role through the interface pipeline, and the role decides prose only', () => {
  /*
   * Read at the source because the routing is one conditional in a component,
   * and no headless harness renders JSX. Two contracts, both load-bearing:
   *
   * - the body slot calls `MessageInterfaces` for **every** row and hands the
   *   role along — a re-introduced `role === 'assistant'` gate there is the
   *   original bug (5.8 KiB of visible source on a user floor);
   * - inside `MessageInterfaces`, the role is consulted exactly once, for the
   *   prose between frames. A second consultation would mean the claim, the
   *   budget or the frame path had grown a role opinion, and the two roles had
   *   quietly become different pipelines.
   */
  const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '')

  const row = stripComments(
    readFileSync(fileURLToPath(new URL('../src/app/Message.tsx', import.meta.url)), 'utf8'),
  )
  const body = row.slice(row.indexOf('iris-msg__text'), row.indexOf('</div>', row.indexOf('iris-msg__text')))
  assert.ok(body.includes('<MessageInterfaces'), 'the body slot must route through the pipeline')
  assert.match(body, /role=\{message\.role\}/, 'the row must hand its role to the pipeline')
  assert.doesNotMatch(body, /role === 'assistant'/, 'no role gate may sit in the body slot again')

  const component = stripComments(
    readFileSync(fileURLToPath(new URL('../src/app/MessageInterfaces.tsx', import.meta.url)), 'utf8'),
  )
  const opinions = component.match(/role === 'assistant'/g) ?? []
  assert.equal(opinions.length, 1, 'the role decides the prose between frames, and nothing else')
  assert.match(component, /markdownProse \? <MarkdownText/, 'assistant prose reads as markdown')
})

