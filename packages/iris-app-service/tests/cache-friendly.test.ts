import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Contribution } from '@iris/pipeline'

import {
  classifyVolatility,
  contentHash,
  DEFAULT_VOLATILE_HOLD,
  emptyVolatility,
  entropicFeatures,
  ENTROPIC_MACROS,
  isEntropic,
  DEFAULT_SETTLE_AFTER,
  markCachePhase,
  type VolatilityRecord,
} from '../src/cache-friendly.ts'
import { readVolatility, VOLATILITY_KEY, writeVolatility } from '../src/entry.ts'

/**
 * Which contributions the host classifies as changing between turns.
 *
 * The classifier is the half of the cache-friendly order that can be *wrong*.
 * Placement is arithmetic — `@iris/pipeline`'s own tests pin it — but "will this
 * text be the same next turn?" is a judgement, and both directions of getting it
 * wrong were reached during development and are pinned here:
 *
 * - **Too broad.** A prediction list that included `{{getvar}}` fired on 136 of
 *   one real preset's 246 prompts and took a real conversation's ceiling from
 *   72.2% to 66.7% — moving stable text out of the prefix costs the prefix.
 * - **Too short-lived.** A prediction that lapsed on the next assembly made the
 *   *layout* the volatile thing: two assemblies of one unchanged state agreed on
 *   0.3% of their bytes where the control had been 100%.
 *
 * So the shape under test is: predict narrowly, hold what you predict, and let
 * the content hash have the last word.
 */

/** A contribution with a system placement, since only the id and text matter here. */
function part(id: string, text: string): Contribution {
  return { id, placement: { kind: 'system', order: 10 }, text }
}

// --- the entropic feature list ---------------------------------------------

test('the entropic list carries the macros whose value provably moves', () => {
  // Named individually rather than asserted as a count: a count would go red
  // for a correct addition, and the point of the list is *which* macros are on
  // it. Each of these renders a different string on two expansions or as the
  // conversation grows.
  for (const macro of ['random', 'roll', 'time', 'date', 'isotime', 'lastMessage', 'lastMessageId', 'input']) {
    assert.ok(ENTROPIC_MACROS.includes(macro), `${macro} should be predicted volatile`)
    assert.equal(isEntropic(`text {{${macro}}} more`), true)
  }
})

test('the variable-macro family is deliberately NOT predicted volatile', () => {
  // The measured correction. A preset uses `{{setvar}}` / `{{getvar}}` for its
  // own switches, which answer the same string every turn; predicting them cost
  // more prefix than it ever saved. If a variable read really does move, the
  // content hash catches it on the second turn with the full hold.
  for (const macro of ['getvar', 'setvar', 'addvar', 'incvar', 'getglobalvar', 'outlet', 'pick']) {
    assert.equal(ENTROPIC_MACROS.includes(macro), false, `${macro} must stay off the prediction list`)
    assert.equal(isEntropic(`text {{${macro}::key}} more`), false)
  }
})

test('the Tavern Helper variable family and EJS are predicted volatile', () => {
  // MVU's status block is `{{format_message_variable::stat_data}}` and is the
  // single largest per-turn block measured in the corpus. Asked of the module
  // that owns the scope list rather than spelled out again here.
  assert.deepEqual(entropicFeatures('State:\n{{format_message_variable::stat_data}}'),
    ['format_message_variable'])
  assert.deepEqual(entropicFeatures('{{get_chat_variable::hp}}'), ['get_chat_variable'])
  // An EJS template is a program, not a read: nothing here can decide what it
  // does, so it counts.
  assert.deepEqual(entropicFeatures('<%= new Date() %>'), ['<% %>'])
  assert.deepEqual(entropicFeatures('plain prose with {{char}} and {{user}}'), [])
})

test('a macro head is recognised in every spelling the expander accepts', () => {
  assert.equal(isEntropic('{{time}}'), true)
  assert.equal(isEntropic('{{time::UTC+2}}'), true)
  assert.equal(isEntropic('{{ time }}'), true)
  // The legacy underscore spelling, which `expand.ts` normalises into `::`.
  assert.equal(isEntropic('{{time_UTC+2}}'), true)
  // Not a false positive on a longer name that merely starts the same way.
  assert.equal(isEntropic('{{timezone}}'), false)
})

// --- the ledger -------------------------------------------------------------

test('first sight uses the prediction, and the prediction holds', () => {
  const first = classifyVolatility(emptyVolatility(), [part('roll', 'you rolled 17')], {
    entropic: new Set(['roll']),
  })
  assert.deepEqual([...first.volatile], ['roll'])

  // The same id, same text, next generation: the prediction no longer applies
  // (it is first-sight only) but the mark it set is still live. A mark that
  // lapsed here would move the section back and forth between turns, which is
  // worse than either position.
  const second = classifyVolatility(first.next, [part('roll', 'you rolled 17')], {})
  assert.deepEqual([...second.volatile], ['roll'], 'the mark must survive without the prediction')
})

