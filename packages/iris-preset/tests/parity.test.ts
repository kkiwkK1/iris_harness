/**
 * The parity comparator, against hand-written request pairs.
 *
 * The point of these tests is that the comparator *finds* things. A comparator
 * that runs cleanly on two different requests and reports nothing is worse than
 * no comparator at all — it would be read as "the two hosts agree", which is
 * exactly the conclusion the tool exists to earn. So every case here names a
 * divergence of a specific kind and asserts that it lands in the section a
 * reader would look for it in, and the last case asserts the negative: two
 * identical requests produce an empty report.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  alignBlocks,
  blocksOf,
  compareBodies,
  compareFields,
  firstDivergence,
  mergeSystemRuns,
  messagesOf,
  renderReport,
  type RequestBody,
} from '../src/parity.ts'

/** A body carrying the fields a real OpenAI-compatible request carries. */
function body(overrides: RequestBody = {}): RequestBody {
  return {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are {{char}}.' },
      { role: 'user', content: 'hello' },
    ],
    stream: true,
    temperature: 1,
    max_tokens: 65_535,
    ...overrides,
  }
}

test('a field one side omits is reported as one-sided, not as a difference in value', () => {
  const report = compareBodies(body(), body({ max_tokens: undefined }))
  // `undefined` survives as an own key here, so build the missing case honestly.
  const irisBody = body()
  delete irisBody['max_tokens']
  const honest = compareBodies(body(), irisBody)

  const row = honest.fields.find(entry => entry.key === 'max_tokens')
  assert.ok(row !== undefined, 'max_tokens must appear in the field table')
  assert.equal(row.verdict, 'st-only')
  assert.equal(row.st, '65535')
  // And the deliberately-wrong construction above is a different verdict, which
  // is what keeps this assertion from passing for the wrong reason.
  assert.equal(report.fields.find(entry => entry.key === 'max_tokens')?.verdict, 'differs')
})

test('a field only the host sends is reported as iris-only', () => {
  const irisBody = body({ reasoning_effort: 'low' })
  const row = compareFields(body(), irisBody).find(entry => entry.key === 'reasoning_effort')
  assert.equal(row?.verdict, 'iris-only')
  assert.equal(row?.iris, '"low"')
})

test('keys upstream sends only to its own backend are marked server-side, not as gaps', () => {
  const stBody = body({ chat_completion_source: 'custom', user_name: 'User', char_name: '爱衣' })
  const rows = compareFields(stBody, body())
  for (const key of ['chat_completion_source', 'user_name', 'char_name']) {
    assert.equal(rows.find(entry => entry.key === key)?.verdict, 'st-only (server-side)',
      `${key} must not be reported as a missing field`)
  }
  // A key that really is a provider field must still read as a plain gap, or
  // the allow-list above would be hiding real findings.
  const gap = compareFields(body({ logit_bias: { 1: 5 } }), body())
  assert.equal(gap.find(entry => entry.key === 'logit_bias')?.verdict, 'st-only')
})

test('framing counts the messages and roles of each side without normalising them away', () => {
  const stBody = body({
    messages: [
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'system', content: 'three' },
      { role: 'user', content: 'hello' },
    ],
  })
  const irisBody = body({
    messages: [
      { role: 'system', content: 'one\n\ntwo\n\nthree' },
      { role: 'user', content: 'hello' },
    ],
  })
  const report = compareBodies(stBody, irisBody)
  assert.equal(report.framing.stCount, 4)
  assert.equal(report.framing.irisCount, 2)
  assert.deepEqual(report.framing.stRoles, ['system', 'system', 'system', 'user'])

  // The framing difference is named, and then normalised away so it cannot hide
  // the content comparison: with the runs merged these two requests agree.
  assert.equal(report.divergence, undefined)
  assert.equal(report.blocks.onlyLeft.length, 0)
  assert.equal(report.blocks.onlyRight.length, 0)

  // Without the merge, the same pair diverges — which is what proves the
  // merge is doing the work and the agreement above is not vacuous.
  const asSent = compareBodies(stBody, irisBody, { mergeSystem: false })
  assert.notEqual(asSent.divergence, undefined)
})

test('a prompt the host never sends shows up as an ST-only block', () => {
  const stBody = body({
    messages: [
      { role: 'system', content: 'main prompt' },
      { role: 'system', content: '[CONTINUE MODE — PURE EXTENSION]' },
      { role: 'user', content: 'hello' },
    ],
  })
  const irisBody = body({
    messages: [
      { role: 'system', content: 'main prompt' },
      { role: 'user', content: 'hello' },
    ],
  })
  const report = compareBodies(stBody, irisBody)
  assert.equal(report.blocks.onlyLeft.length, 1)
  assert.equal(report.blocks.onlyLeft[0]?.block, '[CONTINUE MODE — PURE EXTENSION]')
  assert.equal(report.blocks.onlyRight.length, 0)
  // And it reaches the rendered report, which is what a user actually reads.
  assert.match(renderReport(report), /ST-only/)
})

