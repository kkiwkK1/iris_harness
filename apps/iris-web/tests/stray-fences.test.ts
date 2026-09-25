/**
 * The fence that never closes, and the repair that stops it swallowing a reply.
 *
 * The disease is real-floor shaped: 政经博弈卡 新·架空政治经济模拟器 thinks
 * inside `<think_fox~>` and pads the thinking with a lone ` ``` ` — line 10 of
 * a 320-line floor, never closed. CommonMark runs an unclosed fence to the end
 * of the document, so the renderer received the remaining 310 lines as one code
 * block and every heading, bold run, list and rule below it displayed as
 * source. These tests hold the repair's grammar (the claim pipeline's own
 * fence predicates), its byte-preservation for healthy text, and the parse
 * outcome on both sides of the fix — the same mdast pipeline `MarkdownText`
 * runs, so "renders as markdown" is pinned where it is true, not in a mock.
 *
 * @module iris-web/tests/stray-fences
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'

import { claimMessageSurfaces } from '../src/sandbox/frontend-blocks.ts'
import { repairStrayFences } from '../src/app/stray-fences.ts'

const NL = String.fromCharCode(10)

/** Parse with the same extensions the settled renderer arm uses. */
function parse(text: string): { types: string[], codeLines: number[] } {
  const tree = fromMarkdown(text, { mdastExtensions: [gfmFromMarkdown()] })
  return {
    types: tree.children.map(node => node.type),
    codeLines: tree.children
      .filter((node): node is Extract<typeof node, { type: 'code' }> => node.type === 'code')
      .map(node => node.value.split(NL).length),
  }
}

/**
 * The floor's shape, at fixture size: a card's thinking wrapper, a lone fence
 * inside it, and the markdown reply below — the exact skeleton that failed.
 */
function floorWithStrayFence(): string {
  return [
    '<think_fox~>',
    '【开始思考】',
    '初始化协议，叙事视角为宏观白描。',
    '```',
    '</think_fox~>',
    '<content>',
    '',
    '# 维拉诺维亚联邦共和国 · 初始化报告',
    '',
    '**国家全称**：维拉诺维亚联邦共和国',
    '',
    '---',
    '',
    '## 历史锚点',
    '',
    '- **总统**：现任总统以 **53.2%** 连任。',
    '- **联邦议院**：自由党联盟获 **178 席**。',
    '',
    '<fox_selc>',
    '🫅<font color="#FF6B9D">走向那个穿大衣的男人。</font>',
    '</fox_selc>',
  ].join(NL)
}

test('the disease is the fence, not the renderer: the floor parses to one giant code block', () => {
  // Pin the fault at the parse layer first: the markdown below the stray fence
  // never reached the renderer as markdown at all. Any fix that leaves this
  // parse shaped like this is not a fix.
  const parsed = parse(floorWithStrayFence())
  assert.deepEqual(parsed.types, ['paragraph', 'code'])
  assert.equal(parsed.codeLines[0], 17, 'every line below the stray fence, one code block')
})

