import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assemble, injectAtDepth, renderSystem } from '../src/index.ts'
import type { Contribution, HistoryEntry } from '../src/index.ts'

/**
 * The cache-friendly reorder: what moves, what does not, and what may not change.
 *
 * The mechanism is one sentence — a volatile contribution goes into a segment
 * after the whole conversation — and every assertion here is about a way that
 * sentence could be implemented wrongly while still looking right. The two that
 * would be invisible without a test:
 *
 * - **Off must be byte-identical**, not merely equivalent. The setting exists so
 *   an operator can get SillyTavern's order back, and "almost the same order"
 *   is worth nothing to a prefix cache.
 * - **The budget charge must not change.** The moved sections leave the system
 *   string, so if nothing charges them the trim is handed a budget that looks
 *   roomier by exactly the size of what moved — and the conversation grows into
 *   space that is already spent. That failure shows up turns later as history
 *   dropped for no visible reason.
 */

/** One token per word, so budget arithmetic in these tests is legible. */
const countWords = (text: string): number => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length)

/** A budget large enough that nothing is trimmed. */
const roomy = { context: 10_000, reserve: 0, count: countWords }

/** Conversation of `n` single-token turns, alternating roles. */
function conversation(n: number): HistoryEntry[] {
  return Array.from({ length: n }, (_unused, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `m${index}`,
  }))
}

/**
 * A preset-shaped set of system sections with one volatile section in the
 * middle, plus a depth-0 and a depth-2 injection.
 *
 * The volatile one sits **between** two stable ones on purpose: a reorder that
 * merely appended everything from the volatile one onward would pass a test
 * whose volatile section was last.
 */
function contributions(): Contribution[] {
  return [
    { id: 'main', placement: { kind: 'system', order: 10 }, text: 'MAIN' },
    { id: 'roll', placement: { kind: 'system', order: 20 }, text: 'ROLL 17', volatile: true },
    { id: 'card', placement: { kind: 'system', order: 30 }, text: 'CARD' },
    { id: 'depth0', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'D0' },
    { id: 'depth2', placement: { kind: 'depth', depth: 2, role: 'system' }, text: 'D2' },
  ]
}

const texts = (messages: readonly { text: string }[]): string[] => messages.map(message => message.text)

test('a volatile system section leaves the system prompt and lands after the conversation', () => {
  const on = assemble({ contributions: contributions(), history: conversation(3), budget: roomy, cacheFriendly: true })

  // Out of the prefix...
  assert.equal(on.system, 'MAIN\n\nCARD')
  // ...and into the conversation, after every floor and *before* depth 0, which
  // keeps depth 0's promise that it is the last thing the model reads.
  assert.deepEqual(texts(on.messages), ['m0', 'D2', 'm1', 'm2', 'ROLL 17', 'D0'])
  // Nothing is dropped: the same text is in the request, in a different place.
  assert.ok(on.messages.some(message => message.text === 'ROLL 17'))
})

test('turning it off is byte-identical to never having had it', () => {
  const off = assemble({ contributions: contributions(), history: conversation(3), budget: roomy, cacheFriendly: false })
  const absent = assemble({ contributions: contributions(), history: conversation(3), budget: roomy })

  assert.equal(off.system, 'MAIN\n\nROLL 17\n\nCARD')
  assert.deepEqual(texts(off.messages), ['m0', 'D2', 'm1', 'm2', 'D0'])
  // The two spellings of "off" must not differ from each other either: a
  // caller that passes `false` and one that passes nothing are the same caller.
  assert.equal(JSON.stringify(off), JSON.stringify(absent))
  // And no message carries the flag, so a squash pass downstream sees the
  // conversation it always saw.
  assert.equal(off.messages.some(message => message.volatile === true), false)
})

test('relative order inside the moved segment survives', () => {
  const many: Contribution[] = [
    { id: 'a', placement: { kind: 'system', order: 40 }, text: 'LAST', volatile: true },
    { id: 'b', placement: { kind: 'system', order: 10 }, text: 'FIRST', volatile: true },
    { id: 'c', placement: { kind: 'system', order: 25 }, text: 'MIDDLE', volatile: true },
    { id: 'stable', placement: { kind: 'system', order: 1 }, text: 'STABLE' },
  ]
  const on = assemble({ contributions: many, history: conversation(1), budget: roomy, cacheFriendly: true })

  assert.equal(on.system, 'STABLE')
  // Ascending `order`, exactly as the system prompt would have joined them —
  // the reorder translates the group past the conversation, it does not
  // reshuffle inside it.
  assert.deepEqual(texts(on.messages), ['m0', 'FIRST', 'MIDDLE', 'LAST'])
})

