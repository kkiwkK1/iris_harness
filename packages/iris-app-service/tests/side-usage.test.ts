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
  appendSideUsage, parseSideUsage, readSideUsage, scriptUsage,
  SIDE_USAGE_FIELD, sideUsageFieldOf,
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

test('the array’s location decides the source, not the stored field', () => {
  /*
   * A record in this array claiming to be a turn would move a card's spend into
   * the turn column, which is exactly the reading the split exists to make
   * possible. The location is the authority; the field is written so the file
   * says what it holds to a reader that is not this code.
   */
  const lying = parseSideUsage({
    inputTokens: 10,
    outputTokens: 2,
    source: 'turn',
    caller: 'script.generate',
  })
  assert.equal(lying?.usage.source, 'script')

  // And a record with no `source` at all — which a hand-written file has —
  // still reads as a card's.
  const bare = parseSideUsage({ inputTokens: 10, outputTokens: 2, caller: 'script.generate' })
  assert.equal(bare?.usage.source, 'script')
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
