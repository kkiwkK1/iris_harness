import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assemble, injectAtDepth, itemize, MEMBER_JOIN } from '../src/index.ts'
import type { Contribution, HistoryEntry } from '../src/index.ts'

/**
 * Splitting a depth bucket by its members.
 *
 * SillyTavern merges every world-info entry sharing a depth and a role into one
 * newline-joined injection, and the merge is where the corpus's largest
 * remaining cache loss lives — not because the text moves, but because the
 * *set* of entries does. Measured on 爱衣: three entries of 8 223, 4 020 and
 * 7 114 bytes, each byte-identical between adjacent turns, inside a bucket
 * whose hash changed every turn and which therefore could not be promoted.
 *
 * So a contribution may carry its members, and the reorder places them one by
 * one. Every assertion here is about a way that could be implemented wrongly
 * while still looking right, and three of them would be invisible otherwise:
 *
 * - **Off must not read the members at all.** A bucket upstream sends as one
 *   message has to stay one message, byte for byte, or the setting stops being
 *   an escape hatch.
 * - **The split must be exact or refused.** A member list that does not rejoin
 *   to the contribution's own text describes bytes nobody assembled, and
 *   sending it would put text in the request that no part of the product chose.
 * - **The three destinations must partition.** A member counted in two of them
 *   is charged twice and the trim drops a floor that fits; one counted in none
 *   lets the conversation grow into space already spent.
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

const texts = (messages: readonly { text: string }[]): string[] => messages.map(message => message.text)

/**
 * A depth-0 bucket of three members, classified the three different ways.
 *
 * Depth 0 on purpose for the bucket, because that is the shape the corpus has:
 * 爱衣's whole 19 KB of world info lands at depth 0, so the volatile member has
 * nowhere later to go and stays with the remainder — which is the case where
 * "the bucket did not move" and "no member moved" differ.
 * @param settled - which member ids have been observed holding still.
 * @param volatile - which have been measured changing.
 * @returns the bucket, its text already the join of its members.
 */
function bucket(settled: string[] = [], volatile: string[] = []): Contribution {
  const members = [
    { id: 'wi#book.1', label: 'one', text: 'ONE' },
    { id: 'wi#book.2', label: 'two', text: 'TWO' },
    { id: 'wi#book.3', label: 'three', text: 'THREE' },
  ].map(member => ({
    ...member,
    ...settled.includes(member.id) ? { settled: true } : {},
    ...volatile.includes(member.id) ? { volatile: true } : {},
  }))
  return {
    id: 'wi',
    label: 'World Info (depth 0)',
    placement: { kind: 'depth', depth: 0, role: 'system', order: 0 },
    text: members.map(member => member.text).join(MEMBER_JOIN),
    members,
  }
}

test('settled members are promoted one by one and the rest stay joined', () => {
  const on = assemble({
    contributions: [bucket(['wi#book.1', 'wi#book.3'])],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })

  // The two settled entries lead the request as their own messages; the third
  // stays in the depth-0 slot at the end. Under the old whole-bucket rule the
  // answer would be `['m0', 'm1', 'ONE\nTWO\nTHREE']` — the entire bucket at
  // depth 0 — because the bucket carries no `settled` of its own.
  assert.deepEqual(texts(on.messages), ['ONE', 'THREE', 'm0', 'm1', 'TWO'])
  // Upstream's relative order inside the bucket, kept across the split: `ONE`
  // was joined before `THREE`, so it is read first here too.
  assert.deepEqual(
    on.messages.slice(0, 2).map(message => message.id),
    ['wi#book.1', 'wi#book.3'])
})

test('a member the reorder left behind keeps the bucket its slot and names itself', () => {
  const on = assemble({
    contributions: [bucket(['wi#book.1'])],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })

  const slot = on.messages.at(-1)
  assert.equal(slot?.text, 'TWO\nTHREE')
  // The slot is still the bucket's slot, so it answers to the bucket's id — a
  // remainder that renamed itself to its first surviving member would make the
  // divergence report say an entry vanished every time membership changed.
  assert.equal(slot?.id, 'wi')
  // And the members ride with it, which is the finer half of the same answer:
  // "the depth injection changed" names the largest part of the request and no
  // entry in it. The parts lay back down onto the slot exactly.
  assert.deepEqual(slot?.parts?.map(part => part.id), ['wi#book.2', 'wi#book.3'])
  assert.equal(slot?.parts?.map(part => part.text).join(MEMBER_JOIN), slot?.text)
  // The label travels too: it is the only place a promoted entry's own name can
  // reach a trace, since a promoted member is not in the system string.
  assert.deepEqual(slot?.parts?.map(part => part.label), ['two', 'three'])
})

