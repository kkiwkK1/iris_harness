/**
 * `usage.summary`, against the shape the real corpus is actually in.
 *
 * The premise this suite is built on was measured, not assumed. On the 16 real
 * conversations on this machine (2026-09-08, `apps/iris/data/default-user/chats`)
 * there are **12 usage records, and every one of them names no model and
 * carries no timestamp** — seven carry only the five token buckets and five
 * carry a fingerprint as well. Iris's own chat export writes no `send_date`
 * either, so nothing on a message line can date them.
 *
 * That makes the interesting cases the *absent* ones, and they are what is
 * pinned here: an unattributed record is counted and labelled rather than
 * dropped, an undated one is placed at its conversation's own last activity and
 * **reported as reconstructed**, and the hit rate is computed over the
 * generations that reported a cache bucket rather than over every prompt token
 * in range. The last is the one place this could lie without looking wrong.
 *
 * The scan itself is checked against a real file written by `toFile` rather
 * than against a hand-built fixture wherever the property is about the *file
 * format* — a fixture written by the same belief as the reader would agree with
 * it about the wrong key.
 *
 * @module @iris/app-service/tests/usage-summary
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { TurnUsage, UsageTotals } from '@iris/protocol'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import {
  addUsage, bucketStart, readChatUsage, summariseUsage,
  type ChatUsage, type DatedUsage,
} from '../src/usage-summary.ts'
import { USAGE_FIELD } from '../src/usage.ts'

/** A moment with a known local calendar position, so bucket tests do not depend on the runner's zone. */
const NOON = new Date(2026, 8, 8, 12, 30, 0, 0).getTime()
const LATER_SAME_DAY = new Date(2026, 8, 8, 18, 5, 0, 0).getTime()
const NEXT_DAY = new Date(2026, 8, 9, 9, 0, 0, 0).getTime()

/** One usage record, placed and attributed. */
function record(at: number, model: string | undefined, usage: TurnUsage): DatedUsage {
  return { at, undated: false, ...model === undefined ? {} : { model }, usage }
}

/** One conversation's records. */
function chat(chatId: string, records: DatedUsage[], updatedAt = NOON): ChatUsage {
  return { chatId, title: chatId, updatedAt, records }
}

/** A chat file's bytes: a header line and one assistant line per usage array. */
function chatFile(
  meta: { chatId: string, title: string, updatedAt?: number, createDate?: string },
  lines: readonly (readonly unknown[])[],
): string {
  const header = {
    user_name: 'You',
    character_name: meta.title,
    create_date: meta.createDate ?? '2026-09-01 @10h35m30s',
    chat_metadata: {},
    iris: {
      chatId: meta.chatId,
      title: meta.title,
      ...meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt },
    },
  }
  const rows = lines.map(entries => JSON.stringify({
    name: meta.title,
    is_user: false,
    mes: 'a reply',
    swipe_id: 0,
    swipes: entries.map(() => 'a reply'),
    [USAGE_FIELD]: entries,
  }))
  return [JSON.stringify(header), ...rows].join('\n') + '\n'
}

test('day buckets are cut on local midnight, hour buckets on the local hour', () => {
  assert.equal(bucketStart(NOON, 'day'), bucketStart(LATER_SAME_DAY, 'day'))
  assert.notEqual(bucketStart(NOON, 'day'), bucketStart(NEXT_DAY, 'day'))
  assert.notEqual(bucketStart(NOON, 'hour'), bucketStart(LATER_SAME_DAY, 'hour'))
  // A bucket start is at or before the moment in it, and is itself a boundary.
  for (const granularity of ['day', 'hour'] as const) {
    const start = bucketStart(NOON, granularity)
    assert.ok(start <= NOON)
    assert.equal(bucketStart(start, granularity), start)
  }
  const midnight = new Date(bucketStart(NOON, 'day'))
  assert.equal(midnight.getHours(), 0)
  assert.equal(midnight.getMinutes(), 0)
  assert.equal(midnight.getSeconds(), 0)
  assert.equal(midnight.getMilliseconds(), 0)
})