test('a changed hash marks an id the prediction never suspected', () => {
  const first = classifyVolatility(emptyVolatility(), [part('lore', 'The city is old.')], {})
  assert.deepEqual([...first.volatile], [], 'nothing is volatile on first sight without a feature')

  const second = classifyVolatility(first.next, [part('lore', 'The city is ancient.')], {})
  assert.deepEqual([...second.volatile], ['lore'])
})

test('a mark lapses after the hold, and not before', () => {
  const hold = 3
  let record: VolatilityRecord = classifyVolatility(
    emptyVolatility(), [part('lore', 'a')], { entropic: new Set(['lore']), hold },
  ).next

  // Same text from here on, so only the hold is being measured.
  const live: boolean[] = []
  for (let step = 0; step < hold + 2; step += 1) {
    const round = classifyVolatility(record, [part('lore', 'b')], { hold })
    live.push(round.volatile.has('lore'))
    record = round.next
  }

  // The first of these rounds also *measures* a change (a -> b), which renews
  // the mark — that is the point of the sequence: a renewal restarts the hold.
  assert.deepEqual(live, [true, true, true, true, false],
    'a measured change renews the hold; the mark lapses `hold` generations later')
})

test('a runtime injection is re-armed every generation and never lapses', () => {
  const runtime = new Set(['script.mvu'])
  const hold = 2
  let record = emptyVolatility()
  for (let step = 0; step < hold + 4; step += 1) {
    // Identical text every time, which is exactly the case a hash cannot judge:
    // a script that happened to compute the same string twice has not become
    // stable, and this contribution lands ahead of the whole preset.
    const round = classifyVolatility(record, [part('script.mvu', 'same text')], { runtime, hold })
    assert.equal(round.volatile.has('script.mvu'), true, `lapsed at generation ${String(step)}`)
    record = round.next
  }
})

test('a contribution missing from one assembly keeps its mark', () => {
  const first = classifyVolatility(emptyVolatility(), [part('roll', 'x')], { entropic: new Set(['roll']) })
  // A world-info entry that did not activate this turn has not become stable —
  // it was not asked. Its row must survive an assembly it is absent from.
  const without = classifyVolatility(first.next, [part('other', 'y')], {})
  assert.equal(without.next.until['roll'], first.next.until['roll'])
  const back = classifyVolatility(without.next, [part('roll', 'x')], {})
  assert.equal(back.volatile.has('roll'), true)
})

test('no id is ever both volatile and settled', () => {
  // Enforced again downstream — `markCachePhase` checks volatile first and
  // `promotes()` refuses a volatile contribution — so breaking it *here* is
  // unobservable in the assembled request. That is exactly why it needs its own
  // assertion: an invariant defended only by its consumers is one that quietly
  // stops holding, and the next consumer inherits a contract nothing checks.
  const parts = [part('roll', 'x'), part('lore', 'y'), part('script.mvu', 'z')]
  let record = emptyVolatility()
  for (let step = 0; step < 6; step += 1) {
    const round = classifyVolatility(record, parts, {
      entropic: new Set(['roll']),
      runtime: new Set(['script.mvu']),
      hold: 2,
      settleAfter: 1,
    })
    for (const id of round.volatile) {
      assert.equal(round.settled.has(id), false, `${id} was both at generation ${String(step)}`)
    }
    record = round.next
  }
  // And the fixture reached both states, or the loop above proved nothing.
  const final = classifyVolatility(record, parts, { runtime: new Set(['script.mvu']), hold: 2, settleAfter: 1 })
  assert.ok(final.volatile.size > 0 && final.settled.size > 0,
    'this fixture must produce both kinds of verdict at once')
})

test('the generation counter advances once per classification', () => {
  const one = classifyVolatility(emptyVolatility(), [part('a', 'x')], {})
  const two = classifyVolatility(one.next, [part('a', 'x')], {})
  assert.equal(one.next.generation, 1)
  assert.equal(two.next.generation, 2)
})

test('the default hold is long enough that a real conversation does not flap', () => {
  // The number itself is a policy, but its *direction* is not: a hold shorter
  // than a handful of turns makes the layout change mid-conversation, and every
  // change costs one full miss. Asserted as a floor, not as a value, so tuning
  // the policy does not go red.
  assert.ok(DEFAULT_VOLATILE_HOLD >= 5, 'a short hold reintroduces the flapping this exists to prevent')
})

test('the content hash is stable across calls and sensitive to one character', () => {
  assert.equal(contentHash('The city is old.'), contentHash('The city is old.'))
  assert.notEqual(contentHash('The city is old.'), contentHash('The city is Old.'))
  assert.equal(contentHash(''), contentHash(''))
})

