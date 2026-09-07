/**
 * What each generation cost, kept per candidate and carried in the chat file.
 *
 * The provider reports this once per call and it is the only exact number in
 * the whole prompt pipeline — everything else here is an estimate. Upstream
 * SillyTavern stores its own *estimate* per message (`extra.token_count`,
 * written by `getTokenCountAsync`) and shows that; it never records what the
 * provider said it charged, so cache hits — the thing that decides what a long
 * chat actually costs on DeepSeek — are invisible there. This module is the
 * storage half of showing them.
 *
 * **A candidate, not a message.** A turn's swipes are separate generations that
 * were each paid for, so the cost belongs to the candidate exactly as its
 * variable table does (`@iris/variables`' message scope). That is also what
 * makes "everything this conversation ever cost" answerable: the losing swipes
 * are still in the log.
 *
 * @module @iris/app-service/usage
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SillyTavernMessage } from '@iris/persistence'
import type { TurnUsage } from '@iris/protocol'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * What the provider charged for one candidate.
     *
     * Keyed by `candidateSeq` like `iris/variables`, and for the same reason: a
     * swipe is a generation, and its cost cannot be recovered from the text.
     * Appended once when the generation settles; a second append for the same
     * candidate is a correction and the newest one is read (the log never
     * rewrites what it already said).
     */
    'iris/usage': {
      /** Seq of the `assistant/message` event this generation produced. */
      candidateSeq: number
      usage: TurnUsage
    }
  }
}

/**
 * Where a chat file carries this, and why it is not inside `extra`.
 *
 * A **top-level** key holding an array parallel to `swipes`, which is where
 * this file format already keeps per-swipe state: TavernHelper's `variables`
 * sits in exactly that shape and this host already writes and hydrates it.
 *
 * `extra` was the obvious first choice and it is measurably the wrong one.
 * SillyTavern treats `extra` as **per-swipe state that it swaps wholesale**:
 * `syncSwipeToMes` assigns `targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {}`
 * (public/script.js), and each swipe's copy is archived into
 * `swipe_info[i].extra` when a reply lands. So one swipe in SillyTavern
 * replaces the whole `extra` object with an archived copy that predates us —
 * an array parked there would be deleted, and a single object parked there
 * would need `swipe_info` entries this host does not model at all. Neither
 * failure would say anything; the numbers would simply be gone.
 *
 * Meanwhile SillyTavern's own core never reads or writes a top-level key it
 * does not know (its swipe swap touches `mes`, `send_date`, `gen_started`,
 * `gen_finished` and `extra`, and nothing else), so a top-level array survives
 * being carried through an install that has never heard of Iris. It also never
 * collides with `extra.token_count`, which stays exactly as SillyTavern wrote
 * it: that is SillyTavern's estimate of the *text*, a different measurement by
 * a different measurer, and overwriting it would corrupt the one number their
 * UI shows.
 *
 * The residual, stated because it is real: SillyTavern's swipe **deletion**
 * splices `swipes` and `swipe_info` and knows nothing about parallel arrays, so
 * deleting a swipe there leaves this array one entry too long and shifted. That
 * is the same residual `variables` already carries in the same file, so the
 * choice adds no new failure mode — and a surplus entry is dropped with a
 * report rather than silently reattached to the wrong swipe.
 */
export const USAGE_FIELD = 'iris_usage'

/**
 * The newest usage recorded for each candidate.
 * @param session - the chat log.
 * @returns cost by candidate seq; candidates that reported none are absent.
 */
export function usageBySeq(session: Session): Map<number, TurnUsage> {
  const usages = new Map<number, TurnUsage>()
  for (const event of session.events) {
    if (event.type === 'iris/usage') usages.set(event.data.candidateSeq, event.data.usage)
  }
  return usages
}

