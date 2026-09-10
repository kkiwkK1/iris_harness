import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TurnUsage } from '@iris/protocol'

import { conversationUsage, sumUsage } from '../src/state.ts'
import { nextEvent, testClient } from './helpers.ts'

/**
 * What the fake tells the interface about token cost.
 *
 * The fake's job here is to make the interface meet all three cases before a
 * real provider does: a reply whose prompt was mostly served from cache, one
 * whose provider reported a cache and a hit of **zero**, and one that reports
 * nothing at all. Those are three different renderings — a rate, "0%", and no
 * line — and a fake that only carried the first would let two of them ship
 * unseen.
 *
 * The summing rule is asserted here as well as in the host, deliberately: this
 * package implements it a second time because its only dependency is
 * `@iris/protocol` (that is what lets the shell be built with no host), so the
 * two copies are held together by both being tested against the rule the
 * protocol writes down rather than by one calling the other.
 */

test('the seeded conversation carries every reporting shape at once', async () => {
  const client = testClient()
  const { view } = await client.call('chat.open', { chatId: 'chat-lamplighter' })

  // The greeting was copied from the card, never generated: no figure exists
  // and none may be invented.
  assert.equal(view.messages[0]?.usage, undefined)

  const cold = view.messages[2]
  assert.equal(cold?.role, 'assistant')
  // A provider that reports its cache and served none of this prompt from it.
  // Zero, present — which a surface must render as 0%, not as "no cache".
  assert.equal(cold?.usage?.cacheReadTokens, 0)
  assert.ok((cold?.usage?.reasoningTokens ?? 0) > 0, 'and a reasoning model was used')
  // Reasoning is part of the output count, not a bucket beside it.
  assert.ok((cold?.usage?.reasoningTokens ?? 0) < (cold?.usage?.outputTokens ?? 0))

  const cached = view.messages[4]
  assert.equal(cached?.role, 'assistant')
  assert.ok((cached?.usage?.cacheReadTokens ?? 0) > (cached?.usage?.inputTokens ?? 0),
    'most of this prompt came out of the cache, which is the ordinary long-chat case')

  // The fourth shape, behind a swipe: an endpoint that reports usage and says
  // nothing about caching. Absent, not zero — there is no rate to draw here at
  // all, and that is different from a rate of 0%.
  const swiped = await client.call('chat.swipe', { chatId: 'chat-lamplighter', turn: 1, index: 1 })
  const hidden = swiped.view.messages[2]
  assert.ok(hidden?.usage !== undefined)
  assert.equal('cacheReadTokens' in hidden.usage, false)
  assert.equal('totalTokens' in hidden.usage, false)

  client.dispose()
})

test('the seeded total counts a swipe nobody is looking at', async () => {
  const client = testClient()
  const { view } = await client.call('chat.open', { chatId: 'chat-lamplighter' })

  const shown = view.messages.flatMap(message => message.usage === undefined ? [] : [message.usage])
  const visible = conversationUsage(shown)
  assert.ok(visible !== undefined && view.usage !== undefined)
  // Strictly larger than the rows: one reading of turn 1 is hidden behind a
  // swipe and was still generated and charged. An implementation that summed
  // the rows would pass every other assertion in this file and fail here.
  assert.ok(view.usage.inputTokens > visible.inputTokens)
  assert.ok(view.usage.outputTokens > visible.outputTokens)
  // The hidden reading reported no cache bucket at all, so it contributes to
  // the required buckets and to neither optional one.
  assert.equal(view.usage.cacheReadTokens, visible.cacheReadTokens)
  assert.equal(view.usage.reasoningTokens, visible.reasoningTokens)
  // **No aggregate total, ever.** Summed under the optional-bucket rule it
  // would cover only the generations that reported one — on this seed, 5712
  // against buckets adding to 6064 + 826 — and would read as the total anyway.
  // A conversation reports the four buckets; a reader wanting one figure adds
  // the ones it is showing.
  assert.equal('totalTokens' in view.usage, false)

  client.dispose()
})

test('a conversation with no reported cost anywhere has no total', async () => {
  const client = testClient()
  const { view } = await client.call('chat.open', { chatId: 'chat-survey' })

  // The imported-history case: every request was made and answered, and
  // nothing recorded what it cost. The whole line must disappear.
  assert.equal(view.usage, undefined)
  assert.equal(view.messages.every(message => message.usage === undefined), true)

  client.dispose()
})

test('a generated reply arrives with a cost, and the total moves by it', async () => {
  const client = testClient()
  const before = (await client.call('chat.open', { chatId: 'chat-survey' })).view
  assert.equal(before.usage, undefined, 'this chat starts with nothing reported')

  await client.call('chat.send', { chatId: 'chat-survey', text: 'Show me the shoal.' })
  const end = await nextEvent(client, 'stream.end', 'chat-survey')

  const reply = end.view.messages.at(-1)
  assert.equal(reply?.role, 'assistant')
  assert.equal(reply?.streaming, undefined)
  const usage = reply?.usage
  assert.ok(usage !== undefined, 'the settled row carries what the generation cost')
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0)
  // Self-consistent arithmetic, not three unrelated numbers: the buckets are
  // disjoint and the row's total is their sum, so a surface computing a hit
  // rate from the fake gets a number in range.
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0))
  // One generation, so the conversation is that generation — minus the exact
  // total, which an aggregate never carries however many generations it holds.
  assert.deepEqual(end.view.usage, conversationUsage([usage]))
  assert.equal('totalTokens' in (end.view.usage ?? {}), false)

  client.dispose()
})

