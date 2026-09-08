import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TRIM_BLOCK_FLOORS, assemble, trimHistory } from '../src/index.ts'
import type { HistoryEntry } from '../src/types.ts'

/**
 * The trim's boundary has to hold still.
 *
 * Once a conversation is longer than its budget, *which* floor the model is
 * shown first becomes a per-turn decision — and against a provider that serves
 * a cached prompt only up to the first changed byte of the request prefix, a
 * first floor that moves every turn means the entire conversation is re-billed
 * every turn. Upstream drops exactly what does not fit
 * (`openai.js:1061-1065`) and recomputes from scratch on every generation
 * (`:1558`), so its boundary moves on every turn from the first overflow to the
 * end of the chat. Measured on the operator's own longest conversation with the
 * window narrowed until the trimmer engaged: the oldest sent floor moved on 4
 * of 6 adjacent rounds, and the conversation's own prefix ceiling sat at
 * 12–14%.
 *
 * These tests are about the thing that fixes it and the thing that could fake
 * it. **Every claim about the block is paired with the same measurement at
 * `block: 0`**, because a trimmer that never trims, or one whose budget was
 * accidentally generous, passes "the boundary held" perfectly while proving
 * nothing. The control is what makes the pass mean something.
 */

/** A conversation of `count` floors, each one predictable and equally costly. */
function conversation(count: number, options: { pinFirst?: boolean } = {}): HistoryEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    // Ten characters, so `count` below is a floor count in disguise and the
    // arithmetic in these tests is readable rather than incidental.
    text: `floor-${String(index).padStart(3, '0')}`,
    ...options.pinFirst === true && index === 0 ? { pinned: true } : {},
  }))
}

/** Each floor costs exactly one. */
const one = (): number => 1

/**
 * Walk a growing conversation and record which floor it started with.
 *
 * The whole question is in the returned list: one entry per turn, naming the
 * oldest floor that turn actually sent. A boundary that holds repeats itself.
 * @param from - floors at the first turn.
 * @param turns - how many turns to walk.
 * @param available - the budget, constant across the walk.
 * @param block - the quantum.
 * @returns the oldest sent floor's text per turn, and the dropped count per turn.
 */
function walk(
  from: number,
  turns: number,
  available: number,
  block: number,
): { first: string[], dropped: number[] } {
  const first: string[] = []
  const dropped: number[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    // Two floors per turn, which is what one exchange adds.
    const history = conversation(from + turn * 2)
    const trimmed = trimHistory(history, available, one, block)
    assert.ok(trimmed.kept.length > 0, 'the trim kept nothing at all, so this walk measures nothing')
    first.push((trimmed.kept[0] as HistoryEntry).text)
    dropped.push(trimmed.dropped)
  }
  return { first, dropped }
}

test('upstream\'s per-floor trim moves the oldest sent floor on every turn', () => {
  // The control, and the reason the next test means anything. `block: 0` is
  // upstream's rule transcribed: drop what does not fit, nothing more.
  const { first, dropped } = walk(30, 8, 20, 0)

  assert.equal(new Set(first).size, first.length,
    `upstream's trim should move the boundary on every one of ${String(first.length)} turns; `
    + `it produced ${String(new Set(first).size)} distinct first floors: ${first.join(', ')}`)
  // And it is really trimming, rather than the walk having stayed inside the
  // budget: a walk that never overflowed would report zero drops and the
  // assertion above would be vacuous.
  assert.ok(dropped.every(count => count > 0), `some turn dropped nothing: ${dropped.join(', ')}`)
})

test('a floor block holds the oldest sent floor still for about half a block of turns', () => {
  const block = 8
  const { first, dropped } = walk(30, 8, 20, block)

  // Two floors arrive per turn, so eight turns of growth cross the block twice
  // — three distinct boundaries at most, against eight without the block.
  assert.ok(new Set(first).size <= 3,
    `the boundary moved ${String(new Set(first).size)} times in 8 turns: ${first.join(', ')}`)
  // The run lengths are the claim, not the count of distinct values: a
  // boundary that jitters between two floors would satisfy the line above.
  let longestRun = 1
  let run = 1
  for (let index = 1; index < first.length; index += 1) {
    run = first[index] === first[index - 1] ? run + 1 : 1
    longestRun = Math.max(longestRun, run)
  }
  assert.ok(longestRun >= 4,
    `the longest stretch of turns sharing one first floor was ${String(longestRun)}; `
    + `a block of ${String(block)} floors should hold for about ${String(block / 2)}`)

  // Every cut is a whole block, which is what makes the count climb in steps
  // rather than by ones — the property the hold is derived from.
  for (const count of dropped) {
    assert.equal(count % block, 0, `dropped ${String(count)} floors, which is not a multiple of ${String(block)}`)
  }
})