test('a stray fence stops being a fence, and the markdown below renders as markdown', () => {
  const repaired = repairStrayFences(floorWithStrayFence())

  // The opener is now literal text — every fence character escaped, so not
  // even a code-span delimiter survives the line.
  assert.match(repaired, /\\`\\`\\`/)
  assert.doesNotMatch(repaired, /^```/m)

  // The reply's own markup passes through untouched.
  assert.match(repaired, /^# 维拉诺维亚联邦共和国 · 初始化报告$/m)
  assert.match(repaired, /^\*\*国家全称\*\*：维拉诺维亚联邦共和国$/m)
  assert.match(repaired, /^## 历史锚点$/m)
  assert.match(repaired, /^- \*\*总统\*\*：现任总统以 \*\*53\.2%\*\* 连任。$/m)
  assert.match(repaired, /^---$/m)

  // And the parse agrees: no code block anywhere, headings are headings. The
  // think wrapper's six lines are one paragraph (a stray fence's literal line
  // included), then the reply's own blocks follow.
  const parsed = parse(repaired)
  assert.deepEqual(parsed.types, ['paragraph', 'heading', 'paragraph', 'thematicBreak', 'heading', 'list', 'paragraph'])
  assert.deepEqual(parsed.codeLines, [], 'nothing renders as a code block')
})

test('a healthy message keeps its bytes: closed fences are untouched', () => {
  const text = [
    '开端一段话。',
    '',
    fenced('js', 'const at = 1'),
    '',
    '结尾一段话。',
  ].join(NL)
  assert.equal(repairStrayFences(text), text)
})

/** A fenced block, the way messages carry one. */
function fenced(info: string, body: string): string {
  return ['```' + info, body, '```'].join(NL)
}

test('a stray-looking fence inside a real block is code, and stays code', () => {
  // The interior of a closed block is whatever the author wrote in it — a
  // bare ``` there is a line of code, never a candidate for repair.
  const text = [
    '引子。',
    '',
    fenced('text', ['look: ```', '<body> inside', 'still inside'].join(NL)),
    '',
    '## 之后是markdown',
  ].join(NL)
  assert.equal(repairStrayFences(text), text)
})

test('a tilde stray is repaired like a backtick stray', () => {
  const text = ['前言。', '', '~~~', '## 正文', '', '**加粗**、- 列表照旧。'].join(NL)
  const repaired = repairStrayFences(text)
  assert.match(repaired, /\\~\\~\\~/)
  assert.match(repaired, /^## 正文$/m)
  assert.deepEqual(parse(repaired).codeLines, [])
})

test('a stray opener with an info string keeps the label as literal text', () => {
  const text = ['思考。', '', '```html', '<div>回忆</div>', '', '## 正文'].join(NL)
  const repaired = repairStrayFences(text)
  assert.match(repaired, /\\`\\`\\`html/, 'the info string survives, escaped along with the fence')
  assert.doesNotMatch(repaired, /^```html/m)
  assert.deepEqual(parse(repaired).codeLines, [])
})

test('two strays in one message are both repaired', () => {
  const text = ['一。', '', '```', '二。', '', '~~~', '## 三'].join(NL)
  const repaired = repairStrayFences(text)
  assert.match(repaired, /\\`\\`\\`/)
  assert.match(repaired, /\\~\\~\\~/)
  assert.deepEqual(parse(repaired).codeLines, [])
})

test('a closed pair after a stray stays a real code block', () => {
  /*
   * The repair takes only a never-closing opener. A complete block further down
   * is code on purpose and must keep rendering as code — and it takes a
   * *different* fence character to exist below a stray at all: a same-character
   * closer would pair with the stray opener and make the whole span one real
   * block, which is CommonMark's answer and not this test's business.
   */
  const text = [
    '一。',
    '',
    '```',
    '## 之后才写正文的模型',
    '',
    '~~~js',
    'const at = 1',
    '~~~',
    '',
    '## 结尾',
  ].join(NL)
  const repaired = repairStrayFences(text)
  assert.match(repaired, /\\`\\`\\`/, 'the stray opener is literal')
  assert.match(repaired, /^~~~$/m, 'the later block keeps its own fences')
  const parsed = parse(repaired)
  assert.deepEqual(parsed.codeLines, [1], 'the complete block below survives as code')
  assert.ok(parsed.types.includes('heading'), 'and the markdown after it is markdown')
})

test('the repair can unhide a claimable bare region, so budget and row must repair alike', () => {
  // Before the repair, the unclosed fence swallowed the widget: the split
  // never reached it, and no one claimed it. After, the region is real —
  // which is why the budget's floors go through the same repair as the row
  // (see ChatPane), or the two would derive different claim lists from one
  // text.
  const text = ['思考。', '', '```', '</think>', '', '<div>', '状态', '</div>'].join(NL)
  assert.deepEqual(claimMessageSurfaces(text).blocks, [], 'before: the fence hides the region')

  const repaired = repairStrayFences(text)
  const { blocks } = claimMessageSurfaces(repaired)
  assert.equal(blocks.length, 1, 'after: the region is claimable')
  assert.equal(blocks[0]?.kind, 'bare-html')
  assert.match(blocks[0]?.body ?? '', /^<div>/)
})

test('the streaming gate holds where the text enters, and every consumer repairs the same text', () => {
  /*
   * While a reply arrives, an unclosed fence is a code block in flight and the
   * render must stay code-to-end-of-stream. The gate lives at the two seams
   * that hold `streaming`; asserted at the source, in the style of the
   * combined-claim test, because the agreement only shows across files.
   */
  const row = readFileSync(fileURLToPath(new URL('../src/app/MessageInterfaces.tsx', import.meta.url)), 'utf8')
  // Memoized on the text since `streaming-render-path`; the gate is the same.
  assert.match(row, /const display = useMemo\(\(\) => \(streaming \? text : repairStrayFences\(text\)\), \[streaming, text\]\)/, 'the row repairs only settled text')
  /*
   * Once settled, the claim, the controller and the splice all read `display`
   * — the whole repaired message. While the reply streams the controller is
   * handed nothing at all (`streaming-render-path`): it used to re-claim the
   * growing text per delta and build a frame for any partial block that closed,
   * while the row showed that same text as prose.
   *
   * These lines used to pin `bodyText`, the body tag's prose, and that is the
   * defect `notes/apps/iris-web/DEVIATIONS.md` §110 records: a card's panels
   * sit *outside* the wrapper whenever the model obeys the preset, so claiming
   * over the body meant 12 of 14 corpus cards built no frame at all. The
   * restatement is stricter rather than looser — the agreement pinned is still
   * "one text for all three", and it now also pins *which* text, the one the
   * claims' offsets were measured in. The wrapper reaches the splice as a
   * range, which is the shape that cannot decide membership.
   */
  assert.match(row, /claimMessageSurfaces\(display\)/, 'the row claims over the whole repaired message, not over the body tag’s prose')
  assert.match(row, /text: streaming \? '' : display,/, 'the controller claims the settled string the row splices, and nothing while it streams')
  assert.match(
    row,
    /const segments = layOutMessageBody\(display, bodyTag, blocks, styles, scripts\)/,
    'the splice reads that same string — and the wrapper reaches it as a name the layout resolves to a range, never as a substring',
  )
  /*
   * The fallback splits by role: an assistant row reads the repaired body as
   * markdown, every other row keeps the raw body it has always shown. Assert
   * the branch rather than one arm of it — an earlier version of this line
   * pinned the markdown arm as `text={text}`, which stopped describing the
   * code the moment the unknown-markup rule joined it and would have gone red
   * on a correct change. Both arms read `bodyText` — the split's
   * `body ?? display` — because a body tag changes what "the raw text" means
   * for every role: the scaffolding outside the tag belongs to no reader. The
   * expression is bound to a name now, because the fold renders beside it on
   * that path; the rendering pinned is the same rendering.
   */
  assert.ok(
    row.includes(
      'markdownProse ? <MarkdownText text={unwrapUnknownTagsOutsideCode(bodyText)} streaming={streaming} /> : <>{bodyText}</>',
    ),
    'the fallback splits the repaired-vs-raw rendering by role',
  )
  // And an untagged message leaves that path as the bare prose it always was —
  // the compatibility zero, pinned where the fold was added beside it.
  assert.match(row, /if \(!leak\.tagged\) return prose/, 'an untagged message renders the fallback with nothing around it')

  const pane = readFileSync(fileURLToPath(new URL('../src/app/ChatPane.tsx', import.meta.url)), 'utf8')
  /*
   * The budget plans from the settled view (so a delta does not re-plan), and
   * over the same repaired text the row renders; the streaming turn's reply,
   * which builds no frame, plans as nothing.
   */
  assert.match(pane, /readingWindow\(view\?\.messages \?\? \[\], shown, message => message\.turn\)/, 'the budget reads the settled view, not the stream')
  assert.match(pane, /\? ''\s+: repairStrayFences\(message\.text\)/, 'the budget repairs the same settled text the row renders')
})
