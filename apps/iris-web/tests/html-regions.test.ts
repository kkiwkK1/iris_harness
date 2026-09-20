/**
 * Splitting a message into markdown and HTML runs.
 *
 * @module iris-web/tests/html-regions
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { splitHtmlRegions } from '../src/app/html-regions.ts'

/** The kinds in order, which is the shape most of these tests are about. */
function shape(text: string): string[] {
  return splitHtmlRegions(text).regions.map(region => region.kind)
}

test('a message with no HTML is one markdown region', () => {
  assert.deepEqual(shape('雨从檐角坠下来。\n\n她收了伞。'), ['markdown'])
  // Not affected at all is the point: a message without a line-initial `<`
  // must come through byte-identical.
  const { regions } = splitHtmlRegions('雨从檐角坠下来。')
  assert.equal(regions[0]?.text, '雨从檐角坠下来。')
})

test('narrative before a block, then the block', () => {
  const text = '她把钳子插回围裙。\n\n<details>\n<summary>状态</summary>\n</details>'
  assert.deepEqual(shape(text), ['markdown', 'html'])

  const { regions } = splitHtmlRegions(text)
  assert.equal(regions[0]?.text.trim(), '她把钳子插回围裙。')
  assert.match(regions[1]?.text ?? '', /^<details>/)
  assert.match(regions[1]?.text ?? '', /<\/details>$/)
})

test('a blank line inside a region does not end it', () => {
  /*
   * The measured reason this rule is not "end at the next blank line": that
   * would damage **911 of 936** fragment floors (97.3%), including all 887 in
   * 命定之诗. Blank lines inside a card's block are normal.
   */
  const text = '<details>\n<summary>状态</summary>\n\n<div>好感度 32</div>\n\n</details>\n\n后来呢。'
  assert.deepEqual(shape(text), ['html', 'markdown'])

  const { regions } = splitHtmlRegions(text)
  assert.match(regions[0]?.text ?? '', /好感度 32/, 'the region spans the blank lines')
  assert.equal(regions[1]?.text.trim(), '后来呢。')
})

test('two regions stay two, with the markdown between them intact', () => {
  /*
   * The clause that cost the most in the first specification: **622 of 936
   * floors (66%) have more than one region**, so "split once" would merge them
   * and swallow the prose in between.
   */
  const text = '<div>一</div>\n\n中间这段是叙事。\n\n<div>二</div>'
  assert.deepEqual(shape(text), ['html', 'markdown', 'html'])

  const { regions } = splitHtmlRegions(text)
  assert.equal(regions[1]?.text.trim(), '中间这段是叙事。')
})

test('nesting of the same tag is paired by depth, not by the first closer', () => {
  const text = '<div>\n<div>inner</div>\n still outside? no\n</div>\n\nafter'
  assert.deepEqual(shape(text), ['html', 'markdown'])

  const { regions } = splitHtmlRegions(text)
  assert.match(regions[0]?.text ?? '', /still outside\? no/, 'the inner closer did not end it')
  assert.equal(regions[1]?.text.trim(), 'after')
})

test('a region written on one line closes on that line', () => {
  /*
   * The one place this implementation reads the specification differently, and
   * the reason is here. The clause says the region ends at the **line-initial**
   * closing tag whose depth returns to zero; `<details>…</details>` on a single
   * line never presents one, so under the strict reading it would be reported
   * unclosed and would swallow everything after it.
   *
   * Depth pairing is the mechanism the clause describes; "line-initial" is what
   * the common case looks like.
   */
  const text = '<details><summary>x</summary></details>\n\nafter'
  assert.deepEqual(shape(text), ['html', 'markdown'])

  const { refused } = splitHtmlRegions(text)
  assert.deepEqual(refused, [], 'a one-line region is not an unclosed one')
})