test('a volatile member at depth 0 stays; deeper than 0 it is sent after the conversation', () => {
  const shallow = assemble({
    contributions: [bucket(['wi#book.1'], ['wi#book.2'])],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })
  // Depth 0 is already the last thing before the reply, so a volatile member
  // has nowhere later to go — the same geometry the whole-contribution rule
  // uses, applied to one entry.
  assert.deepEqual(texts(shallow.messages), ['ONE', 'm0', 'm1', 'TWO\nTHREE'])
  assert.equal(shallow.messages.at(-1)?.volatile, true,
    'a slot holding a volatile member must say so, or the prefix walk crosses it')

  const deep = bucket(['wi#book.1'], ['wi#book.2'])
  const lifted = assemble({
    contributions: [{ ...deep, placement: { kind: 'depth', depth: 2, role: 'system', order: 0 } }],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })
  // At depth 2 the volatile member sat *inside* the run two turns would agree
  // on, so it moves behind the conversation and the remainder keeps the slot.
  assert.deepEqual(texts(lifted.messages), ['ONE', 'THREE', 'm0', 'm1', 'TWO'])
  assert.equal(lifted.messages.at(-1)?.volatile, true)
  assert.equal(lifted.messages[1]?.volatile, undefined,
    'the promoted member must not be marked volatile, or the prefix stops at it')
})

test('the whole bucket carries no marks of its own once its members decide', () => {
  // A bucket marked volatile — which is what its hash says the moment its
  // membership changes — with two members that have held still. Under the
  // whole-contribution rule this bucket moves as one and nothing is promoted;
  // that is exactly the 7.4 points the corpus census attributed to one depth
  // segment.
  const contribution = { ...bucket(['wi#book.1', 'wi#book.3']), volatile: true }
  const on = assemble({
    contributions: [contribution],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })

  assert.deepEqual(texts(on.messages), ['ONE', 'THREE', 'm0', 'm1', 'TWO'])
  // Not in the volatile segment behind the conversation, and not duplicated
  // into both — `moves` and the member rule claiming the same text is the one
  // arrangement that could send a bucket twice.
  assert.equal(on.messages.filter(message => message.text.includes('ONE')).length, 1)
})

test('members that do not rejoin their text are refused, not approximated', () => {
  const wrong: Contribution = {
    id: 'wi',
    placement: { kind: 'depth', depth: 0, role: 'system', order: 0 },
    // A template rewrote the text after the members were taken: the list now
    // describes bytes that are not in the request.
    text: 'ONE\nTWO\nTHREE — and a postscript',
    members: [
      { id: 'wi#book.1', text: 'ONE', settled: true },
      { id: 'wi#book.2', text: 'TWO', settled: true },
      { id: 'wi#book.3', text: 'THREE', settled: true },
    ],
  }
  const on = assemble({
    contributions: [wrong],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })

  // Every member is settled, so a trusting split would have promoted all three
  // and silently dropped ' — and a postscript' from the request. Refused: the
  // bucket is placed whole, from its own text, and the contribution's own
  // (absent) verdict decides where.
  assert.deepEqual(texts(on.messages), ['m0', 'm1', 'ONE\nTWO\nTHREE — and a postscript'])
  assert.equal(on.messages.at(-1)?.parts, undefined,
    'a refused split must record no parts, or the trace lays down bytes that moved')
})