test('a volatile depth-0 injection stays where it is; depth 1 and deeper are lifted', () => {
  const depths: Contribution[] = [
    // A **stable** depth-0 item beside the volatile one, and it has to be here:
    // a lifted depth-0 item would land in the volatile segment, which is
    // emitted just before the depth-0 slot — so with only one depth-0 item the
    // final order is identical either way and the assertion has no teeth
    // (checked: breaking the rule left this test green until this line existed).
    // With two, the order tells them apart, because the segment goes first and
    // the slot sorts by `order`.
    { id: 'd0stable', placement: { kind: 'depth', depth: 0, role: 'system', order: 0 }, text: 'D0S' },
    { id: 'd0', placement: { kind: 'depth', depth: 0, role: 'system', order: 5 }, text: 'D0', volatile: true },
    { id: 'd1', placement: { kind: 'depth', depth: 1, role: 'system' }, text: 'D1', volatile: true },
    { id: 'd3', placement: { kind: 'depth', depth: 3, role: 'user' }, text: 'D3', volatile: true },
    { id: 'd2stable', placement: { kind: 'depth', depth: 2, role: 'system' }, text: 'D2', volatile: false },
  ]
  const on = assemble({ contributions: depths, history: conversation(4), budget: roomy, cacheFriendly: true })

  // Depth 0 is already the last thing before the reply — there is nowhere later
  // to put it, so moving it would change `order` semantics for nothing.
  // Depth 1 and 3 sat *inside* the conversation, in the run two turns would
  // otherwise agree on, so they move; deepest first, which is the order the
  // model read them in.
  assert.deepEqual(texts(on.messages), ['m0', 'm1', 'D2', 'm2', 'm3', 'D3', 'D1', 'D0S', 'D0'])
  // A lifted injection keeps its own role rather than being flattened to system.
  const lifted = on.messages.find(message => message.text === 'D3')
  assert.equal(lifted?.role, 'user')
  // The stable depth-2 injection is untouched, in its own slot: two floors from
  // the end of a four-floor conversation, which is index 2.
  assert.equal(on.messages.findIndex(message => message.text === 'D2'), 2)
})

test('the moved sections are still charged, so the trim decides the same way', () => {
  // Room for the fixed cost plus exactly two of the four floors.
  const tight = { context: 8, reserve: 0, count: countWords }
  const off = assemble({ contributions: contributions(), history: conversation(4), budget: tight })
  const on = assemble({ contributions: contributions(), history: conversation(4), budget: tight, cacheFriendly: true })

  // The reorder changes where text sits, never how much of it there is. If the
  // moved sections went uncharged, `on` would keep more history than `off`.
  assert.equal(on.overflow.droppedHistory, off.overflow.droppedHistory)
  assert.ok(off.overflow.droppedHistory > 0,
    'this fixture must actually trim, or it cannot tell the two charges apart')
  assert.equal(on.tokens, off.tokens)
})

test('the stable prefix stops at the first volatile part, wherever it sits', () => {
  // Flag off: the volatile section is still in the middle of the system prompt,
  // so the reusable run ends before it — after `MAIN` alone.
  const off = assemble({ contributions: contributions(), history: conversation(3), budget: roomy })
  assert.equal(off.stablePrefixTokens, countWords('MAIN'))

  // Flag on: the volatile section is behind the whole conversation, so the run
  // reaches the end of the history.
  const on = assemble({ contributions: contributions(), history: conversation(3), budget: roomy, cacheFriendly: true })
  assert.equal(on.stablePrefixTokens, countWords('MAIN\n\nCARD') + countWords('m0 D2 m1 m2'))
  assert.ok(on.stablePrefixTokens > off.stablePrefixTokens,
    'the whole point of the reorder is that this number goes up')
})

test('an unclassified assembly reports its whole request as stable prefix', () => {
  // No contribution marked volatile: the reading must not invent a boundary,
  // because "nobody classified this" and "everything changes" are different
  // facts and the second one would read as a defect.
  const plain: Contribution[] = [
    { id: 'a', placement: { kind: 'system', order: 10 }, text: 'A' },
    { id: 'b', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'B' },
  ]
  const result = assemble({ contributions: plain, history: conversation(2), budget: roomy, cacheFriendly: true })
  assert.equal(result.stablePrefixTokens, result.tokens)
})

test('the itemization says which rows moved, and keeps them in contribution order', () => {
  const on = assemble({ contributions: contributions(), history: conversation(3), budget: roomy, cacheFriendly: true })

  // Contribution order, not assembly order: this list is "where the preset and
  // the card put things", which is where a reader will look to change it. The
  // flag is what tells a surface to draw it elsewhere.
  assert.deepEqual(on.items.map(item => item.id),
    ['main', 'roll', 'card', 'depth0', 'depth2', 'chatHistory'])
  assert.deepEqual(on.items.filter(item => item.deferred === true).map(item => item.id), ['roll'])
  // Off, no row claims to have moved.
  const off = assemble({ contributions: contributions(), history: conversation(3), budget: roomy })
  assert.equal(off.items.some(item => item.deferred === true), false)
})

