/**
 * The harness's observations, held outside React.
 *
 * Not a preference — a fix for a specific failure. The harness kept everything in
 * component state, and an observer running a real card lost the entire state view
 * on their next interaction: status line, height, settings write, errors, all
 * gone, three attempts in a row. I twice guessed at why a mount was disappearing
 * and was twice wrong, so this stops depending on the answer: a module-level
 * record survives any remount, whatever causes it.
 *
 * It also changes one rule deliberately. The frame used to be disposed when the
 * panel unmounted, on the principle that a frame outliving its panel is a leak.
 * That principle is right for the product and wrong here: "leaving the panel"
 * turned out to be far too easy to trigger by accident, and a frame that vanishes
 * mid-observation destroys the thing being observed. In the harness the frame now
 * lives until Stop, or until the page goes away.
 *
 * @module iris-web/dev/harness-state
 */

import type { RunningCard } from '../sandbox/runner.ts'

/** How a run ended. Kept after the run so the record does not depend on timing. */
export interface RunOutcome {
  label: string
  /** `ran`, `error`, `refused`, or `killed`. */
  result: string
  detail?: string
}

/** Everything the harness has observed. */
export interface HarnessState {
  status: string
  height?: number
  settings?: string
  errors: string[]
  blocked: { host: string, directive: string }[]
  /**
   * The last run's ending, persisting past the run itself.
   *
   * The point of this field: an observation that only exists while a panel
   * happens to be open is an observation you get one chance at.
   */
  lastRun?: RunOutcome
}

const FRESH: HarnessState = { status: 'idle', errors: [], blocked: [] }

let state: HarnessState = FRESH
let card: RunningCard | undefined
const listeners = new Set<() => void>()

/**
 * Read the current record.
 * @returns the state; a stable reference between changes, as `useSyncExternalStore` requires.
 */
export function getHarness(): HarnessState {
  return state
}

/**
 * Watch for changes.
 * @param listener - called after every change.
 * @returns a disposer.
 */
export function subscribeHarness(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Change part of the record.
 * @param patch - fields to replace, or a function of the current state.
 */
export function setHarness(patch: Partial<HarnessState> | ((before: HarnessState) => Partial<HarnessState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const listener of [...listeners]) listener()
}

/**
 * Clear the observations for a new run, keeping the previous run's ending.
 *
 * Rebuilt rather than patched with `undefined`: under
 * `exactOptionalPropertyTypes` an absent optional and one explicitly set to
 * `undefined` are different types, and the distinction is the right one — this
 * needs the fields *gone*, not present and empty.
 * @param status - the status line to show while the run starts.
 */
export function resetObservations(status: string): void {
  const kept = state.lastRun
  state = { status, errors: [], blocked: [], ...(kept === undefined ? {} : { lastRun: kept }) }
  for (const listener of [...listeners]) listener()
}

/** The frame currently running, if any. */
export function runningCard(): RunningCard | undefined {
  return card
}

/**
 * Replace the running frame.
 *
 * Disposes whatever was there first: two live frames would both be posting into
 * the same shell listener, and the second one's token would not save the display
 * from showing a mixture.
 * @param next - the new frame, or undefined to clear.
 */
export function setRunningCard(next: RunningCard | undefined): void {
  card?.dispose()
  card = next
}
