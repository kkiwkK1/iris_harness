/**
 * Trimming a long chat's per-floor variable tables.
 *
 * **What this is for, stated carefully, because the obvious framing is wrong.**
 * The 8.29 MiB measured on the corpus's longest chat is what SillyTavern's
 * cleanup *leaves behind*, not what it removes: 641 of that file's 683 swipe
 * layers are already stripped (24 KiB between them, 39 bytes each) and its size
 * is carried by 42 retained snapshots averaging 201 KiB. Pruning does not shrink
 * that number — it is why the number is 8.29 MiB instead of the ~133 MiB that
 * 677 unpruned floors would cost. The property to hold is **O(N/interval)
 * instead of O(N)**, and an acceptance test written as "the file gets smaller"
 * would fail against a correct implementation.
 *
 * Upstream's rule, from `MagVarUpdate/src/function/cleanup/cleanup_variables.ts`:
 *
 * - It removes **five named keys**, not the layer:
 *   `initialized_lorebooks`, `stat_data`, `display_data`, `delta_data`,
 *   `schema`. Everything else a card put there stays, because deciding that a
 *   key nobody here recognises is disposable is deciding on the card author's
 *   behalf.
 * - A layer already marked `snapshot: true` is kept whole.
 * - A floor on the interval is kept whole **and marked**, and the mark is the
 *   subtle part: upstream's own comment explains that a user changing the
 *   interval from 50 to 70 would otherwise get an effective 350 through the
 *   least common multiple. The mark pins the decision that was current when it
 *   was made, so a later configuration change cannot retroactively orphan a
 *   snapshot.
 * - Recent floors are protected.
 *
 * **What is deliberately not copied.** Upstream computes its range as
 * `[max(1, old - 2 - keep * 2), old]`, and its comment says the `* 2` is because
 * it does not listen for `MESSAGE_SENT` and so has to reach further back through
 * interleaved user floors. That is a compensation for a missed event, not a
 * rule. This host prunes by turn, where a turn is an exchange, so the same
 * protection is expressed as "the newest `keep` turns" with no magic number.
 *
 * **Nothing is restored.** Upstream replays `updateVariables` forward from the
 * nearest snapshot; our MVU commands are already folded into candidate state by
 * the time they are stored, so there is nothing to replay. A pruned floor is
 * gone. Pretending otherwise would be worse than saying so.
 *
 * @module @iris/app-service/prune
 */

import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Keys removed from one candidate's variable table, and why.
     *
     * Appended rather than rewriting the `iris/variables` event it refers to.
     * The log's value is that it never lies about what happened, and every
     * property that rests on it — per-candidate variables, swipe consistency,
     * a branch sharing its parent's history — rests on that. Saving bytes by
     * editing history would trade the foundation for the attic. (Compacting the
     * event log itself is a separate piece of work with its own safety story;
     * it is not a side effect of this one.)
     *
     * It carries enough to **explain a reading afterwards**: someone asking why
     * floor N reads empty should find the answer in the log rather than
     * reconstructing it.
     */
    'iris/variables-pruned': {
      /** The `assistant/message` candidate whose table was trimmed. */
      candidateSeq: number
      /** The turn it belonged to, so a reading can be explained by position. */
      turn: number
      /** Which keys were taken. */
      removed: string[]
      /** The rule that allowed it, in words, for whoever asks later. */
      reason: string
      /** When, so a prune can be placed against the conversation's history. */
      at: number
    }
  }
}

/**
 * The keys upstream removes, in its order.
 *
 * Everything else in a layer belongs to whoever put it there. The corpus has at
 * least one such key (`event_chain`), and it is 0.2% of the payload — the five
 * below are 99.8%, so keeping the rest costs nothing and guessing about it would
 * cost someone their card's state.
 */
export const PRUNED_KEYS = [
  'initialized_lorebooks',
  'stat_data',
  'display_data',
  'delta_data',
  'schema',
] as const

/** Marks a layer upstream has decided to keep, so a later change cannot unkeep it. */
export const SNAPSHOT_KEY = 'snapshot'

/** How pruning is configured. */
export interface PruneOptions {
  /**
   * Keep every layer on a turn that is a multiple of this.
   *
   * Upstream's `快照保留间隔`, default 50 and the value in the measured
   * installation.
   */
  snapshotInterval: number
  /**
   * Never touch the newest this many turns.
   *
   * Upstream's `要保留变量的最近楼层数`, default 20 and the measured value.
   */
  keepRecent: number
}

/** Upstream's defaults, which are also the values in the measured install. */
export const DEFAULT_PRUNE: PruneOptions = { snapshotInterval: 50, keepRecent: 20 }

/** One layer's fate under the rule. */
export interface PruneDecision {
  turn: number
  candidateSeq: number
  /** Absent when the layer is kept. */
  removed?: string[]
  reason: string
}

/**
 * Decide what to prune, without touching anything.
 *
 * Separated from applying it because the decision is the part with rules in it:
 * a caller can log it, test it, or show it before anything is removed. Deleting
 * user data is the one place where "what would happen" deserves to be a value
 * you can hold.
 * @param layers - each candidate's table, by turn, newest turn last.
 * @param newestTurn - the highest turn the log has, for the recency window.
 * @param options - the interval and the protection window.
 * @returns one decision per layer, in the order given.
 */
