import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

import { mapUsage, type WireUsage } from '../src/translate.ts'

/**
 * `mapUsage`' return, as it actually is at runtime.
 *
 * The installed `@deepseek-ai/dsh-llm` (0.1.1-rc.2) declares `TokenUsage`
 * **without** `totalTokens`, while `mapUsage` produces the field and both
 * `@iris/protocol`'s `TurnUsage` and the shell's formatter carry it — the
 * newer harness release added it to the type. Spread into an object literal it
 * escapes excess-property checking, so nothing type-checks that plumbing
 * today; reading it here through a widened type keeps the test honest about
 * what the function returns rather than about what its signature admits.
 */
type MappedUsage = TokenUsage & { totalTokens?: number }

/** `mapUsage` under the shape it really returns. */
function mapped(usage: WireUsage): MappedUsage {
  return mapUsage(usage)
}

/**
 * What one generation cost, as this adapter reports it upwards.
 *
 * Two invariants, and they pull in opposite directions. The prompt-side
 * buckets must be **disjoint** — `inputTokens` excludes what the cache served,
 * so a hit rate is `cacheReadTokens / (inputTokens + cacheReadTokens)` and
 * nothing has to know which endpoint answered. And an unreported bucket must
 * stay **absent**: `0` is a measurement ("the cache did not help this time")
 * while absence is the lack of one ("this provider says nothing about cache"),
 * and the surface that shows a cache-hit share has to tell those apart or it
 * will draw 0% for every endpoint that has no cache to speak of.
 *
 * The hit count is read from two field names because one adapter serves both
 * dialects — see `WireUsage`.
 */

test('DeepSeek native cache hit alone is read, and subtracted out', () => {
  // Only the native spelling, which is what a DeepSeek response looks like to
  // a reader that never learned `prompt_tokens_details`.
  const usage = mapped({
    prompt_tokens: 1_000,
    prompt_cache_hit_tokens: 768,
    prompt_cache_miss_tokens: 232,
    completion_tokens: 50,
  })

  assert.equal(usage.cacheReadTokens, 768)
  // 1000 - 768: the buckets are disjoint, so the two prompt-side numbers add
  // back up to what the wire called `prompt_tokens`.
  assert.equal(usage.inputTokens, 232)
  assert.equal(usage.outputTokens, 50)
  // The total stays the wire's own aggregate, cache included; it is not the sum
  // of the disjoint buckets minus anything.
  assert.equal(usage.totalTokens, 1_050)
})

test('the compat spelling wins when both are present', () => {
  // A real DeepSeek response carries both. They agree there, so the ordering
  // only becomes visible when they are made to disagree — which is why this
  // fixture does.
  const usage = mapped({
    prompt_tokens: 1_000,
    prompt_tokens_details: { cached_tokens: 640 },
    prompt_cache_hit_tokens: 768,
    completion_tokens: 50,
  })

  assert.equal(usage.cacheReadTokens, 640)
  assert.equal(usage.inputTokens, 360)
})

test('neither spelling means the field is absent, not zero', () => {
  const usage = mapped({ prompt_tokens: 1_000, completion_tokens: 50 })

  // `deepEqual` on the whole object rather than a check per field: the failure
  // this guards against is a `?? 0` somewhere in the mapping, and that lands as
  // an extra key rather than as a wrong value on a key already asserted.
  assert.deepEqual(usage, { inputTokens: 1_000, outputTokens: 50, totalTokens: 1_050 })
  assert.equal('cacheReadTokens' in usage, false)
  assert.equal('reasoningTokens' in usage, false)
})

test('a zero hit count is a measurement and survives as one', () => {
  // The other side of the rule above: an endpoint that reports a cache and had
  // no hit this call must not be folded into "reports no cache".
  const usage = mapped({
    prompt_tokens: 1_000,
    prompt_cache_hit_tokens: 0,
    completion_tokens: 50,
  })

  assert.equal(usage.cacheReadTokens, 0)
  assert.equal(usage.inputTokens, 1_000)
})