test('a preset card welded onto one line is one region, ended by its own close', () => {
  /*
   * **The 黑兽 事件记录 card, and the shape every 预设 beautifier emits.** The
   * replacement is one line carrying the sheet (`<style>` open *and* close),
   * the `<details>`, its `<summary>` and the first `<div>`s — followed by the
   * regex's multi-line `$1`/`$2` captures and the closers. A counter for the
   * tag that opened the region read that first line as net zero and claimed
   * exactly it: the summary pill rendered, and the card's body leaked as prose
   * and escaped tags. The stack keeps the region open until the panel's own
   * `</details>`.
   */
  const card = [
    '<style>.kz-w>summary{list-style:none}</style><details class="kz-w"><summary>⭐ 点击查看事件记录</summary>'
    + '<div class="kz-c"><div>★ 当前任务指引</div><div>$1</div></div><div>💾 存档 Log</div><div>$2</div></div></details>',
  ].join('\n')
  const text = `她的手心里有茧。\n\n${card.replace('$1', '当前主线任务: MQ.I\n当前支线事件: SQ.0').replace('$2', 'PG.2 时间推进。\n概括: 一句话。')}\n\n后记。`
  assert.deepEqual(shape(text), ['markdown', 'html', 'markdown'])

  const { regions, refused, styles } = splitHtmlRegions(text)
  assert.deepEqual(refused, [], 'the card is closed; nothing is unclosed')
  assert.deepEqual(styles, [], 'the sheet is the card’s own, not a message sheet')
  assert.match(regions[1]?.text ?? '', /^<style>/, 'the sheet travels with the panel')
  assert.match(regions[1]?.text ?? '', /<\/details>$/, 'the panel is claimed to its own close')
  assert.match(regions[1]?.text ?? '', /当前主线任务/, 'the captured body is inside the region')
  assert.equal(regions[2]?.text.trim(), '后记。', 'the narrative after the card is prose again')
})

test('an opening tag that spans lines still pairs with its closer', () => {
  /*
   * Cards write attribute brackets lines below the tag name. A scanner that
   * demanded the `>` on the same line would miss the open and end the region
   * one `</div>` early — the failure a naive tokenizer produced on the same
   * card, leaking each panel's last closing tag as markdown.
   */
  const text = [
    '<div style="',
    '  color: red',
    '">',
    '<details style="',
    '  margin: 0',
    '">',
    '<summary>s</summary>',
    '</details>',
    '</div>',
    '',
    'after',
  ].join('\n')
  assert.deepEqual(shape(text), ['html', 'markdown'])

  const { regions, refused } = splitHtmlRegions(text)
  assert.deepEqual(refused, [])
  assert.match(regions[0]?.text ?? '', /<\/div>$/, 'the outer close ends it, not an inner one')
  assert.equal(regions[1]?.text.trim(), 'after')
})

test('a closer written inside a style run does not end the region', () => {
  /*
   * A stylesheet's `content: "</div>"` is text, not markup. The depth counter
   * read it as a close; the stack, while `style` is open, looks for the
   * style's own closer and nothing else.
   */
  const text = '<div>\n<style>.a::after{content:"</div>"}</style>\nx\n</div>\n\nafter'
  assert.deepEqual(shape(text), ['html', 'markdown'])

  const { regions } = splitHtmlRegions(text)
  assert.match(regions[0]?.text ?? '', /x/, 'the line after the sheet is still inside')
  assert.equal(regions[1]?.text.trim(), 'after')
})

test('an outer closer closes through still-open inner tags', () => {
  /*
   * HTML's implied ends: a card that forgets an inner `</div>` must not turn
   * the region unclosed and swallow the message — the outer closer pops the
   * inner opens along with itself.
   */
  const text = '<div>\n<p>x\n</div>\n\nafter'
  assert.deepEqual(shape(text), ['html', 'markdown'])

  const { refused } = splitHtmlRegions(text)
  assert.deepEqual(refused, [], 'the implied end is not an unclosed region')
  assert.equal(shape(text)[1], 'markdown')
})

test('a one-line style plus widget is a region, not a sheet', () => {
  /*
   * A sheet is a run that is *nothing but* style elements. When the panel's
   * opener shares the style's line, the run has something outside the styles,
   * so it stays a region and the CSS rides with the panel's frame.
   */
  const text = '<style>.a{}</style><div>x</div>\n\nafter'
  const { regions, styles } = splitHtmlRegions(text)
  assert.deepEqual(shape(text), ['html', 'markdown'])
  assert.deepEqual(styles, [], 'the sheet belongs to the widget’s frame')
  assert.match(regions[0]?.text ?? '', /^<style>/)
})