export function planPrune(
  layers: readonly { turn: number, candidateSeq: number, variables: Record<string, unknown> }[],
  newestTurn: number,
  options: PruneOptions = DEFAULT_PRUNE,
): PruneDecision[] {
  const plan: PruneDecision[] = []

  for (const layer of layers) {
    const base = { turn: layer.turn, candidateSeq: layer.candidateSeq }

    if (layer.variables[SNAPSHOT_KEY] === true) {
      plan.push({ ...base, reason: 'kept: already marked as a snapshot' })
      continue
    }
    if (layer.turn > newestTurn - options.keepRecent) {
      plan.push({ ...base, reason: `kept: within the newest ${String(options.keepRecent)} turns` })
      continue
    }
    if (options.snapshotInterval > 0 && layer.turn % options.snapshotInterval === 0) {
      // Marked as well as kept. Upstream's reason, verbatim in effect: raising
      // the interval later would otherwise make the effective spacing their
      // least common multiple, retroactively orphaning snapshots taken under the
      // old setting.
      plan.push({ ...base, reason: `kept: on the ${String(options.snapshotInterval)}-turn snapshot interval, and marked` })
      continue
    }

    const removed = PRUNED_KEYS.filter(key => key in layer.variables)
    if (removed.length === 0) {
      plan.push({ ...base, reason: 'kept: nothing prunable left' })
      continue
    }
    plan.push({
      ...base,
      removed: [...removed],
      reason: `pruned: turn ${String(layer.turn)} is older than the newest ${String(options.keepRecent)}`
        + ` and not on the ${String(options.snapshotInterval)}-turn interval`,
    })
  }

  return plan
}

/**
 * Apply a plan to the log, as new events.
 *
 * A kept-and-marked layer is written back with its mark; a pruned layer gets a
 * `iris/variables-pruned` event. Neither rewrites the `iris/variables` event it
 * concerns.
 * @param session - the chat log.
 * @param plan - from {@link planPrune}.
 * @param layers - the tables the plan was made against, for re-marking.
 * @returns how many layers were pruned.
 */
export function applyPrune(
  session: Session,
  plan: readonly PruneDecision[],
  layers: readonly { candidateSeq: number, variables: Record<string, unknown> }[],
): number {
  const byCandidate = new Map(layers.map(layer => [layer.candidateSeq, layer.variables]))
  let pruned = 0

  for (const decision of plan) {
    if (decision.reason.includes('and marked')) {
      const variables = byCandidate.get(decision.candidateSeq)
      if (variables !== undefined && variables[SNAPSHOT_KEY] !== true) {
        session.append('iris/variables', {
          candidateSeq: decision.candidateSeq,
          variables: { ...variables, [SNAPSHOT_KEY]: true },
        })
      }
      continue
    }
    if (decision.removed === undefined) continue

    session.append('iris/variables-pruned', {
      candidateSeq: decision.candidateSeq,
      turn: decision.turn,
      removed: decision.removed,
      reason: decision.reason,
      at: Date.now(),
    })
    pruned += 1
  }

  return pruned
}

/**
 * Every candidate whose table has been pruned, and what was taken.
 *
 * Read by whoever projects the log into tables, so a pruned layer reports what
 * survived rather than what was written.
 * @param session - the chat log.
 * @returns removed keys by candidate seq.
 */
export function prunedKeysOf(session: Session): Map<number, Set<string>> {
  const pruned = new Map<number, Set<string>>()
  for (const event of session.events) {
    if (event.type !== 'iris/variables-pruned') continue
    const existing = pruned.get(event.data.candidateSeq) ?? new Set<string>()
    for (const key of event.data.removed) existing.add(key)
    pruned.set(event.data.candidateSeq, existing)
  }
  return pruned
}

/**
 * One table as it reads after pruning.
 * @param variables - the table as written.
 * @param removed - keys taken from it, if any.
 * @returns the surviving keys.
 */
export function applyPruned(
  variables: Record<string, unknown>,
  removed: Set<string> | undefined,
): Record<string, unknown> {
  if (removed === undefined || removed.size === 0) return variables
  const surviving: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(variables)) {
    if (!removed.has(key)) surviving[key] = value
  }
  return surviving
}

/**
 * How a floor's variable table was arrived at.
 *
 * A separate field rather than a shape difference, and that is the point:
 * `stored` and `replayed` tables look identical, and on the corpus they
 * **disagree on about a quarter of transitions** (`stat_data` reproduced in 93
 * of 121 adjacent full-floor pairs). A reader that cannot tell them apart will
 * treat a recomputed value as a recorded one.
 */
export type FloorOrigin = 'stored' | 'pruned' | 'replayed'

/** A floor's table together with what it actually is. */
export interface FloorRead {
  /** The table. Empty for `pruned` beyond whatever survived the trim. */
  variables: Record<string, unknown>
  /** Where this table came from; never inferable from the table itself. */
  origin: FloorOrigin
  /** Why, in a sentence a log or a panel can show verbatim. */
  note: string
  /** For `replayed`: the turn the replay started from. */
  replayedFrom?: number
  /** For `replayed`: how many turns were folded to get here. */
  replayedFloors?: number
}

/**
 * The refusal a pruned floor answers with when replay is not asked for.
 *
 * **Named, not empty.** Before this, a pruned floor and a floor that never held
 * variables both read as `{}` — the reader could not tell "this was deleted" from
 * "there was never anything here", and upstream cannot either. Saying which one
 * it is costs a string and is the difference between a missing feature and a
 * silent one.
 * @param turn - the floor asked for.
 * @param removed - the keys the prune took.
 * @param snapshot - the nearest earlier intact turn, when there is one.
 * @returns the sentence to carry on the read.
 */
export function prunedNote(
  turn: number,
  removed: ReadonlySet<string>,
  snapshot: number | undefined,
): string {
  const keys = [...removed].sort().join(', ')
  const where = snapshot === undefined
    ? 'no earlier intact turn survives, so nothing can reconstruct it'
    : `the nearest intact turn is ${String(snapshot)}`
  return `turn ${String(turn)} was pruned (${keys}); ${where}`
}