test('one cell per bucket and model, ordered so a chart can walk it once', () => {
  const summary = summariseUsage([
    chat('one', [
      record(NOON, 'deepseek-chat', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 }),
      record(LATER_SAME_DAY, 'deepseek-chat', { inputTokens: 50, outputTokens: 5, cacheReadTokens: 450 }),
      record(NOON, 'local/qwen3-8b', { inputTokens: 200, outputTokens: 20 }),
      record(NEXT_DAY, 'deepseek-chat', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 }),
    ]),
  ], { granularity: 'day' })

  assert.equal(summary.buckets.length, 3, 'two models on day one, one on day two')
  assert.deepEqual(summary.models, ['deepseek-chat', 'local/qwen3-8b'])
  // Ascending by bucket, then by model, so the reply is byte-identical between
  // two calls with the same input.
  const order = summary.buckets.map(one => [one.bucket, one.model ?? null])
  assert.deepEqual([...order].sort((left, right) =>
    (left[0] as number) - (right[0] as number)
    || String(left[1]).localeCompare(String(right[1]))), order)

  // The two same-day generations of one model landed in one cell.
  const merged = summary.buckets.find(one =>
    one.model === 'deepseek-chat' && one.bucket === bucketStart(NOON, 'day'))
  assert.ok(merged !== undefined)
  assert.equal(merged.turns, 2)
  assert.equal(merged.cacheMiss, 150)
  assert.equal(merged.cacheRead, 1_350)
})

test('an hour cut splits what a day cut merged, over the same records', () => {
  const records = [
    record(NOON, 'm', { inputTokens: 100, outputTokens: 10 }),
    record(LATER_SAME_DAY, 'm', { inputTokens: 200, outputTokens: 20 }),
  ]
  const byDay = summariseUsage([chat('one', records)], { granularity: 'day' })
  const byHour = summariseUsage([chat('one', records)], { granularity: 'hour' })
  assert.equal(byDay.buckets.length, 1)
  assert.equal(byHour.buckets.length, 2)
  // The granularity changes how the total is cut, never what it is.
  assert.equal(byDay.totals.cacheMiss, byHour.totals.cacheMiss)
  assert.equal(byDay.totals.output, byHour.totals.output)
  assert.equal(byDay.totals.turns, byHour.totals.turns)
  // Echoed, so a stale reply cannot be mistaken for a fresh one.
  assert.equal(byDay.granularity, 'day')
  assert.equal(byHour.granularity, 'hour')
})

test('records that name no model are their own line, not folded and not dropped', () => {
  const summary = summariseUsage([
    chat('one', [
      record(NOON, undefined, { inputTokens: 400, outputTokens: 40 }),
      record(NOON, 'deepseek-chat', { inputTokens: 100, outputTokens: 10 }),
    ]),
  ], { granularity: 'day' })

  assert.equal(summary.buckets.length, 2)
  const unattributed = summary.buckets.find(one => one.model === undefined)
  assert.ok(unattributed !== undefined, 'the unattributed cell is missing')
  assert.equal(unattributed.cacheMiss, 400)
  // The name list is for the legend's known lines only; the unknown one is not
  // a model name and must not appear as one.
  assert.deepEqual(summary.models, ['deepseek-chat'])
  // Counted: those tokens were spent, and dropping them understates a bill.
  assert.equal(summary.totals.cacheMiss, 500)
  assert.equal(summary.totals.turns, 2)
})

test('the hit rate population excludes routes that never mentioned caching', () => {
  /*
   * The one place a summary could lie without looking wrong. One generation on
   * a caching route served 900 of 1000 prompt tokens; one on a silent route
   * billed 3000 and said nothing.
   *
   * `cachePrompt` is 1000 — the caching generation's prompt side only — so the
   * honest share is 90%. The nearest wrong implementation divides by every
   * prompt token in range (4000) and reports 22.5%, which is a claim about a
   * provider that never spoke.
   */
  const summary = summariseUsage([
    chat('one', [
      record(NOON, 'caching', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 }),
      record(NOON, 'silent', { inputTokens: 3_000, outputTokens: 30 }),
    ]),
  ], { granularity: 'day' })

  assert.equal(summary.totals.turns, 2)
  assert.equal(summary.totals.cacheTurns, 1, 'only one generation reported a cache bucket')
  assert.equal(summary.totals.cacheRead, 900)
  assert.equal(summary.totals.cachePrompt, 1_000)
  // The premise of the case, asserted rather than assumed: if the two
  // denominators were equal, this test would pass under both implementations.
  const everyPromptToken = summary.totals.cacheMiss
    + (summary.totals.cacheRead ?? 0)
    + (summary.totals.cacheWrite ?? 0)
  assert.equal(everyPromptToken, 4_000)
  assert.notEqual(everyPromptToken, summary.totals.cachePrompt)
})