test('markCachePhase copies rather than writing into the caller\'s contributions', () => {
  const source = [part('a', 'x'), part('b', 'y'), part('c', 'z')]
  const marked = markCachePhase(source, { volatile: new Set(['a']), settled: new Set(['b']) })

  assert.equal(marked[0]?.volatile, true)
  assert.equal(marked[1]?.settled, true)
  // Unclassified stays unclassified in both fields: "not known to change" is
  // not the same claim as "known not to change", and only the second one
  // justifies moving something into the prefix.
  assert.equal(marked[2]?.volatile, undefined)
  assert.equal(marked[2]?.settled, undefined)
  // The originals came from the preset resolver and the world-info scan, and a
  // per-turn verdict written into them would leak to whatever else holds a
  // reference.
  assert.equal(source[0]?.volatile, undefined)
  assert.equal(source[1]?.settled, undefined)
})

test('an id settles only after consecutive unchanged observations', () => {
  const settleAfter = 2
  let record = emptyVolatility()
  const heldStill: boolean[] = []
  for (let step = 0; step < 4; step += 1) {
    const round = classifyVolatility(record, [part('lore', 'The city is old.')], { settleAfter })
    heldStill.push(round.settled.has('lore'))
    record = round.next
  }
  // First sight is not evidence; the second observation of the same bytes is
  // the first moment the content has demonstrably *held*.
  assert.deepEqual(heldStill, [false, false, true, true])
})

test('a change unsettles immediately, and the volatile hold outlasts it', () => {
  const options = { hold: 3, settleAfter: 2 }
  let record = emptyVolatility()
  for (let step = 0; step < 4; step += 1) {
    record = classifyVolatility(record, [part('lore', 'stable')], options).next
  }
  const settledNow = classifyVolatility(record, [part('lore', 'stable')], options)
  assert.equal(settledNow.settled.has('lore'), true)

  // One changed byte, and it is neither settled nor promotable for `hold`
  // generations — the two sets are disjoint by construction, and a promoted
  // section that had to come back would cost a full miss.
  const changed = classifyVolatility(settledNow.next, [part('lore', 'moved')], options)
  assert.equal(changed.volatile.has('lore'), true)
  assert.equal(changed.settled.has('lore'), false)

  let after = changed.next
  const timeline: string[] = []
  for (let step = 0; step < 5; step += 1) {
    const round = classifyVolatility(after, [part('lore', 'moved')], options)
    timeline.push(round.volatile.has('lore') ? 'volatile' : round.settled.has('lore') ? 'settled' : 'neither')
    after = round.next
  }
  // The hold runs out first, and by then the content has held still for longer
  // than `settleAfter`, so it goes straight from volatile to settled without a
  // stretch of sitting in place — one relayout, not two.
  assert.deepEqual(timeline, ['volatile', 'volatile', 'volatile', 'settled', 'settled'])
})

test('the settle threshold is small, because the hold already governs anything that moved', () => {
  assert.ok(DEFAULT_SETTLE_AFTER >= 1)
  assert.ok(DEFAULT_SETTLE_AFTER < DEFAULT_VOLATILE_HOLD,
    'a settle threshold at or above the hold would make the hold unreachable')
})

test('a record written before `since` existed still classifies', () => {
  // Forward compatibility in the direction that actually happens: a chat file
  // saved by an earlier build carries `seen` and `until` and no `since`. It must
  // keep working for the volatile direction and simply start observing for the
  // promote direction, not crash and not settle everything on sight.
  const old = { generation: 5, seen: { a: contentHash('x') }, until: {} }
  const round = classifyVolatility(old, [part('a', 'x')], { settleAfter: 2 })
  assert.equal(round.volatile.has('a'), false)
  assert.equal(round.settled.has('a'), false, 'an unobserved id must not settle on its first classification')
  assert.equal(round.next.since?.['a'], 5)
})

// --- persistence ------------------------------------------------------------

test('the record survives a round trip through chat metadata', () => {
  const record: VolatilityRecord = { generation: 7, seen: { a: 'deadbeef' }, until: { a: 27 } }
  const metadata: Record<string, unknown> = {}
  writeVolatility(metadata, record)

  assert.deepEqual(readVolatility(metadata), record)
  // Stored under Iris's own key, since upstream has no equivalent feature.
  assert.ok(Object.hasOwn(metadata, VOLATILITY_KEY))
})

test('a malformed record is refused rather than half-read', () => {
  // A `generation: "3"` would poison the comparison that decides whether a mark
  // has lapsed, and the symptom would look like random reordering rather than
  // like bad data.
  assert.equal(readVolatility({ [VOLATILITY_KEY]: { generation: '3', seen: {}, until: {} } }), undefined)
  assert.equal(readVolatility({ [VOLATILITY_KEY]: 'nonsense' }), undefined)
  assert.equal(readVolatility({}), undefined)

  // A record whose *rows* are partly unusable keeps the usable ones: dropping
  // the whole table for one bad row would re-pay for every classification.
  const mixed = readVolatility({
    [VOLATILITY_KEY]: { generation: 2, seen: { a: 'x', b: 5 }, until: { a: 9, b: 'soon' } },
  })
  assert.deepEqual(mixed, { generation: 2, seen: { a: 'x' }, until: { a: 9 } })
})