test('with the reorder off a split bucket is byte-identical to an unsplit one', () => {
  const split = bucket(['wi#book.1', 'wi#book.3'], ['wi#book.2'])
  const { members: _members, ...plain } = split

  for (const flag of [{ cacheFriendly: false }, {}]) {
    const withMembers = assemble({
      contributions: [split], history: conversation(3), budget: roomy, ...flag,
    })
    const without = assemble({
      contributions: [plain], history: conversation(3), budget: roomy, ...flag,
    })
    assert.equal(JSON.stringify(withMembers), JSON.stringify(without),
      'off, the member list must not be read — not for the request, not for the itemization')
    assert.deepEqual(texts(withMembers.messages), ['m0', 'm1', 'm2', 'ONE\nTWO\nTHREE'])
    assert.equal(withMembers.messages.at(-1)?.parts, undefined)
  }
})

test('a split bucket is charged exactly once, so the trim decides the same way', () => {
  // Room for the bucket plus about two floors. The three destinations have to
  // partition the members: charge one twice and `on` trims a floor `off` kept.
  const tight = { context: 6, reserve: 0, count: countWords }
  const split = bucket(['wi#book.1', 'wi#book.3'], ['wi#book.2'])
  const off = assemble({ contributions: [split], history: conversation(4), budget: tight })
  const on = assemble({
    contributions: [split], history: conversation(4), budget: tight, cacheFriendly: true,
  })

  assert.equal(on.overflow.droppedHistory, off.overflow.droppedHistory)
  // The same text either way, and the request's own total says so: the members
  // are three one-word strings whichever way they are placed.
  assert.equal(on.tokens, off.tokens)
})

test('the itemization keeps one row per bucket and marks the members under it', () => {
  const rows = itemize(
    [bucket(['wi#book.1', 'wi#book.3'])], conversation(2), countWords, true)
  const row = rows.find(entry => entry.id === 'wi')

  // One row, because the bucket is one contribution however many entries went
  // into it — a panel that grew three rows would make the preset look different
  // from the one the user configured.
  assert.equal(rows.filter(entry => entry.id === 'wi').length, 1)
  // And **neither** mark on it: two entries reached the prefix and one did not,
  // so no single mark is true of the row. A `promoted` here would tell a reader
  // their whole world-info block moved.
  assert.equal(row?.promoted, undefined)
  assert.equal(row?.deferred, undefined)
  assert.deepEqual(row?.members?.map(member => [member.id, member.promoted === true]), [
    ['wi#book.1', true],
    ['wi#book.2', false],
    ['wi#book.3', true],
  ])
  // Tokens per member, so the panel can say how much each one is worth; they
  // sum to the row's own count for a bucket of one-word members.
  assert.deepEqual(row?.members?.map(member => member.tokens), [1, 1, 1])

  // When every member goes the same way the row speaks for them again, which
  // is what keeps the ordinary case a one-line answer.
  const all = itemize(
    [bucket(['wi#book.1', 'wi#book.2', 'wi#book.3'])], conversation(2), countWords, true)
  assert.equal(all.find(entry => entry.id === 'wi')?.promoted, true)
})

test('injectAtDepth splits on its own, so a caller that skips assemble agrees', () => {
  const messages = injectAtDepth(
    conversation(2), [bucket(['wi#book.1', 'wi#book.3'])], true)
  assert.deepEqual(texts(messages), ['ONE', 'THREE', 'm0', 'm1', 'TWO'])
  // And not without the flag: the two entry points must not disagree about
  // whether a bucket is one message.
  assert.deepEqual(
    texts(injectAtDepth(conversation(2), [bucket(['wi#book.1', 'wi#book.3'])])),
    ['m0', 'm1', 'ONE\nTWO\nTHREE'])
})

test('the prefix reading stops at a slot holding a volatile member', () => {
  const held = assemble({
    contributions: [bucket(['wi#book.1'], ['wi#book.2'])],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })
  const clean = assemble({
    contributions: [bucket(['wi#book.1', 'wi#book.2', 'wi#book.3'])],
    history: conversation(2),
    budget: roomy,
    cacheFriendly: true,
  })

  // The volatile member is at depth 0, so it stays — and everything behind it
  // is unservable. The reading has to say so: this is a loss the reorder
  // cannot repair, and a number that ignored it would report a ceiling the
  // provider will never pay.
  assert.ok(held.stablePrefixTokens < held.tokens)
  assert.equal(clean.stablePrefixTokens, clean.tokens)
})
