/**
 * The storage half of a card's own spend: the header array, and reading it back.
 *
 * `./side-generate.test.ts` covers the path — a card generates, a record
 * appears — and this covers the format, which is the part that has to survive
 * files it did not write. Three populations of file exist and all three are
 * real: the ones written before this key existed (every chat on this machine
 * today), the ones written by this code, and the ones that arrived from
 * somewhere else with something unexpected under the key.
 *
 * The size figure at the foot is a **measurement with a consumer**: the array is
 * append-only and unbounded, so `SIDE_USAGE_FIELD`'s doc quotes bytes per record
 * to justify not bounding it, and a constant that encodes a measurement drifts
 * unless the comparison is in the build.
 *
 * @module @iris/app-service/tests/side-usage
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SillyTavernChatHeader } from '@iris/persistence'

import {
  appendSideUsage, compactionUsage, parseSideUsage, readSideUsage, scriptUsage,
  SIDE_SOURCES, SIDE_USAGE_FIELD, sideSourceOf, sideUsageFieldOf,
} from '../src/side-usage.ts'

/** A header with nothing on it, the way `formatChatFile` would find one. */
function header(): SillyTavernChatHeader {
  return {
    user_name: 'You',
    character_name: 'Aria',
    create_date: '2026-09-08 @12h30m00s',
    chat_metadata: {},
  } as unknown as SillyTavernChatHeader
}

test('a record round-trips through the header, with its caller and fingerprint', () => {
  const head = header()
  appendSideUsage(head, {
    usage: {
      inputTokens: 320,
      outputTokens: 48,
      cacheReadTokens: 90,
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      at: 1_757_000_000_000,
      source: 'script',
    },
    caller: 'script.generate',
    fingerprint: { promptHash: '0123456789abcdef', prefixHash: 'fedcba9876543210' },
  })

  // Through JSON, because that is the only trip that matters: the header is
  // line 1 of a `.jsonl` file, and a round trip through the live object would
  // prove nothing about what reaches disk.
  const reread = JSON.parse(JSON.stringify(head)) as SillyTavernChatHeader
  const records = readSideUsage(reread)
  assert.equal(records.length, 1)
  const record = records[0]
  assert.ok(record !== undefined)
  assert.equal(record.usage.inputTokens, 320)
  assert.equal(record.usage.outputTokens, 48)
  assert.equal(record.usage.cacheReadTokens, 90)
  assert.equal(record.usage.model, 'deepseek-reasoner')
  assert.equal(record.usage.provider, 'deepseek')
  assert.equal(record.usage.at, 1_757_000_000_000)
  assert.equal(record.caller, 'script.generate')
  assert.deepEqual(record.fingerprint, { promptHash: '0123456789abcdef', prefixHash: 'fedcba9876543210' })
})

test('a file written before this key existed reads as a conversation with no card spend', () => {
  /*
   * Not a hypothetical: this is every chat file on this machine today. The
   * distinction being pinned is that a missing key reads as **no records**
   * rather than as an error or as a conversation that cannot be opened — and
   * that nothing creates the field just by looking.
   */
  const head = header()
  assert.deepEqual(readSideUsage(head), [])
  assert.deepEqual(sideUsageFieldOf(head), [])
  assert.equal(scriptUsage(readSideUsage(head)), undefined)
  assert.equal(head[SIDE_USAGE_FIELD], undefined, 'reading created the field')
})

test('appending keeps entries this code cannot read', () => {
  /*
   * A header that arrived from elsewhere — a future version, or a hand edit —
   * with something under the key that this reader refuses. Rewriting the field
   * from the parsed records is the tempting implementation and it silently
   * deletes whatever it could not parse, which on a *cost* record is the one
   * failure this whole feature exists to remove.
   */
  const head = header()
  head[SIDE_USAGE_FIELD] = [{ somethingElse: true }, 7, null]
  appendSideUsage(head, {
    usage: { inputTokens: 10, outputTokens: 2, source: 'script' },
    caller: 'script.generateRaw',
  })

  assert.equal(sideUsageFieldOf(head).length, 4, 'an unreadable neighbour was dropped')
  const records = readSideUsage(head)
  assert.equal(records.length, 1, 'the unreadable neighbours were counted as records')
  assert.equal(records[0]?.caller, 'script.generateRaw')
})

