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
  assert.deepEqual(splitHtmlRegions(''), { regions: [], refused: [] })
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