test('the block never trims more than upstream would keep, and never empties the conversation', () => {
  // A budget that fits one floor. Rounding the drop up to a block would take
  // the whole conversation, so the guard hands back what upstream would have
  // kept instead.
  const history = conversation(12)
  const tight = trimHistory(history, 1, one, 8)
  assert.equal(tight.kept.length, 1)
  assert.equal((tight.kept[0] as HistoryEntry).text, 'floor-011')

  // A budget that fits nothing keeps nothing, exactly as upstream's loop does
  // on its first iteration — the block must not invent a floor to keep.
  assert.deepEqual(trimHistory(history, 0, one, 8), trimHistory(history, 0, one, 0))

  // And a conversation that fits is never cut: the block is the price of a
  // trim, not a standing tax.
  const roomy = trimHistory(history, 100, one, 8)
  assert.equal(roomy.dropped, 0)
  assert.equal(roomy.kept.length, history.length)
})

test('a pinned floor survives the block and is not counted as one of its drops', () => {
  const history = conversation(30, { pinFirst: true })
  const trimmed = trimHistory(history, 20, one, 8)

  assert.equal((trimmed.kept[0] as HistoryEntry).text, 'floor-000', 'the pinned opening floor was trimmed')
  assert.equal(trimmed.kept[0]?.pinned, true)
  // `dropped` counts trimmable floors, so it stays comparable with the
  // unpinned case and with `overflow.droppedHistory`, which the
  // `{{firstIncludedMessageId}}` macro reads.
  assert.equal(trimmed.dropped % 8, 0)
  // The kept run after the pin is contiguous and ends at the newest floor.
  const tail = trimmed.kept.slice(1)
  assert.equal((tail.at(-1) as HistoryEntry).text, 'floor-029')
  for (let index = 1; index < tail.length; index += 1) {
    const previous = Number((tail[index - 1] as HistoryEntry).text.slice(-3))
    assert.equal(Number((tail[index] as HistoryEntry).text.slice(-3)), previous + 1,
      'the block left a hole in the middle of the conversation')
  }
})

test('assemble carries the block by default and lets a budget turn it off', () => {
  const contributions = [
    { id: 'main', placement: { kind: 'system' as const, order: 10 }, text: 'You are Aria.' },
  ]
  const history = conversation(40)
  // 31 of window, 1 held back for the reply, 1 spent on the system prompt
  // leaves 29 for 40 floors of 1 — so upstream's trim drops 11, which is
  // deliberately **not** a multiple of the block. A budget whose exact drop
  // happened to land on a multiple would make the two branches agree and the
  // comparison below would pass whether or not `assemble` passed the block on.
  const budget = { context: 31, reserve: 1, count: one }

  const withBlock = assemble({ contributions, history, budget })
  const withoutBlock = assemble({ contributions, history, budget: { ...budget, trimBlockFloors: 0 } })

  assert.equal(withoutBlock.overflow.droppedHistory, 11,
    'the fixture no longer drops 11 floors, so it no longer discriminates between the two branches')
  assert.equal(withBlock.overflow.droppedHistory % DEFAULT_TRIM_BLOCK_FLOORS, 0)
  assert.ok(withBlock.overflow.droppedHistory > withoutBlock.overflow.droppedHistory,
    'the default block dropped no more than the exact trim, so `assemble` is not passing it through')
  // The default is the pipeline's own constant and nothing else's: a caller
  // that says nothing gets the block, which is what makes the product default
  // reachable without a composition row.
  assert.equal(
    assemble({ contributions, history, budget: { ...budget, trimBlockFloors: DEFAULT_TRIM_BLOCK_FLOORS } })
      .overflow.droppedHistory,
    withBlock.overflow.droppedHistory,
  )
})
