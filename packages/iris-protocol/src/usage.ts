/**
 * The one answer to "how big was that prompt", from a provider's usage report.
 *
 * The harness convention keeps the three prompt-side buckets **disjoint**:
 * `inputTokens` is the part the cache did *not* serve (the adapter computes
 * `prompt_tokens - cacheRead`), so on a cache-hitting turn it can be a tenth
 * of the request. Every consumer that means "the size of the request" — the
 * calibrator's feed, the itemization's `actualTokens`, the panel's billed
 * prompt figure, a cache-hit denominator — needs the sum, and reading
 * `inputTokens` alone is the defect this helper exists to make unwritable:
 * with a steady 90% cache hit the calibrator read the prompt as a tenth of its
 * size and pinned its scale at the 0.5 floor within two turns.
 *
 * In the contract rather than in the host because both halves ask the
 * question, and three hand-written copies of this sum (host summary, browser
 * usage line, fake client) are three places to get the convention wrong.
 *
 * An absent bucket contributes nothing: the provider did not report it. A
 * non-finite or negative figure contributes nothing either, so one malformed
 * record cannot turn a sum into `NaN`.
 * @param usage - one generation's usage, or a sum of several.
 * @returns the whole prompt side, in tokens.
 */
export function promptTokensOf(usage: PromptUsage): number {
  return countable(usage.inputTokens)
    + countable(usage.cacheReadTokens ?? 0)
    + countable(usage.cacheWriteTokens ?? 0)
}

/** The prompt-side buckets {@link promptTokensOf} reads; structural, so the harness's `TokenUsage` fits too. */
export interface PromptUsage {
  inputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

function countable(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}