test('a block both sides send in a different order is reported moved, not missing', () => {
  const alignment = alignBlocks(['a', 'b', 'c'], ['c', 'a', 'b'])
  assert.equal(alignment.onlyLeft.length, 0)
  assert.equal(alignment.onlyRight.length, 0)
  // One block moved, and it is `c` — the naive "everything that now sits after
  // something with a smaller index" reading names `a` and `b` instead, which is
  // the opposite of what happened.
  assert.equal(alignment.moved.length, 1)
  assert.equal(alignment.moved[0]?.block, 'c')
  assert.equal(alignment.moved[0]?.left, 2)
  assert.equal(alignment.moved[0]?.right, 0)
})

test('the post-history section arriving before the head is one move, named correctly', () => {
  // The realistic shape: Iris pulls the jailbreak block up into the system head
  // instead of leaving it behind the conversation.
  const alignment = alignBlocks(
    ['main', 'wi-before', 'persona', 'jailbreak'],
    ['jailbreak', 'main', 'wi-before', 'persona'],
  )
  assert.equal(alignment.moved.length, 1)
  assert.equal(alignment.moved[0]?.block, 'jailbreak')
})

test('inserting one block at the top is not counted as moving everything below it', () => {
  const alignment = alignBlocks(['a', 'b', 'c'], ['new', 'a', 'b', 'c'])
  assert.equal(alignment.onlyRight.length, 1)
  assert.equal(alignment.moved.length, 0, 'a uniform shift is not a reordering')
})

test('the first divergence is reported in bytes, not in characters', () => {
  // Four CJK characters, three bytes each, then a difference.
  const left = '爱衣的世界A'
  const right = '爱衣的世界B'
  const at = firstDivergence(left, right)
  assert.equal(at?.charOffset, 5)
  assert.equal(at?.byteOffset, 15)
  assert.equal(firstDivergence('same', 'same'), undefined)
})

test('a divergence that is only a role change is still a divergence', () => {
  const stBody = body({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'system', content: '[Continue your last message.]' },
    ],
  })
  const irisBody = body({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'user', content: '[Continue your last message.]' },
    ],
  })
  const report = compareBodies(stBody, irisBody)
  assert.notEqual(report.divergence, undefined, 'the same text under a different role must not read as parity')
})

test('a name field on one side only is counted, since names_behavior sets it', () => {
  const stBody = body({
    messages: [
      { role: 'system', content: 'main' },
      { role: 'assistant', content: 'hi', name: 'Aiyi' },
    ],
  })
  const report = compareBodies(stBody, body({
    messages: [
      { role: 'system', content: 'main' },
      { role: 'assistant', content: 'hi' },
    ],
  }))
  assert.equal(report.framing.stNamed, 1)
  assert.equal(report.framing.irisNamed, 0)
  assert.match(renderReport(report), /names_behavior/)
})

test('multimodal parts are counted rather than silently dropped', () => {
  const { messages, dropped } = messagesOf({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:…' } },
      ],
    }],
  })
  assert.equal(messages[0]?.text, 'look')
  assert.equal(dropped, 1)
})

test('two identical requests produce an empty report', () => {
  const report = compareBodies(body(), body())
  assert.equal(report.fields.every(row => row.verdict === 'same'), true)
  assert.equal(report.blocks.onlyLeft.length, 0)
  assert.equal(report.blocks.onlyRight.length, 0)
  assert.equal(report.blocks.moved.length, 0)
  assert.equal(report.divergence, undefined)
  const rendered = renderReport(report)
  assert.match(rendered, /every top-level field agrees/)
  assert.match(rendered, /byte-identical prompt text/)
})

test('blocksOf and mergeSystemRuns agree about the separator', () => {
  const merged = mergeSystemRuns([
    { role: 'system', text: 'one' },
    { role: 'system', text: 'two' },
    { role: 'user', text: 'hello' },
    { role: 'system', text: 'three' },
  ])
  assert.equal(merged.length, 3)
  assert.equal(merged[0]?.text, 'one\n\ntwo')
  // A system message after a user message is a different run and must not join
  // the first — that is upstream's post-history section, and merging it into
  // the head would move a post-history instruction in front of the chat.
  assert.equal(merged[2]?.text, 'three')
  assert.deepEqual(blocksOf('one\n\ntwo'), ['one', 'two'])
})
