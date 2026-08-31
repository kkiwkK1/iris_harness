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
  /** What the frame managed to publish onto its own window, as it reported it. */
  globals?: string
  /** Slash commands the card invoked, raw. */
  slash: string[]
  /**
   * The last run's ending, persisting past the run itself.
   *
   * The point of this field: an observation that only exists while a panel
   * happens to be open is an observation you get one chance at.
   */
  lastRun?: RunOutcome
}

const FRESH: HarnessState = { status: 'idle', errors: [], blocked: [], slash: [] }

/**
 * The record lives on `globalThis`, not in this module's scope.
 *
 * Moving it out of React stopped a remount from erasing it. That was not far
 * enough: Vite replaces a module on edit, and a module-scoped record is replaced
 * with it — so in development, where this harness only ever runs, "the record
 * survives" was still false whenever anyone touched the file. An observer lost a
 * run to exactly that, with an HMR update logged at the moment they pressed Run.
 *
 * A global slot is immune to both. It is the right amount of ugly for a dev-only
 * tool whose entire job is to still be holding what it saw.
 */
interface HarnessSlot {
  state: HarnessState
  card: RunningCard | undefined
  listeners: Set<() => void>
}

const SLOT = '__irisHarness__'

function slot(): HarnessSlot {
  const host = globalThis as unknown as Record<string, HarnessSlot | undefined>
  const existing = host[SLOT]
  if (existing !== undefined) return existing
  const fresh: HarnessSlot = { state: FRESH, card: undefined, listeners: new Set() }
  host[SLOT] = fresh
  return fresh
}

/**
 * Read the current record.
 * @returns the state; a stable reference between changes, as `useSyncExternalStore` requires.
 */
export function getHarness(): HarnessState {
  return slot().state
}

/**
 * Watch for changes.
 * @param listener - called after every change.
 * @returns a disposer.
 */
export function subscribeHarness(listener: () => void): () => void {
  const here = slot()
  here.listeners.add(listener)
  return () => {
    here.listeners.delete(listener)
  }
}

/**
 * Change part of the record.
 * @param patch - fields to replace, or a function of the current state.
 */
export function setHarness(patch: Partial<HarnessState> | ((before: HarnessState) => Partial<HarnessState>)): void {
  const here = slot()
  const next = typeof patch === 'function' ? patch(here.state) : patch
  here.state = { ...here.state, ...next }
  for (const listener of [...here.listeners]) listener()
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
  const here = slot()
  const kept = here.state.lastRun
  here.state = { status, errors: [], blocked: [], slash: [], ...(kept === undefined ? {} : { lastRun: kept }) }
  for (const listener of [...here.listeners]) listener()
}

/** The frame currently running, if any. */
export function runningCard(): RunningCard | undefined {
  return slot().card
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
  const here = slot()
  here.card?.dispose()
  here.card = next
}