test('a closing tag cannot open a region', () => {
  /*
   * **Every one of the 936 floors has a line-initial closing tag**, so a rule
   * that admitted `</…>` as an opener would claim every floor in the corpus.
   */
  assert.deepEqual(shape('</div>\n\n叙事'), ['markdown'])
})

test('an unclosed block takes the rest and says so', () => {
  const { regions, refused } = splitHtmlRegions('<div>\n<span>x</span>\n\n后面还有叙事')

  assert.deepEqual(regions.map(r => r.kind), ['html'])
  assert.match(regions[0]?.text ?? '', /后面还有叙事/, 'the fallback takes the rest')
  assert.equal(refused.length, 1, refused.join(','))
  assert.match(refused[0] ?? '', /<div>/, 'the note names the tag that did not close')
  assert.match(refused[0] ?? '', /never closed/)
})

test('a void tag opens a one-line region rather than an unclosed one', () => {
  /*
   * `<hr>` has no closing tag, so the depth rule can never bring it to zero.
   * Without the void list the fallback would swallow the rest of the message —
   * a wrong answer produced by a correct rule applied to a tag that cannot take
   * part in it.
   */
  const { regions, refused } = splitHtmlRegions('<hr>\n\n之后的叙事')

  assert.deepEqual(regions.map(r => r.kind), ['html', 'markdown'])
  assert.equal(regions[1]?.text.trim(), '之后的叙事')
  assert.deepEqual(refused, [])
})

test('an inline tag mid-line does not open a region', () => {
  // Only a line-initial block tag opens one. A `<span>` inside a sentence is
  // markdown's business, and claiming it would take prose away from the
  // renderer that handles prose.
  assert.deepEqual(shape('她说 <span>好</span> 然后走了。'), ['markdown'])
})

test('up to three leading spaces still opens a region, four does not', () => {
  // CommonMark's own boundary: four spaces is an indented code block.
  assert.deepEqual(shape('   <div>x</div>'), ['html'])
  assert.deepEqual(shape('    <div>x</div>'), ['markdown'])
})

test('whitespace between two regions is not emitted as prose', () => {
  // An empty markdown region would render as a blank paragraph between two
  // panels, which reads as a layout bug rather than as nothing.
  assert.deepEqual(shape('<div>一</div>\n\n\n<div>二</div>'), ['html', 'html'])
})

test('an empty message produces no regions', () => {
  assert.deepEqual(splitHtmlRegions(''), { regions: [], refused: [], styles: [], scripts: [] })
})

/**
 * 爱衣's `[美化]完整变量更新` shape, desensitised.
 *
 * The card's own structure — a wrapper div, a `<details class=
 * "thinking-description">` whose body starts at `opacity: 0`, a blank line, and
 * a `<style>` whose `[open]>div` rule is the only thing that unhides it — with
 * the regex's `$2` replaced by placeholder text and the decoration trimmed to
 * the rules that carry behaviour. Measured on the corpus: **13 of 220 candidate
 * texts across 9 cards have this shape**, and in every one of the 13 the gap
 * between the fragment and the sheet is exactly one blank line.
 */
function variablePanel(): string {
  return [
    '<div style="width: 80%; margin: 20px auto;">',
    '  <details class="thinking-description" style="background: #2d2d2d;">',
    '    <summary>变量更新 - <span class="thinking-summary" data-close="点击查看" data-open="点击隐藏"></span></summary>',
    '    <div style="transform: translateY(-8px); opacity: 0; white-space: pre-wrap;">',
    '    占位正文',
    '    </div>',
    '  </details>',
    '</div>',
    '',
    '<style>',
    '  .thinking-description[open]>div { transform: translateY(0) !important; opacity: 1 !important; }',
    '  .thinking-description[open] summary .thinking-summary::after { content: attr(data-open); }',
    '</style>',
  ].join('\n')
}