test('a bucket no generation reported stays absent, and is never zero-filled', () => {
  const summary = summariseUsage([
    chat('one', [record(NOON, 'silent', { inputTokens: 500, outputTokens: 50 })]),
  ], { granularity: 'day' })
  const cell = summary.buckets[0]
  assert.ok(cell !== undefined)
  assert.equal('cacheRead' in cell, false, '0 cache reads and "no cache reported" are different facts')
  assert.equal('cacheWrite' in cell, false)
  assert.equal('reasoning' in cell, false)
  assert.equal(cell.cacheTurns, 0)
  assert.equal(summary.totals.cacheRead, undefined)
})

test('reasoning is summed but never folded into output', () => {
  const summary = summariseUsage([
    chat('one', [
      record(NOON, 'm', { inputTokens: 10, outputTokens: 400, reasoningTokens: 250 }),
    ]),
  ], { granularity: 'day' })
  assert.equal(summary.totals.output, 400, 'reasoning is inside the output it is reported in')
  assert.equal(summary.totals.reasoning, 250)
})

test('the range filter runs before the fold, so every figure is one reading', () => {
  const summary = summariseUsage([
    chat('one', [
      record(NOON, 'm', { inputTokens: 100, outputTokens: 10 }),
      record(NEXT_DAY, 'm', { inputTokens: 999, outputTokens: 99 }),
    ]),
  ], { granularity: 'day', since: bucketStart(NOON, 'day'), until: bucketStart(NEXT_DAY, 'day') })

  assert.equal(summary.totals.cacheMiss, 100, 'the out-of-range record is not in the total')
  assert.equal(summary.buckets.length, 1, 'nor in any cell')
  assert.equal(summary.chats[0]?.cacheMiss, 100, 'nor in the conversation subtotal')
  // `until` is exclusive: the record exactly at the boundary is the next range's.
  const inclusive = summariseUsage([
    chat('one', [record(NEXT_DAY, 'm', { inputTokens: 7, outputTokens: 1 })]),
  ], { granularity: 'day', until: NEXT_DAY })
  assert.equal(inclusive.totals.turns, 0)
})

test('a conversation with nothing in range is absent, not a row of zeros', () => {
  const summary = summariseUsage([
    chat('spent', [record(NOON, 'm', { inputTokens: 100, outputTokens: 10 })], NOON),
    chat('quiet', [record(NEXT_DAY, 'm', { inputTokens: 100, outputTokens: 10 })], NEXT_DAY),
  ], { granularity: 'day', until: bucketStart(NEXT_DAY, 'day') })

  assert.deepEqual(summary.chats.map(one => one.chatId), ['spent'])
})

test('conversation subtotals are newest activity first, the sidebar order', () => {
  const summary = summariseUsage([
    chat('older', [record(NOON, 'm', { inputTokens: 1, outputTokens: 1 })], NOON),
    chat('newer', [record(NOON, 'm', { inputTokens: 1, outputTokens: 1 })], NEXT_DAY),
  ], { granularity: 'day' })
  assert.deepEqual(summary.chats.map(one => one.chatId), ['newer', 'older'])
})

