import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assemble, injectAtDepth, renderSystem, trimHistory } from '../src/index.ts'
import type { Contribution, HistoryEntry } from '../src/index.ts'

/** One token per word — enough to make budget arithmetic legible in tests. */
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

test('system sections concatenate in ascending order', () => {
  const contributions: Contribution[] = [
    { id: 'scenario', placement: { kind: 'system', order: 30 }, text: 'Scenario.' },
    { id: 'persona', placement: { kind: 'system', order: 0 }, text: 'You are Aria.' },
    { id: 'description', placement: { kind: 'system', order: 10 }, text: 'A cartographer.' },
  ]

  assert.equal(renderSystem(contributions), 'You are Aria.\n\nA cartographer.\n\nScenario.')
})

test('a section that rendered empty leaves no gap', () => {
  const contributions: Contribution[] = [
    { id: 'a', placement: { kind: 'system', order: 0 }, text: 'First.' },
    { id: 'empty', placement: { kind: 'system', order: 5 }, text: '   ' },
    { id: 'b', placement: { kind: 'system', order: 10 }, text: 'Second.' },
  ]

  assert.equal(renderSystem(contributions), 'First.\n\nSecond.')
})

test('depth 0 lands after the last message and depth 1 before it', () => {
  const messages = injectAtDepth(conversation(3), [
    { id: 'after', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'AFTER' },
    { id: 'before', placement: { kind: 'depth', depth: 1, role: 'system' }, text: 'BEFORE' },
  ])

  assert.deepEqual(messages.map(message => message.text), ['m0', 'm1', 'BEFORE', 'm2', 'AFTER'])
})

test('an author note at depth survives history trimming, still anchored to the end', () => {
  const contributions: Contribution[] = [
    { id: 'note', placement: { kind: 'depth', depth: 1, role: 'system' }, text: 'NOTE' },
  ]
  // Room for the note plus three of the six turns. `trimBlockFloors: 0` on
  // purpose: this test is about **where the note lands** relative to whatever
  // history survives, so it asks for the exact-fit trim — upstream's rule — and
  // leaves the quantised default to `trim-block.test.ts`. Without that, a
  // six-floor fixture and an eight-floor block would collapse the conversation
  // to one floor and the anchoring would be asserted against nothing.
  const result = assemble({
    contributions,
    history: conversation(6),
    budget: { context: 4, reserve: 0, count: countWords, trimBlockFloors: 0 },
  })

  assert.equal(result.overflow.droppedHistory, 3)
  assert.deepEqual(result.messages.map(message => message.text), ['m3', 'm4', 'NOTE', 'm5'])
})

test('several injections at one depth order among themselves', () => {
  const contributions: Contribution[] = [
    { id: 'late', placement: { kind: 'depth', depth: 0, role: 'system', order: 20 }, text: 'LATE' },
    { id: 'early', placement: { kind: 'depth', depth: 0, role: 'system', order: 10 }, text: 'EARLY' },
  ]
  const result = assemble({ contributions, history: conversation(1), budget: roomy })

  assert.deepEqual(result.messages.map(message => message.text), ['m0', 'EARLY', 'LATE'])
})

test('a depth deeper than the conversation clamps to the front', () => {
  const contributions: Contribution[] = [
    { id: 'note', placement: { kind: 'depth', depth: 99, role: 'system' }, text: 'NOTE' },
  ]
  const result = assemble({ contributions, history: conversation(2), budget: roomy })

  assert.deepEqual(result.messages.map(message => message.text), ['NOTE', 'm0', 'm1'])
})

test('an injection carries its own role', () => {
  const contributions: Contribution[] = [
    { id: 'nudge', placement: { kind: 'depth', depth: 0, role: 'user' }, text: 'Continue.' },
  ]
  const result = assemble({ contributions, history: conversation(1), budget: roomy })

  assert.equal(result.messages[1]?.role, 'user')
})

test('trimming drops the oldest turns first', () => {
  const { kept, dropped } = trimHistory(conversation(5), 2, countWords)

  assert.deepEqual(kept.map(entry => entry.text), ['m3', 'm4'])
  assert.equal(dropped, 3)
})

test('a pinned turn is exempt from trimming wherever it sits', () => {
  const history = conversation(5)
  history[0] = { ...(history[0] as HistoryEntry), pinned: true }

  const { kept } = trimHistory(history, 2, countWords)

  assert.deepEqual(kept.map(entry => entry.text), ['m0', 'm3', 'm4'], 'the greeting stays, the middle goes')
})

test('an over-budget request is still returned, flagged', () => {
  const contributions: Contribution[] = [
    { id: 'huge', placement: { kind: 'system', order: 0 }, text: 'a b c d e f g h' },
  ]
  const result = assemble({
    contributions,
    history: conversation(2),
    budget: { context: 4, reserve: 0, count: countWords },
  })

  assert.equal(result.overflow.overBudget, true)
  assert.equal(result.system, 'a b c d e f g h', 'the character definition is never silently discarded')
  assert.equal(result.overflow.droppedHistory, 2)
})

test('the reserve is withheld from the history budget', () => {
  // `trimBlockFloors: 0` for the same reason as the note test above: the claim
  // here is that a reserve shrinks the history budget, which is a statement
  // about the exact-fit arithmetic. Quantising the drop would round both
  // numbers to the same block and the comparison would stop discriminating.
  const budget = { context: 4, count: countWords, trimBlockFloors: 0 }
  const spacious = assemble({ contributions: [], history: conversation(4), budget: { ...budget, reserve: 0 } })
  const reserved = assemble({ contributions: [], history: conversation(4), budget: { ...budget, reserve: 2 } })

  assert.equal(spacious.overflow.droppedHistory, 0)
  assert.equal(reserved.overflow.droppedHistory, 2)
})

test('an empty injection contributes nothing', () => {
  const contributions: Contribution[] = [
    { id: 'blank', placement: { kind: 'depth', depth: 0, role: 'system' }, text: '  ' },
  ]
  const result = assemble({ contributions, history: conversation(1), budget: roomy })

  assert.deepEqual(result.messages.map(message => message.text), ['m0'])
})

test('speaker names survive assembly', () => {
  const result = assemble({
    contributions: [],
    history: [{ role: 'assistant', text: 'Hello.', name: 'Aria' }],
    budget: roomy,
  })

  assert.equal(result.messages[0]?.name, 'Aria')
})
