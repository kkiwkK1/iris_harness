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

/**
 * The explanation feature must not move a single byte.
 *
 * The iron rule the whole feature rests on: the report is a **projection** of an
 * assembly that already happened, so turning provenance on cannot change what the
 * model reads. The guarantee has teeth only if it is checked at the seam where
 * provenance enters — a contribution's optional `source` / `zeroReason` — rather
 * than trusted. If a future edit lets those fields reach `renderSystem`, a
 * placement or a token count, this reddens.
 *
 * The same contributions are assembled twice: once bare, once wearing the exact
 * metadata the prompt builder attaches. `system`, `messages`, `tokens` and
 * `stablePrefixTokens` must be equal, and — the part a shape comparison could
 * miss — the **itemization must still be produced** the second time, so a
 * mutation that "fixed" the byte equality by dropping the report would fail here
 * for the other reason.
 */
test('provenance metadata changes no assembled byte', () => {
  const bare: Contribution[] = [
    { id: 'main', placement: { kind: 'system', order: 10 }, text: 'You are Aria.' },
    { id: 'scenario', placement: { kind: 'system', order: 20 }, text: 'A map shop.' },
    // A row that renders to nothing, so the zero path is exercised too.
    { id: 'init', placement: { kind: 'system', order: 30 }, text: '' },
    { id: 'atDepth', placement: { kind: 'depth', depth: 1, role: 'system', order: 0 }, text: 'NOTE' },
  ]
  const explained: Contribution[] = bare.map((contribution) => ({
    ...contribution,
    source: contribution.id === 'atDepth'
      ? { kind: 'script', id: 'atDepth' }
      : { kind: 'preset', id: contribution.id },
    // The macro stage's report rides the same test: `init` is the row a
    // variable-driven preset produces, so it is the one that has heads to show.
    ...contribution.id === 'init'
      ? {
          zeroReason: 'macros-only' as const,
          macros: { heads: { setvar: 61 }, charsBefore: 1250, charsAfter: 0 },
          regex: { applied: ['strip-updates'] },
        }
      : {},
  }))

  const history = conversation(4)
  const plain = assemble({ contributions: bare, history, budget: roomy })
  const traced = assemble({
    contributions: explained,
    history,
    budget: roomy,
    // A history rule too, so the aggregate row's own regex report is in the
    // comparison — the one contribution-shaped field the caller supplies
    // rather than the builder.
    historyRules: ['hide-commands'],
  })

  assert.equal(traced.system, plain.system)
  assert.deepEqual(traced.messages, plain.messages)
  assert.equal(traced.tokens, plain.tokens)
  assert.equal(traced.stablePrefixTokens, plain.stablePrefixTokens)
  assert.deepEqual(traced.overflow, plain.overflow)
  // The report still exists and carries the metadata — otherwise the equality
  // above would be satisfied by provenance having been dropped on the floor.
  // Sliced to the contributions' length because `itemize` appends one aggregate
  // row for the conversation, which has a source of its own and no counterpart
  // in the input list.
  assert.deepEqual(
    traced.items.slice(0, explained.length).map(item => item.source),
    explained.map(contribution => contribution.source),
  )
  assert.equal(traced.items.find(item => item.id === 'init')?.zeroReason, 'macros-only')
  assert.deepEqual(
    traced.items.find(item => item.id === 'init')?.macros,
    { heads: { setvar: 61 }, charsBefore: 1250, charsAfter: 0 },
  )
  assert.deepEqual(traced.items.find(item => item.id === 'init')?.regex, { applied: ['strip-updates'] })
  // And the conversation row carries the caller's rule list, which is the only
  // place a prompt-direction regex can be recorded.
  assert.deepEqual(traced.items.find(item => item.id === 'chatHistory')?.regex, { applied: ['hide-commands'] })
  // Without the rules the same assembly reports none — absent is not `[]`.
  assert.equal(plain.items.find(item => item.id === 'chatHistory')?.regex, undefined)
})

/**
 * The reverse index marks a part stable exactly when it sits before the first
 * volatile one — and the boundary really does move.
 *
 * A hand-crafted assembly, so the volatile part is *known*: a system section
 * marked volatile makes everything from it on unservable, which is what the
 * prefix cache does and what the message view has to show. `stablePrefixTokens`
 * and the per-message verdicts come from one walk, and this pins that they agree
 * on a request where the walk actually stops in the middle.
 */
test('the message list marks parts stable up to the first volatile one', () => {
  const contributions: Contribution[] = [
    { id: 'a', placement: { kind: 'system', order: 10 }, text: 'A' },
    { id: 'b', placement: { kind: 'system', order: 20 }, text: 'B', volatile: true },
    { id: 'c', placement: { kind: 'system', order: 30 }, text: 'C' },
    { id: 'd0', placement: { kind: 'depth', depth: 0, role: 'system' }, text: 'D0' },
  ]
  const result = assemble({ contributions, history: conversation(2), budget: roomy })

  // The system prompt is one message and it is not stable — a volatile section
  // is inside it, so no part of it can be served.
  const [system, ...rest] = result.messageSlots
  assert.equal(system?.index, 0)
  assert.equal(system?.stable, false)
  assert.deepEqual(system?.partIds, ['a', 'b', 'c'])
  // And everything after it is outside the run too, including the depth-0
  // injection before the reply: one changed byte costs everything behind it.
  assert.equal(rest.every(slot => slot.stable === false), true)
  // The depth-0 injection is its own message and names itself — the reverse
  // index's per-message half, which is what the message view reads.
  const injected = result.messageSlots.find(slot => slot.partIds.includes('d0'))
  assert.ok(injected !== undefined, 'the depth injection should be named by a message')
  assert.deepEqual(injected.partIds, ['d0'])
  // The conversation's floors are named too, when the caller gave them ids —
  // `historyFromSession` always does, and this is what the message view shows
  // as "floor 0".
  const withIds = assemble({
    contributions,
    history: conversation(2).map((entry, index) => ({ ...entry, id: `history.${String(index)}` })),
    budget: roomy,
  })
  assert.equal(withIds.messageSlots.some(slot => slot.partIds.includes('history.0')), true)

  // The row's own verdict agrees with its message's, for every placed part.
  for (const item of result.items) {
    if (item.placement === undefined) continue
    assert.equal(item.stable, result.messageSlots[item.placement.messageIndex]?.stable,
      `${item.id} disagrees with its message about the prefix`)
  }

  // Now with nothing volatile, the same request is stable throughout — the
  // boundary is read from the classifications, never invented.
  const clean = assemble({
    contributions: contributions.map(({ volatile: _v, ...rest }) => rest),
    history: conversation(2),
    budget: roomy,
  })
  assert.equal(clean.messageSlots.every(slot => slot.stable), true)
})