/** The optional buckets, in the order a reader meets them on the type. */
const OPTIONAL_BUCKETS = ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/**
 * Add up what several generations cost.
 *
 * The two required buckets sum plainly. An **optional** bucket is summed only
 * over the generations that reported it, and stays absent when none did —
 * because absence and zero are different facts here and only one of them may
 * feed a cache-hit rate. Folding an unreported bucket in as `0` would let a
 * conversation with one cache-reporting reply and nine silent ones read as
 * "10% of this was cached", which is a claim about the nine.
 *
 * `totalTokens` is summed here under the same rule as the other optional
 * buckets, which makes it "the totals we were given, added up" rather than
 * "the total" — a distinction {@link conversationUsage} refuses to ship, for
 * the reason given there. This function is the arithmetic; the ruling about
 * which buckets a *conversation* may show lives one layer up.
 * @param usages - one entry per generation.
 * @returns the sum, or `undefined` when there was nothing to add.
 */
export function sumUsage(usages: Iterable<TurnUsage>): TurnUsage | undefined {
  let seen = false
  const total: TurnUsage = { inputTokens: 0, outputTokens: 0 }
  const optional = new Map<typeof OPTIONAL_BUCKETS[number], number>()

  for (const usage of usages) {
    seen = true
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    for (const bucket of OPTIONAL_BUCKETS) {
      const value = usage[bucket]
      if (value === undefined) continue
      optional.set(bucket, (optional.get(bucket) ?? 0) + value)
    }
  }

  if (!seen) return undefined
  for (const [bucket, value] of optional) total[bucket] = value
  return total
}

/**
 * What a whole conversation cost, in the four buckets it may show.
 *
 * {@link sumUsage} with **`totalTokens` dropped, always** — a ruling rather
 * than an optimisation. Summed under the optional-bucket rule, an aggregate
 * total covers only the generations that carried an exact one, so on any
 * conversation that mixed providers it comes out *smaller* than the buckets
 * printed beside it (measured on the fake's own seed: 5712 against 6064 + 826).
 * A field named `totalTokens` sitting next to four buckets it does not total is
 * a number every consumer reads wrong, and reading it wrong is invisible —
 * nothing is missing and nothing throws.
 *
 * So a conversation reports the four buckets and no total. A reader that wants
 * one adds the buckets it is showing, which is a sum it can defend. **One
 * generation** keeps its `totalTokens`, because there the provider's own
 * aggregate is exactly what it claims to be — see `MessageView.usage`.
 * @param usages - one entry per generation the conversation paid for.
 * @returns the sum without `totalTokens`, or `undefined` when there was nothing
 *   to add.
 */
export function conversationUsage(usages: Iterable<TurnUsage>): TurnUsage | undefined {
  const total = sumUsage(usages)
  if (total === undefined) return undefined
  const { totalTokens: _neverAggregated, ...buckets } = total
  return buckets
}

/**
 * Read one entry of a file's usage array.
 *
 * Strict about the two required numbers and about each optional one
 * separately: a bucket that is not a finite number is dropped rather than
 * carried, because a `null` or a string reaching {@link sumUsage} would produce
 * a total that is `NaN` or a concatenated string — a wrong number rather than a
 * missing one, and the arithmetic would go out on the wire looking like a
 * measurement.
 * @param value - one array entry from the file.
 * @returns the usage, or `undefined` when the entry carries none.
 */
export function parseUsage(value: unknown): TurnUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const input = record['inputTokens']
  const output = record['outputTokens']
  // Both required buckets or nothing. A half-read usage would understate a
  // conversation's cost while looking like a complete reading of it.
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined
  if (typeof output !== 'number' || !Number.isFinite(output)) return undefined

  const usage: TurnUsage = { inputTokens: input, outputTokens: output }
  for (const bucket of OPTIONAL_BUCKETS) {
    const entry = record[bucket]
    if (typeof entry === 'number' && Number.isFinite(entry)) usage[bucket] = entry
  }
  return usage
}

/**
 * The usage array a chat file line carries, by swipe position.
 * @param line - one message line.
 * @returns the array as read, empty when the line carries none.
 */
export function usageFieldOf(line: SillyTavernMessage): unknown[] {
  const stored = line[USAGE_FIELD]
  return Array.isArray(stored) ? stored : []
}