test('a style block is not a region — it comes back as the message’s own sheet', () => {
  /*
   * The fault this rule exists for, at the level where it is decided. The panel
   * and the sheet are separated by a blank line, so the split made two regions
   * and the pipeline two frames: one 88px collapsed `<details>`, and one frame
   * holding only CSS — measured at 812px of empty black, with the `[open]>div`
   * rule that unhides the panel's body sitting inside it, out of reach of the
   * `<details>` next door.
   */
  const { regions, styles, refused } = splitHtmlRegions(variablePanel())

  assert.deepEqual(regions.map(region => region.kind), ['html'], 'the sheet is still a region')
  assert.match(regions[0]?.text ?? '', /^<div style="width: 80%/, 'the panel is the region')
  assert.doesNotMatch(regions[0]?.text ?? '', /<style/, 'the sheet was folded into the panel')
  assert.equal(styles.length, 1, 'the message has one sheet')
  assert.match(styles[0]?.css ?? '', /\.thinking-description\[open\]>div/)
  assert.doesNotMatch(styles[0]?.css ?? '', /<style/, 'the tags come off; only CSS is handed on')
  assert.deepEqual(refused, [])
})

test('the sheet’s span carves its own characters out of the source, tags and all', () => {
  /*
   * The span is what lets the row take the same characters out of the prose. If
   * it named anything less than the whole element, the row would print the
   * leftovers — a lone `</style>` — as **text**, because the renderer disables
   * raw HTML.
   */
  const source = variablePanel()
  const { styles } = splitHtmlRegions(source)
  const span = styles[0]
  assert.ok(span !== undefined)
  const carved = source.slice(span.start, span.end)
  assert.match(carved, /^<style>/)
  assert.match(carved, /<[/]style>$/)
})

test('a style inside a panel belongs to the panel, not to the message', () => {
  /*
   * The distinction that keeps this from being a `includes('<style')` rule: a
   * card's widget routinely carries its own `<style>` **inside** it, and that
   * one is already in the right document — its own region's frame. Only a run
   * with nothing outside its style elements is a message-level sheet.
   */
  const text = ['<div class="widget">', '<style>.widget{color:red}</style>', '<span>x</span>', '</div>'].join('\n')
  const { regions, styles } = splitHtmlRegions(text)

  assert.deepEqual(regions.map(region => region.kind), ['html'])
  assert.match(regions[0]?.text ?? '', /<style>\.widget\{color:red\}<[/]style>/, 'the widget lost its own CSS')
  assert.deepEqual(styles, [], 'a panel’s own sheet must not be lifted to the message')
})

test('two sheets around a panel are both collected, in source order', () => {
  const text = [
    '<style>.a{color:red}</style>',
    '',
    '<div>panel</div>',
    '',
    '<style>.b{color:blue}</style>',
  ].join('\n')
  const { regions, styles } = splitHtmlRegions(text)

  assert.deepEqual(regions.map(region => region.kind), ['html'], 'only the panel is a region')
  assert.deepEqual(styles.map(style => style.css), ['.a{color:red}', '.b{color:blue}'])
})

test('an unclosed style block is CSS, and the reader is told so', () => {
  /*
   * The alternative was the unclosed-region fallback, which frames the rest of
   * the message as HTML — a frame whose entire content is a stylesheet's text.
   * What follows an opening `<style>` is declarations either way; what the
   * author needs is the note.
   */
  const { regions, styles, refused } = splitHtmlRegions('<style>\n.a{color:red}\n\n后面还有叙事')

  assert.deepEqual(regions, [], 'a stylesheet became a frame again')
  assert.equal(styles.length, 1)
  assert.match(styles[0]?.css ?? '', /后面还有叙事/, 'the tail is CSS, which is what an unclosed sheet means')
  assert.equal(refused.length, 1, refused.join(','))
  assert.match(refused[0] ?? '', /never closed/)
  assert.match(refused[0] ?? '', /<style>/, 'the note has to name what did not close')
})

test('a standalone script run is a span, not a frame and not prose', () => {
  /*
   * **The 黑兽 thinking card's own tail.** The preset prettifier ships its card
   * with a trailing `<script>` (the bubble animation), and the card's `<div>`
   * closers empty the stack one line before it — so the run claimed a frame of
   * its own: measured 417px of blank between the card and the narrative, on
   * every floor the card touched. Upstream never shows one either — DOMPurify
   * removes script elements — so the faithful rendering is the span carved
   * out, the way a style run is.
   */
  const text = '<div class="card">面板</div>\n\n<script>\n(function() { init() })()\n</script>\n\n骑士走在前面。'
  const { regions, scripts, refused } = splitHtmlRegions(text)

  assert.deepEqual(refused, [], 'a closed script is nothing to report')
  assert.equal(scripts.length, 1, 'the run comes back as a span')
  assert.equal(
    text.slice(scripts[0]?.start ?? 0, scripts[0]?.end ?? 0).startsWith('<script>'),
    true,
    'the span carves the script out of the source',
  )
  assert.deepEqual(regions.map(region => region.kind), ['html', 'markdown'])
  assert.equal(regions[1]?.text.trim(), '骑士走在前面。', 'the narrative follows the card with no code between')
})

test('a script inside a panel stays in the panel’s region and runs there', () => {
  /*
   * The span rule is for *orphaned* runs. A card that ships its script inside
   * its own markup wrote it for the frame that markup becomes — pulling it out
   * would strand the animation from the panel it drives.
   */
  const text = '<div class="card">\n<script>init()</script>\n面板\n</div>\n\n后面。'
  const { regions, scripts } = splitHtmlRegions(text)

  assert.deepEqual(scripts, [], 'nothing orphaned, nothing reported')
  assert.deepEqual(regions.map(region => region.kind), ['html', 'markdown'])
  assert.match(regions[0]?.text ?? '', /<script>/, 'the script travels with its panel')
})

test('an unclosed script block is dropped, and the reader is told so', () => {
  const { regions, scripts, refused } = splitHtmlRegions('<script>\ninit()\n\n后面还有叙事')

  assert.deepEqual(regions, [], 'an unclosed script became a frame')
  assert.equal(scripts.length, 1)
  assert.equal(refused.length, 1, refused.join(','))
  assert.match(refused[0] ?? '', /<script>/, 'the note names what did not close')
})

test('every region reports offsets that carve its exact text out of the source', () => {
  /*
   * The offsets are what lets the message-frame pipeline splice regions out of
   * a message the way it splices out fenced blocks, so the round trip
   * `text === source.slice(start, end)` is the contract — checked over shapes
   * with dropped whitespace, a void tag, and an unclosed tail.
   */
  const sources = [
    '雨从檐角坠下来。\n\n她收了伞。',
    '她把钳子插回围裙。\n\n<details>\n<summary>状态</summary>\n</details>\n\n后来呢。',
    '<div>一</div>\n\n\n<div>二</div>',
    '<hr>\n\n之后的叙事',
    '<div>\n<span>x</span>\n\n后面还有叙事',
    '\n\n开场之前有空行。\n\n<div class="w">\n\n    <span>很深的缩进</span>\n\n</div>\n\n结尾。\n\n',
  ]
  for (const source of sources) {
    const { regions } = splitHtmlRegions(source)
    assert.ok(regions.length > 0, `no regions at all for: ${JSON.stringify(source)}`)
    regions.forEach((region, at) => {
      assert.equal(
        region.text,
        source.slice(region.start, region.end),
        `region ${String(at)} of ${JSON.stringify(source)} does not round-trip`,
      )
      const previous = regions[at - 1]
      if (previous !== undefined) {
        assert.ok(previous.end <= region.start, 'regions overlap or run backwards')
      }
    })
  }
})

test('the unclosed fallback span reaches the end of the source', () => {
  const text = '开头。\n\n<div>\n<span>x</span>'
  const { regions } = splitHtmlRegions(text)
  const region = regions[regions.length - 1]
  assert.equal(region?.end, text.length)
  assert.equal(region?.text, text.slice(region.start, region.end))
})