test('a volatile section that rendered empty moves nothing and breaks nothing', () => {
  const withEmpty: Contribution[] = [
    { id: 'a', placement: { kind: 'system', order: 10 }, text: 'A' },
    { id: 'blank', placement: { kind: 'system', order: 20 }, text: '   ', volatile: true },
    { id: 'b', placement: { kind: 'system', order: 30 }, text: 'B' },
  ]
  const on = assemble({ contributions: withEmpty, history: conversation(1), budget: roomy, cacheFriendly: true })

  assert.equal(on.system, 'A\n\nB')
  // No empty message in the conversation, and — the part that matters — the
  // empty section is not a boundary: it contributes no bytes, so the reusable
  // run must run straight past it.
  assert.deepEqual(texts(on.messages), ['m0'])
  assert.equal(on.stablePrefixTokens, on.tokens)
  // The row still says it was classified, because that is the fact a reader is
  // checking when they ask why a section is not where they put it.
  assert.equal(on.items.find(item => item.id === 'blank')?.deferred, true)
})

/** Depth injections at three depths, all observed unchanged. */
function settled(): Contribution[] {
  return [
    { id: 'sys', placement: { kind: 'system', order: 10 }, text: 'SYS', settled: true },
    { id: 'd0', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'D0', settled: true },
    { id: 'd1', placement: { kind: 'depth', depth: 1, role: 'user' }, text: 'D1', settled: true },
    { id: 'd3', placement: { kind: 'depth', depth: 3, role: 'system' }, text: 'D3', settled: true },
    { id: 'unknown', placement: { kind: 'depth', depth: 2, role: 'system' }, text: 'D2' },
  ]
}

test('settled depth injections are pulled in front of the conversation', () => {
  const on = assemble({ contributions: settled(), history: conversation(4), budget: roomy, cacheFriendly: true })

  // In front of every floor, so they land inside the run two turns agree on and
  // stop being re-sent. Deepest first, which is the order the model read them.
  assert.deepEqual(texts(on.messages), ['D3', 'D1', 'D0', 'm0', 'm1', 'D2', 'm2', 'm3'])
  // A system section is already in the prefix; `settled` must not move it, or
  // the flag would reshuffle the system prompt for no gain at all.
  assert.equal(on.system, 'SYS')
  // An unclassified depth injection stays exactly where it was. "Not known to
  // change" is not "known not to change", and only the second justifies a move.
  assert.equal(on.messages.findIndex(message => message.text === 'D2'), 5)
  // A promoted injection keeps its own role.
  assert.equal(on.messages.find(message => message.text === 'D1')?.role, 'user')
})

test('volatile beats settled, so the two directions never claim the same part', () => {
  const both: Contribution[] = [
    { id: 'a', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'A', settled: true, volatile: true },
  ]
  const on = assemble({ contributions: both, history: conversation(2), budget: roomy, cacheFriendly: true })

  // Volatility is the newer evidence. Promoting a part that turns out to change
  // is the one outcome that is *worse* than doing nothing: measured on the
  // corpus, four conversations went from 7.6%–55.2% to 0.0%–19.5% that way.
  // Depth 0 also does not defer, so it simply stays put — and it must appear
  // exactly once either way.
  assert.deepEqual(texts(on.messages), ['m0', 'm1', 'A'])
  assert.equal(on.items.find(item => item.id === 'a')?.promoted, undefined)
})

test('promotion is charged and reported like every other placement', () => {
  const tight = { context: 6, reserve: 0, count: countWords }
  const off = assemble({ contributions: settled(), history: conversation(4), budget: tight })
  const on = assemble({ contributions: settled(), history: conversation(4), budget: tight, cacheFriendly: true })

  assert.ok(off.overflow.droppedHistory > 0, 'this fixture must trim, or it proves nothing about the charge')
  assert.equal(on.overflow.droppedHistory, off.overflow.droppedHistory)
  assert.equal(on.tokens, off.tokens)

  const roomyOn = assemble({ contributions: settled(), history: conversation(4), budget: roomy, cacheFriendly: true })
  assert.deepEqual(roomyOn.items.filter(item => item.promoted === true).map(item => item.id), ['d0', 'd1', 'd3'])
  // Promoted content is stable by definition, so it is inside the reusable run
  // rather than a boundary for it.
  assert.equal(roomyOn.stablePrefixTokens, roomyOn.tokens)
})

test('with the flag off, a settled contribution assembles exactly as before', () => {
  const off = assemble({ contributions: settled(), history: conversation(4), budget: roomy, cacheFriendly: false })
  const absent = assemble({ contributions: settled(), history: conversation(4), budget: roomy })
  assert.equal(JSON.stringify(off), JSON.stringify(absent))
  assert.deepEqual(texts(off.messages), ['m0', 'D3', 'm1', 'D2', 'm2', 'D1', 'm3', 'D0'])
})

test('renderSystem and injectAtDepth honour the flag on their own', () => {
  // Both are exported and both are called directly elsewhere; a reorder wired
  // only into `assemble` would leave those callers with the old order and no
  // error. `renderSystem` defaults to off, which is what keeps every existing
  // caller unchanged.
  assert.equal(renderSystem(contributions()), 'MAIN\n\nROLL 17\n\nCARD')
  assert.equal(renderSystem(contributions(), true), 'MAIN\n\nCARD')
  assert.deepEqual(texts(injectAtDepth(conversation(2), contributions())), ['D2', 'm0', 'm1', 'D0'])
  assert.deepEqual(texts(injectAtDepth(conversation(2), contributions(), true)),
    ['D2', 'm0', 'm1', 'ROLL 17', 'D0'])
})