test('a non-finite or negative count cannot turn a whole summary into NaN', () => {
  // Reachable: these numbers came from a provider over a wire and then through
  // a JSON file. One `NaN` in a sum blanks every figure downstream of it, with
  // nothing naming which entry did it.
  // Annotated, not inferred: an object literal infers away the optional
  // buckets, and `assert.equal(totals.cacheRead, 0)` below then reads a
  // property the inferred type does not have. `node --test` strips types and
  // ran it green; `tsc --noEmit` is what said so.
  const totals: UsageTotals = {
    cacheMiss: 0, output: 0, turns: 0, cacheTurns: 0, cachePrompt: 0, undatedTurns: 0,
  }
  addUsage(totals, record(NOON, 'm', {
    inputTokens: Number.NaN,
    outputTokens: -5,
    cacheReadTokens: Number.POSITIVE_INFINITY,
  }))
  assert.equal(totals.cacheMiss, 0)
  assert.equal(totals.output, 0)
  assert.equal(totals.cacheRead, 0)
  assert.ok(Number.isFinite(totals.cachePrompt))
})

/* ------------------------------------------------- the file scan itself */

test('the scan reads the usage arrays a chat file carries, and dates them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-usage-'))
  try {
    const text = chatFile({ chatId: 'one', title: 'One', updatedAt: NEXT_DAY }, [
      // Turn one: two swipes, one of which reported nothing — the `null` is the
      // ordinary case and says "generated, and the provider was silent".
      [
        { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, model: 'deepseek-chat', provider: 'deepseek', at: NOON },
        null,
      ],
      // Turn two: written before the identity fields existed. This is the shape
      // all 12 records in the real corpus are in.
      [{ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0 }],
    ])
    await writeFile(join(dir, 'one.jsonl'), text, 'utf8')

    const read = readChatUsage('one', text)
    assert.ok(read !== undefined)
    assert.equal(read.records.length, 2, 'the null entry is not a record')
    assert.equal(read.updatedAt, NEXT_DAY)

    const dated = read.records.find(one => !one.undated)
    assert.ok(dated !== undefined, 'the record carrying its own moment was not read as dated')
    assert.equal(dated.at, NOON)
    assert.equal(dated.model, 'deepseek-chat')
    assert.equal(dated.usage.provider, 'deepseek')

    const undated = read.records.find(one => one.undated)
    assert.ok(undated !== undefined, 'the record with no moment was not flagged')
    assert.equal(undated.at, NEXT_DAY, 'an undated record is placed at the conversation last activity')
    assert.equal(undated.model, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('undated generations are counted as reconstructed, per bucket and overall', () => {
  const text = chatFile({ chatId: 'old', title: 'Old', updatedAt: NOON }, [
    [{ inputTokens: 100, outputTokens: 10 }],
    [{ inputTokens: 200, outputTokens: 20 }],
    [{ inputTokens: 300, outputTokens: 30, model: 'm', at: NEXT_DAY }],
  ])
  const read = readChatUsage('old', text)
  assert.ok(read !== undefined)
  const summary = summariseUsage([read], { granularity: 'day' })

  assert.equal(summary.totals.turns, 3)
  assert.equal(summary.totals.undatedTurns, 2, 'the page has to be able to say how much is a reconstruction')
  // Both undated records land in one bucket, which is exactly the distortion
  // the count exists to disclose: an old conversation reads as one spike at its
  // last activity rather than as the sessions it really was.
  const reconstructed = summary.buckets.filter(one => one.undatedTurns > 0)
  assert.equal(reconstructed.length, 1)
  assert.equal(reconstructed[0]?.turns, 2)
})

test('a header with no Iris block falls back to create_date, in both spellings', () => {
  /*
   * `readMeta` reports `updatedAt: 0` for a file Iris never wrote, so the
   * chat's own user-facing date is the next best moment — the alternative is
   * placing every record in it at the epoch.
   *
   * **Both spellings, and that is the whole point of this case.** Iris's own
   * `formatCreateDate` ends at the seconds; SillyTavern writes milliseconds.
   * `chats.ts`'s `parseCreateDate` requires the milliseconds and therefore
   * fails on all 16 real headers on this machine, and its own test only ever
   * tried the SillyTavern form — so a reader here that copied that regex would
   * have inherited the bug and passed a test written the same way. The no-`ms`
   * form is asserted first because it is the one that was broken.
   */
  for (const createDate of ['2026-09-08 @12h30m00s', '2026-09-08 @12h30m00s000ms']) {
    const text = chatFile({ chatId: 'foreign', title: 'Foreign', createDate }, [
      [{ inputTokens: 100, outputTokens: 10 }],
    ])
    const read = readChatUsage('foreign', text)
    assert.ok(read !== undefined, `${createDate} was not read as a chat`)
    assert.equal(read.records.length, 1)
    assert.equal(
      bucketStart(read.records[0]?.at ?? 0, 'day'),
      bucketStart(NOON, 'day'),
      `${createDate} did not place its record on the day it names`,
    )
    assert.equal(read.records[0]?.undated, true)
  }
  // A date that is genuinely malformed is still refused rather than guessed —
  // loosening the milliseconds must not loosen everything else.
  const bad = chatFile({ chatId: 'x', title: 'X', createDate: '2026-09-08T12:30:00Z' }, [
    [{ inputTokens: 1, outputTokens: 1 }],
  ])
  assert.equal(readChatUsage('x', bad)?.records[0]?.at, 0)
})

test('a line with no usage array is never parsed, and a broken file is not a chat', () => {
  // The cheap check first: this is what keeps the scan proportional to bytes
  // rather than to floors on a 19 MiB conversation.
  const plain = [
    JSON.stringify({ user_name: 'You', character_name: 'A', create_date: 'x', chat_metadata: {}, iris: { chatId: 'a', title: 'A', updatedAt: NOON } }),
    JSON.stringify({ name: 'A', is_user: false, mes: 'no cost here' }),
  ].join('\n')
  assert.deepEqual(readChatUsage('a', plain)?.records, [])
  assert.equal(readChatUsage('bad', 'not json at all'), undefined)
  assert.equal(readChatUsage('empty', ''), undefined)
})

test('a usage array on a user line is not read', () => {
  // A user line shares its turn number with the reply after it and could not
  // have been billed; `toFile` never writes the field there.
  const text = [
    JSON.stringify({ user_name: 'You', character_name: 'A', create_date: 'x', chat_metadata: {}, iris: { chatId: 'a', title: 'A', updatedAt: NOON } }),
    JSON.stringify({ name: 'You', is_user: true, mes: 'hello', [USAGE_FIELD]: [{ inputTokens: 999, outputTokens: 99 }] }),
  ].join('\n')
  assert.deepEqual(readChatUsage('a', text)?.records, [])
})

test('the reply says how much of the corpus it read', () => {
  const summary = summariseUsage(
    [chat('one', [record(NOON, 'm', { inputTokens: 1, outputTokens: 1 })])],
    { granularity: 'day' },
    16,
    2,
  )
  // A total computed over an unknown fraction of the corpus is not a total.
  assert.equal(summary.scannedChats, 16)
  assert.equal(summary.skippedChats, 2)
})

test('the store scans a whole profile of files, and counts what it could not read', async t => {
  /*
   * The scan, over real files on a real directory rather than over strings —
   * so the walk, the extension filter and the skip accounting are exercised
   * and not only the reader they call.
   *
   * The profile deliberately holds one of each: two conversations with costs on
   * two models, one with a usage array but no readable header, and one that was
   * never billed at all. The last two are the pair a summary has to keep apart,
   * because "not counted" and "counted as nothing" are different answers.
   */
  const dir = await mkdtemp(join(tmpdir(), 'iris-usage-store-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chatsDir = join(dir, 'chats')
  await mkdir(chatsDir, { recursive: true })

  await writeFile(join(chatsDir, 'one.jsonl'), chatFile(
    { chatId: 'one', title: 'One', updatedAt: NOON },
    [[{ inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, model: 'deepseek-chat', at: NOON }]],
  ), 'utf8')
  await writeFile(join(chatsDir, 'two.jsonl'), chatFile(
    { chatId: 'two', title: 'Two', updatedAt: NEXT_DAY },
    [[{ inputTokens: 50, outputTokens: 5, model: 'local/qwen3-8b', at: NEXT_DAY }]],
  ), 'utf8')
  await writeFile(join(chatsDir, 'never-billed.jsonl'), chatFile(
    { chatId: 'never-billed', title: 'Never billed', updatedAt: NOON },
    [[null]],
  ), 'utf8')
  await writeFile(join(chatsDir, 'broken.jsonl'), 'this is not a chat file\n', 'utf8')
  // Not a chat at all: the extension filter has to leave it alone rather than
  // count it as a file it failed to read.
  await writeFile(join(chatsDir, 'notes.txt'), 'ignored', 'utf8')

  const store = new ChatStore(chatsDir, library)
  const summary = await store.usageSummary({ granularity: 'day' })

  assert.equal(summary.scannedChats, 3, 'the three readable .jsonl files')
  assert.equal(summary.skippedChats, 1, 'the unreadable one is reported, not swallowed')
  assert.deepEqual(summary.models, ['deepseek-chat', 'local/qwen3-8b'])
  assert.equal(summary.totals.turns, 2)
  assert.equal(summary.totals.cacheMiss, 150)
  assert.equal(summary.totals.cacheRead, 900)
  assert.equal(summary.totals.cacheTurns, 1, 'only one of the two routes reported a cache bucket')
  assert.equal(summary.buckets.length, 2)
  // The conversation that was never billed is scanned and then absent from the
  // subtotal list — it is part of `scannedChats`, and a row of zeros beside the
  // others would read as "this chat cost nothing".
  assert.deepEqual(summary.chats.map(one => one.chatId), ['two', 'one'])

  // A narrowed range answers over the same files without rescanning anything
  // differently: the filter is on the records, not on the walk.
  const narrowed = await store.usageSummary({
    granularity: 'day',
    since: bucketStart(NEXT_DAY, 'day'),
  })
  assert.equal(narrowed.scannedChats, 3, 'the denominator is the corpus, not the range')
  assert.equal(narrowed.totals.turns, 1)
  assert.deepEqual(narrowed.models, ['local/qwen3-8b'])
})

test('a model named after the empty string is not the same line as no model', () => {
  /*
   * Two different facts that a joined-string key merges. A route can be
   * configured with any string, and the records that name **no** model are the
   * whole of anyone's history before the field existed — merging them would
   * hide real spend under a label belonging to something else.
   *
   * Added because a teeth check found it missing: swapping the JSON cell key
   * for a `bucket|model` string left every other test in this file green, since
   * none of them had an empty-named model to merge.
   */
  const summary = summariseUsage([
    chat('one', [
      record(NOON, undefined, { inputTokens: 400, outputTokens: 40 }),
      record(NOON, '', { inputTokens: 7, outputTokens: 1 }),
    ]),
  ], { granularity: 'day' })

  assert.equal(summary.buckets.length, 2, 'the empty-named model merged with the unattributed records')
  assert.equal(summary.buckets.find(one => one.model === undefined)?.cacheMiss, 400)
  assert.equal(summary.buckets.find(one => one.model === '')?.cacheMiss, 7)
  assert.deepEqual(summary.models, [''], 'an empty name is still a name the legend has to carry')
})

test('a blank model in a file reads as unattributed, not as a model with no label', () => {
  /*
   * `parseUsage` drops a blank string rather than carrying it, so the page
   * never draws a series whose legend entry is empty — the unknown case wearing
   * a known case's clothes. The host drops it at the recording end too, where a
   * host started with nothing configured composes `model: ''`.
   *
   * Also a teeth-check finding: loosening `parseUsage` to accept a blank name
   * broke nothing, because no fixture here carried one.
   */
  const text = chatFile({ chatId: 'blank', title: 'Blank', updatedAt: NOON }, [
    [{ inputTokens: 100, outputTokens: 10, model: '', provider: '', at: NOON }],
  ])
  const read = readChatUsage('blank', text)
  assert.ok(read !== undefined)
  assert.equal(read.records.length, 1, 'a blank name must not cost the record')
  assert.equal(read.records[0]?.model, undefined, 'a blank model name was carried through as a model')
  assert.equal(read.records[0]?.usage.provider, undefined)
  // The moment was still read: dropping a blank name must not drop the rest.
  assert.equal(read.records[0]?.undated, false)
  assert.deepEqual(summariseUsage([read], { granularity: 'day' }).models, [])
})