test('the location decides it is not a turn; the field chooses between the side sources', () => {
  /*
   * The rule this module shipped with was "the location is the authority", and
   * it was written when the array held one population. It cannot survive two
   * stored in the same place, so the rule is now split — and both halves are
   * pinned here, because the tempting simplification in either direction is
   * wrong in a way that adds up:
   *
   * - trusting the field outright lets a file from elsewhere claim `'turn'` in
   *   here and move a card's spend into the turn column, which is the reading
   *   the split exists to make possible;
   * - keeping the old stamp files the host's own compaction summaries as a
   *   card's, so the column labelled "how much of this was the card" reports
   *   spend no card asked for.
   */
  const lying = parseSideUsage({
    inputTokens: 10,
    outputTokens: 2,
    source: 'turn',
    caller: 'script.generate',
  })
  assert.equal(lying?.usage.source, 'script', 'a record claiming to be a turn was believed')

  // A record with no `source` at all — which a hand-written file has, and which
  // is every record written under this key before the summarizer was recorded —
  // reads as a card's. Not a guess: that is the population.
  const bare = parseSideUsage({ inputTokens: 10, outputTokens: 2, caller: 'script.generate' })
  assert.equal(bare?.usage.source, 'script')

  // And a compaction says so and is believed, which is the half the old stamp
  // could not express.
  const host = parseSideUsage({
    inputTokens: 10, outputTokens: 2, source: 'compaction', caller: 'host.compaction',
  })
  assert.equal(host?.usage.source, 'compaction', 'a compaction record was refiled as a card’s')

  // The resolver itself, over the cases the reader hands it. `SIDE_SOURCES` is
  // the list, so a third asker added there is accepted here without this test
  // having to be told about it — and anything else still lands on `'script'`.
  for (const source of SIDE_SOURCES) assert.equal(sideSourceOf(source), source)
  for (const other of ['turn', '', 'Compaction', 42, null, undefined, {}]) {
    assert.equal(sideSourceOf(other), 'script', `${JSON.stringify(other)} was accepted as a source`)
  }
})

test('a record with no usable caller is refused whole', () => {
  /*
   * The caller is the only attribution these records have, and a placeholder in
   * that column would be indistinguishable from a real method named that. So a
   * record without one is not counted — which understates a bill by one record
   * rather than inventing an attribution, and only reaches a file this code did
   * not write.
   */
  assert.equal(parseSideUsage({ inputTokens: 10, outputTokens: 2 }), undefined)
  assert.equal(parseSideUsage({ inputTokens: 10, outputTokens: 2, caller: '' }), undefined)
  assert.equal(parseSideUsage({ inputTokens: 10, outputTokens: 2, caller: 42 }), undefined)
  // And a half-read cost is refused by `parseUsage` for the reason it gives:
  // it would understate a conversation while looking like a complete reading.
  assert.equal(parseSideUsage({ inputTokens: 10, caller: 'script.generate' }), undefined)
})

test('a fingerprint is read only when both halves are there', () => {
  // "Same prefix, different body?" is not a question one hash can be asked, so
  // half a pair is dropped rather than carried beside a cost it cannot explain.
  const half = parseSideUsage({
    inputTokens: 10, outputTokens: 2, caller: 'script.generate',
    fingerprint: { promptHash: 'abc' },
  })
  assert.equal(half?.fingerprint, undefined)
  const whole = parseSideUsage({
    inputTokens: 10, outputTokens: 2, caller: 'script.generate',
    fingerprint: { promptHash: 'abc', prefixHash: 'def' },
  })
  assert.deepEqual(whole?.fingerprint, { promptHash: 'abc', prefixHash: 'def' })
})

test('the share is summed under the aggregate rule, and carries no total', () => {
  const head = header()
  appendSideUsage(head, {
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 400, totalTokens: 510, source: 'script' },
    caller: 'script.generate',
  })
  appendSideUsage(head, {
    // No cache bucket: an endpoint that reports usage and says nothing about
    // caching, which is the commonest OpenAI-compatible shape.
    usage: { inputTokens: 50, outputTokens: 5, source: 'script' },
    caller: 'script.generateRaw',
  })

  const share = scriptUsage(readSideUsage(head))
  assert.ok(share !== undefined)
  assert.equal(share.turns, 2)
  assert.equal(share.usage.inputTokens, 150)
  assert.equal(share.usage.outputTokens, 15)
  /*
   * `cacheRead` is 400 and not 400-plus-a-zero: an optional bucket is summed
   * only over the generations that reported it, so the second record does not
   * enter the numerator or claim the cache served it nothing.
   */
  assert.equal(share.usage.cacheReadTokens, 400)
  /*
   * And no `totalTokens`, by the ruling `conversationUsage` ships: summed under
   * the same rule it would cover only the record that carried an exact total —
   * 510 here, against buckets adding to 165 — a field named `totalTokens` next
   * to buckets it does not total.
   */
  assert.equal(share.usage.totalTokens, undefined)
})

