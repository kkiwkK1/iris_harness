/**
 * Reconnect pacing.
 *
 * Split out and pure so the schedule can be asserted without waiting for it.
 *
 * @module @iris/rpc-client/backoff
 */

/** How aggressively a dropped connection is retried. */
export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. */
  initialDelayMs: number
  /** Ceiling the delay doubles towards, in milliseconds. */
  maxDelayMs: number
  /**
   * Fraction of the delay spread randomly, from 0 to 1.
   *
   * Not decoration: when a host restarts, every open page notices at the same
   * instant, and a fixed schedule marches them back in lockstep — the retry
   * storm arrives exactly while the host is least able to serve it.
   */
  jitter: number
}

/** Retry quickly enough to feel instant on a host restart, then back off. */
export const DEFAULT_BACKOFF: BackoffOptions = {
  initialDelayMs: 300,
  maxDelayMs: 10_000,
  jitter: 0.25,
}

/**
 * How long to wait before one reconnect attempt.
 * @param attempt - zero-based retry count since the last successful connection.
 * @param options - the schedule.
 * @param random - source of the jitter, in `[0, 1)`; injected for tests.
 * @returns the delay in milliseconds, never negative.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(options.initialDelayMs * 2 ** Math.max(attempt, 0), options.maxDelayMs)
  // Symmetric around `base`, so the schedule's average is the schedule.
  const spread = base * options.jitter
  return Math.max(0, Math.round(base - spread + random() * spread * 2))
}
