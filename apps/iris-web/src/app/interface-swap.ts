/**
 * Keeping a retiring interface on screen until its replacement can take over.
 *
 * A rebuild is not free: the replacement frame re-parses the members table and
 * the message preset and re-runs its bootstrap before anything is on screen —
 * measured at about a second on a fast card, longer on a heavy one. Disposing
 * the old frame the moment the text changes makes that whole span a blank
 * rectangle, which is what a reader reports as "the interface disappears and
 * comes back slowly". So the old frame is parked — muted, still on screen —
 * and swapped out only when the replacement can actually take its place.
 *
 * This module is the part of that mechanism that can be decided without a
 * DOM: which instances are still waiting, and when the wait is over — because
 * every replacement reached it, because the instance is gone from the
 * replacement, or because the cap ran out and a broken boot must not hold the
 * old picture hostage forever.
 *
 * @module iris-web/app/interface-swap
 */

/** How the replacement for one instance ended, as the swap cares. */
export type SwapResolution =
  /** The replacement is ready; swap it in. */
  | 'live'
  /** The replacement failed; the old frame makes way and the row says why. */
  | 'failed'
  /** The replacement was refused (budget) or no longer exists; make way. */
  | 'gone'

/**
 * One parked interface set, tracked until its replacement covers it.
 */
export interface RetiringInterfaces {
  /**
   * Report that `instance`'s replacement reached a swappable state, or that
   * there is no replacement for it. Idempotent.
   * @param instance - the parked instance the replacement answered for.
   */
  replaced(instance: number): void
  /** Whether nothing is left to wait for. */
  readonly settled: boolean
}

/**
 * Default timer, injectable so tests can drive the cap without a clock.
 * @param fn - what to run when the cap expires.
 * @param ms - the cap.
 */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/**
 * Start tracking a parked set's instances until their replacements cover them.
 *
 * Settling is **once**: `onSettled` runs on the first of (every instance
 * replaced) or (the cap), whichever comes first, and later `replaced` calls
 * change nothing. A set with no on-screen instances — every frame already
 * gone, or none was built — settles immediately: there is nothing to hold on
 * to.
 * @param instances - the parked instances that are on screen and need cover.
 * @param onSettled - runs once, when the wait is over.
 * @param capMs - how long a replacement may boot before the old frame is
 *   given up. A cap, because a replacement that never becomes ready must not
 *   hold a stale interface on screen forever — the row's own ready timeout is
 *   the model: silence is a finding, not a state to rest in.
 * @param schedule - the timer, injected for tests.
 */
export function beginRetirement(
  instances: readonly number[],
  onSettled: () => void,
  capMs: number,
  schedule: (fn: () => void, ms: number) => () => void = defaultSchedule,
): RetiringInterfaces {
  const pending = new Set(instances)
  let settled = false
  const retires: RetiringInterfaces = {
    get settled(): boolean {
      return settled
    },
    replaced: () => undefined,
  }

  const cancelCap = schedule(settle, capMs)

  retires.replaced = (instance: number): void => {
    if (settled) return
    pending.delete(instance)
    if (pending.size === 0) settle()
  }

  function settle(): void {
    if (settled) return
    settled = true
    cancelCap()
    onSettled()
  }

  if (pending.size === 0) settle()
  return retires
}
