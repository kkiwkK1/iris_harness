/**
 * One owner's lasting effects in the frame, and the one call that undoes them.
 *
 * Cordis-*shaped*, not Cordis (owner ruling 1, 2026-09-25): `scope.effect(() =>
 * dispose)` runs the effect now and keeps its undo, and `dispose()` runs every
 * kept undo in **reverse order** and answers one row per effect. No Cordis
 * library is loaded into the frame.
 *
 * Two places where it deliberately differs from Cordis's fiber unload, both
 * named in the review that proposed it (`frame-plugin-kernel-on-cordis`):
 *
 * - **Serial and reverse, not concurrent.** Cordis starts every disposer under
 *   one `Promise.all`. Here an undo is synchronous and the order is the reverse
 *   of registration, so a later effect built on an earlier one comes away first.
 * - **Failures are returned, not logged.** Each row says whether its undo threw
 *   and in whose words, so the teardown checklist can file `dispose-failed` with
 *   the label of what stayed behind. One undo throwing never stops the rest.
 *
 * Why it exists: the plugin teardown's item 5 was three hard-coded member calls,
 * and `initializeGlobal` was not one of them, so a plugin's published global
 * outlived it. With the scope, each trace-bearing member registers its own undo
 * where the effect is made ({@link TRACE_MEMBERS} lists them), and teardown is
 * `scope.dispose()`. A new stateful member is covered where it is written,
 * rather than by an edit to a list somewhere else.
 *
 * @module iris-web/sandbox/owner-scope
 */

/** What one effect's undo did. */
export interface OwnerScopeStep {
  /** The effect's own label, as registered. */
  readonly label: string
  readonly ok: boolean
  /** Present only when `ok` is false. */
  readonly detail?: string
}

/** One owner's effects. */
export interface OwnerScope {
  /**
   * Run an effect now and keep its undo.
   * @param execute - does the effect and returns what undoes it.
   * @param label - names the effect in the checklist.
   * @returns a function that undoes this one effect early and forgets it.
   */
  effect: (execute: () => () => void, label: string) => () => void
  /**
   * Undo everything still held, newest first.
   * @returns one row per effect, in the order they were undone.
   */
  dispose: () => OwnerScopeStep[]
  /** How many effects are held now. */
  size: () => number
  /** Whether {@link OwnerScope.dispose} has run. */
  disposed: () => boolean
}

/**
 * The card-surface members whose effect outlives the call, and which family
 * of undo each registers.
 *
 * The census the "nothing remains" test compares against, and asserts as a
 * floor. A member added here without an undo in `frame.ts` fails that test. A
 * lasting member added to the surface and not here is the gap it cannot see,
 * which is why the list sits beside the primitive rather than in the test.
 */
export const TRACE_MEMBERS = {
  eventOn: 'events',
  eventOnce: 'events',
  eventMakeFirst: 'events',
  eventMakeLast: 'events',
  replaceScriptButtons: 'buttons',
  appendInexistentScriptButtons: 'buttons',
  updateScriptButtonsWith: 'buttons',
  injectPrompts: 'injections',
  initializeGlobal: 'globals',
} as const satisfies Record<string, 'events' | 'buttons' | 'injections' | 'globals'>

/** One of the families in {@link TRACE_MEMBERS}. */
export type TraceFamily = (typeof TRACE_MEMBERS)[keyof typeof TRACE_MEMBERS]

/**
 * Refuse a trace-bearing call from an owner that has been taken down, before
 * the call has any effect.
 *
 * Checked before the member runs rather than when its undo is registered: by
 * then the listener is on the bus, or the injection is on its way to the
 * host, and a refusal would leave exactly the trace the scope exists to
 * prevent.
 * @param scope - the calling owner's scope.
 * @param member - named in the refusal.
 * @throws {Error} when the scope has been disposed.
 */
export function refuseIfDisposed(scope: OwnerScope, member: string): void {
  if (scope.disposed()) {
    throw new Error(`${member}: this owner has been removed, so it can no longer register anything`)
  }
}

/**
 * Make an empty scope.
 * @returns the scope.
 */
export function createOwnerScope(): OwnerScope {
  interface Held { readonly label: string, readonly undo: () => void }
  const held: Held[] = []
  let isDisposed = false

  const run = (entry: Held): OwnerScopeStep => {
    try {
      entry.undo()
      return { label: entry.label, ok: true }
    } catch (error: unknown) {
      return { label: entry.label, ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    effect: (execute, label) => {
      /*
       * Refused after dispose, rather than run and kept. A disposed owner is a
       * plugin that has been taken down; anything it does afterwards (a late
       * timer, an unawaited promise) would register an effect nobody will ever
       * undo, which is exactly the leak this primitive exists to close.
       */
      if (isDisposed) throw new Error(`${label}: this owner has been disposed, so nothing it does now can be undone`)
      const entry: Held = { label, undo: execute() }
      held.push(entry)
      return () => {
        const at = held.indexOf(entry)
        if (at === -1) return
        held.splice(at, 1)
        entry.undo()
      }
    },
    dispose: () => {
      isDisposed = true
      const steps: OwnerScopeStep[] = []
      while (held.length > 0) {
        const entry = held.pop()
        if (entry !== undefined) steps.push(run(entry))
      }
      return steps
    },
    size: () => held.length,
    disposed: () => isDisposed,
  }
}