test('a generated reply is also clocked, in a shape a rate can be taken from', async () => {
  const client = testClient()
  await client.call('chat.send', { chatId: 'chat-survey', text: 'Show me the shoal.' })
  const end = await nextEvent(client, 'stream.end', 'chat-survey')

  const reply = end.view.messages.at(-1)
  const timing = reply?.generation
  assert.ok(timing !== undefined, 'the settled row carries how long the generation took')
  // The invariants a surface divides by. The failure guarded against is a
  // plausible-looking record that makes a nonsense rate: a zero duration
  // (infinite tokens per second), a first token at or after the end (a
  // negative decode window), a start that is not a moment.
  assert.ok(Number.isInteger(timing.startedAt) && timing.startedAt > 0)
  assert.ok(timing.durationMs > 0)
  assert.ok(timing.firstTokenMs !== undefined && timing.firstTokenMs > 0)
  assert.ok(timing.firstTokenMs < timing.durationMs, 'the first token arrived after the last one')
  // The moment is one reading, not two: the host stamps `sentAt` once and hands
  // the same number to both records, so a fake whose two objects disagreed
  // would let a surface be built on a difference that cannot occur.
  assert.equal(reply?.usage?.at, timing.startedAt)
  assert.equal(reply?.streaming, undefined, 'a settled row is not a streaming one')

  // The band, not the digits: a rate outside it would mean the fake's own
  // arithmetic has drifted to a number no provider produces, and the shell's
  // formatting thresholds are calibrated on this range.
  const rate = (reply?.usage?.outputTokens ?? 0) / (timing.durationMs / 1_000)
  assert.ok(rate > 1 && rate < 500, `the fake decodes at ${String(rate)} tok/s`)

  client.dispose()
})

test('the seeded turn has one reading with a stopwatch and one without', async () => {
  const client = testClient()
  const { view } = await client.call('chat.open', { chatId: 'chat-lamplighter' })

  // The shape a reloaded chat is in: the file carries one timer and it belongs
  // to the reading it was showing, so a turn's other swipes have a cost and no
  // speed. The interface must render that as no speed, not as zero.
  const shown = view.messages[2]
  assert.equal(shown?.role, 'assistant')
  assert.ok(shown?.generation !== undefined, 'the reading on screen has no timing')
  assert.ok(shown.usage !== undefined)

  const swiped = await client.call('chat.swipe', { chatId: 'chat-lamplighter', turn: 1, index: 1 })
  const other = swiped.view.messages[2]
  assert.ok(other?.usage !== undefined, 'the other reading was generated and billed')
  assert.equal(other.generation, undefined, 'and its timer is not in the file')

  client.dispose()
})

test('a regenerate adds to the total while the row shows only the new reading', async () => {
  const client = testClient()
  await client.call('chat.send', { chatId: 'chat-survey', text: 'Show me the shoal.' })
  const first = await nextEvent(client, 'stream.end', 'chat-survey')
  const firstUsage = first.view.messages.at(-1)?.usage
  assert.ok(firstUsage !== undefined)

  await client.call('chat.regenerate', { chatId: 'chat-survey' })
  const second = await nextEvent(client, 'stream.end', 'chat-survey')
  const row = second.view.messages.at(-1)
  assert.deepEqual(row?.swipes, { count: 2, index: 1 })

  const secondUsage = row?.usage
  assert.ok(secondUsage !== undefined)
  // The row is the reading on screen. The total is both readings, because both
  // were generated — this is the pair of assertions the feature is for.
  assert.deepEqual(second.view.usage, conversationUsage([firstUsage, secondUsage]))
  assert.notDeepEqual(second.view.usage, secondUsage)

  client.dispose()
})

test('an unreported bucket is never summed as a zero', () => {
  const reported: TurnUsage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 }
  const silent: TurnUsage = { inputTokens: 20, outputTokens: 2 }

  const total = sumUsage([reported, silent])

  assert.deepEqual(total, { inputTokens: 30, outputTokens: 3, cacheReadTokens: 90 })
  // `sumUsage` is the arithmetic and keeps a total when one was reported;
  // `conversationUsage` is the ruling and never does. Both are asserted, or
  // the two would be free to become the same function again.
  assert.equal(sumUsage([{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }])?.totalTokens, 2)
  assert.equal('totalTokens' in (conversationUsage([{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }]) ?? {}), false)
  // Not `cacheWriteTokens: 0`: neither generation said anything about a cache
  // write, and a rate computed over a zero-filled bucket makes a claim about
  // providers that never spoke.
  assert.equal('cacheWriteTokens' in (total ?? {}), false)
  assert.equal(sumUsage([]), undefined, 'and nothing at all sums to nothing')
})