test('each share sums its own population, and one array holds both', () => {
  /*
   * The behaviour change the second population forced. `scriptUsage` used to
   * add every record in the array because every record in the array was a
   * card's; a version that kept doing that reports a card share that includes
   * the host's compactions — a figure labelled "how much of this was the card"
   * that a card did not spend, and one that still adds up against the total.
   *
   * The two populations are given **different bucket values and different
   * counts** (two records against one), so every wrong filter produces a
   * number no correct reading does.
   */
  const head = header()
  appendSideUsage(head, {
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 400, source: 'script' },
    caller: 'script.generate',
  })
  appendSideUsage(head, {
    usage: { inputTokens: 50, outputTokens: 5, source: 'script' },
    caller: 'script.generateRaw',
  })
  appendSideUsage(head, {
    usage: { inputTokens: 2_140, outputTokens: 96, cacheReadTokens: 768, source: 'compaction' },
    caller: 'host.compaction',
  })

  const records = readSideUsage(head)
  assert.equal(records.length, 3, 'one array does not hold both populations')

  const card = scriptUsage(records)
  const host = compactionUsage(records)
  assert.ok(card !== undefined)
  assert.ok(host !== undefined)
  assert.equal(card.turns, 2, 'the card share counted the compaction')
  assert.equal(card.usage.inputTokens, 150, 'the card share summed the compaction’s prompt tokens')
  assert.equal(card.usage.cacheReadTokens, 400, 'the card share took the compaction’s cache bucket')
  assert.equal(host.turns, 1, 'the compaction share counted the card generations')
  assert.equal(host.usage.inputTokens, 2_140)
  assert.equal(host.usage.cacheReadTokens, 768)

  /*
   * And a population with no records is **absent**, not a row of zeros — the
   * rule the optional buckets follow, and what a surface reads as "this
   * conversation has never been compacted" rather than "compaction cost
   * nothing".
   */
  const cardsOnly = header()
  appendSideUsage(cardsOnly, {
    usage: { inputTokens: 100, outputTokens: 10, source: 'script' },
    caller: 'script.generate',
  })
  assert.equal(compactionUsage(readSideUsage(cardsOnly)), undefined)
  const hostOnly = header()
  appendSideUsage(hostOnly, {
    usage: { inputTokens: 100, outputTokens: 10, source: 'compaction' },
    caller: 'host.compaction',
  })
  assert.equal(scriptUsage(readSideUsage(hostOnly)), undefined)
})

test('the written record says which asker it is, so a foreign reader can tell', () => {
  /*
   * The reader defaults a missing `source` to `'script'`, so a compaction
   * stored without the field would come back as a card's on the very next read
   * — the record's own file has to carry the word. And a caller handing over a
   * `TurnUsage` that says `'turn'` must not be able to write that into this
   * array, which is the same normalisation the read side performs.
   */
  const head = header()
  appendSideUsage(head, {
    usage: { inputTokens: 10, outputTokens: 2, source: 'compaction' },
    caller: 'host.compaction',
  })
  appendSideUsage(head, {
    usage: { inputTokens: 10, outputTokens: 2, source: 'turn' },
    caller: 'script.generate',
  })
  const stored = sideUsageFieldOf(head).map(one => (one as { source?: unknown }).source)
  assert.deepEqual(stored, ['compaction', 'script'])
})

test('one stored record is the size the field’s doc says it is', () => {
  /*
   * A measurement with a consumer, so it is compared in the build rather than
   * only written down. `SIDE_USAGE_FIELD`'s doc argues for leaving the array
   * unbounded on the strength of this figure — a constant that encodes a
   * measurement drifts silently, and the argument would drift with it.
   *
   * The bound is one-sided on purpose: too *small* is not a hazard, so only the
   * unsafe direction fails. The record measured here is the **largest** shape
   * this code writes — every optional bucket present, a long model name, and a
   * fingerprint — which the doc quotes as 332 bytes.
   */
  const head = header()
  appendSideUsage(head, {
    usage: {
      inputTokens: 123_456,
      outputTokens: 7_890,
      cacheReadTokens: 654_321,
      cacheWriteTokens: 4_096,
      reasoningTokens: 2_048,
      totalTokens: 787_811,
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      at: 1_757_000_000_000,
      source: 'script',
    },
    caller: 'script.generateRaw',
    fingerprint: { promptHash: '0123456789abcdef', prefixHash: 'fedcba9876543210' },
  })
  const bytes = Buffer.byteLength(JSON.stringify(sideUsageFieldOf(head)[0]), 'utf8')
  assert.ok(
    bytes <= 332,
    `the largest record serialises to ${String(bytes)} bytes; SIDE_USAGE_FIELD's doc says 332 and uses that`
    + ' figure to argue the array can stay unbounded — update the doc and the argument together',
  )
})
