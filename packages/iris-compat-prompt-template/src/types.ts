/**
 * The host↔child protocol.
 *
 * This is the one part of the package that is expensive to change later, so it
 * is written down before anything implements it. Everything that crosses the
 * process boundary is plain JSON: the child never holds a reference to a host
 * object, and the host never applies a write the child performed — it applies a
 * described write through its own entry points. That is what makes the boundary
 * a boundary rather than a convention.
 *
 * @module @iris/compat-prompt-template/types
 */

/** Anything that survives the process boundary. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * Where a variable lives.
 *
 * Upstream's names, kept: a compat layer that renames its source stops being
 * able to read its source's documentation. `initial` is the card's shipped
 * starting state, which upstream keeps separate from `global` so that a reset
 * has something to reset to.
 */
export type Scope = 'global' | 'initial' | 'local' | 'message'

/**
 * One world-info entry, as the child sees it.
 *
 * `content` arrives **already macro-substituted and regexed**. Both of those are
 * host functions, and running them host-side is what lets the whole batch be one
 * round trip. The cost is deviation 4 in `notes/packages/iris-compat-prompt-template/DEVIATIONS.md`: upstream substitutes
 * per `getwi` call, we substitute once per batch.
 */
export interface WorldInfoEntry {
  world: string
  uid: string
  /** The entry's title. This is what `getwi` matches on, by string or regex. */
  comment: string
  content: string
}

/**
 * Everything the template environment can read.
 *
 * Pushed whole, because the child cannot call back out mid-evaluation without
 * turning one round trip into hundreds. `worldInfo` in particular is pushed
 * entire rather than pre-filtered: measured over the corpus, 58 of 62 `getwi`
 * call sites pass a literal entry name but 4 compute it at runtime — one builds
 * a `RegExp` from a variable — so the reachable set cannot be determined
 * host-side. Pushing all of it costs 3.12 MiB and 4–16 ms, which is cheaper
 * than being clever and wrong.
 */
export interface Snapshot {
  /**
   * The four scopes, unmerged.
   *
   * Unmerged on purpose: `getvar(key, 'global')` has to be able to see past the
   * merge, so the child recomputes upstream's cache itself rather than being
   * handed the result. The merge order is upstream's and lives in
   * `environment.ts` beside the code that depends on it.
   */
  variables: Record<Scope, Json>
  /** `SillyTavern.chatMetadata`. The only member of that object cards reach for. */
  chatMetadata: Json
  worldInfo: WorldInfoEntry[]
  /**
   * Which book `getwi` searches when the caller does not name one.
   *
   * Upstream resolves **exactly one** book through a fallback chain and scans
   * only that — it never searches the union. From `getWorldInfoEntries`:
   *
   * ```js
   * const lore = name || characters[this_chid]?.data?.extensions?.world
   *   || power_user.persona_description_lorebook || chat_metadata[METADATA_KEY] || ''
   * ```
   *
   * Measured, this is the whole story for the corpus: **all 58 literal `getwi`
   * call sites pass `null`** as the book, and every one of their targets lives in
   * the calling card's bound book. Without this field the evaluator would have to
   * guess, and guessing "search everything" returns a same-titled entry from the
   * wrong book with nothing raised anywhere.
   */
  lorebooks: {
    /** The card's own bound book — `data.extensions.world`. The usual answer. */
    character?: string
    /** The persona's book — upstream's `power_user.persona_description_lorebook`. */
    persona?: string
    /** The chat's book — upstream's `chat_metadata[METADATA_KEY]`. */
    chat?: string
  }
  /** `userName`, `charName`, `chatId`, `characterId`, … — upstream's flat env values. */
  scalars: Record<string, Json>
  /** Upstream stamps an incrementing `_trace_id` into the variable cache. */
  traceId: number
}

/** One thing to evaluate. */
export interface EvalItem {
  /**
   * Host-minted and opaque to the child.
   *
   * Identity is minted, never derived — a key rebuilt from position or content
   * has already cost this repository a live bug.
   */
  id: string
  /** The text. Macros already substituted, regex already applied. */
  text: string
  /** Upstream's `filename` option: it names the frame in an error message. */
  origin: string
  /** Per-item environment additions. A world-info entry gets its `world_info`. */
  locals?: Record<string, Json>
}

/** One batch: host → child, once, then the child is done. */
export interface EvalBatch {
  /** The child refuses a version it does not know rather than guessing. */
  v: 1
  /** Wall clock for the whole batch. Enforced by the host — see `host.ts`. */
  deadlineMs: number
  /**
   * In upstream's evaluation order.
   *
   * The order is the contract, not a convenience: a `setvar` in item 3 must be
   * visible to item 4, exactly as it is upstream, and the change set's ordering
   * is this array's ordering.
   */
  items: EvalItem[]
  snapshot: Snapshot
}

/**
 * What one item produced.
 *
 * A failure is not an error for the caller to throw on. Upstream catches,
 * reports, and leaves the original text in place, so the whole generation
 * survives one broken template; copying that is deliberate.
 */
export type ItemResult =
  | { ok: true, text: string }
  | { ok: false, error: string, line?: number }

/**
 * A write the template performed, described rather than applied.
 *
 * The host replays these through its own storage entry points. A template
 * therefore cannot bypass a check the host makes on the way in, which is the
 * property that a shared mutable object would have quietly given away.
 */
export type Op =
  | { op: 'setvar', scope: Scope, key: string, value: Json }
  | { op: 'delvar', scope: Scope, key: string }
  | { op: 'insvar', scope: Scope, key: string, value: Json, index?: number | string }
  | { op: 'saveMetadata', value: Json }

/**
 * Child → host. Streamed, one `item` per evaluated item.
 *
 * Streaming is what makes the deadline granular. When the host kills a child
 * that overran, every `item` already received still counts and only the
 * unreached items fall back to their original text — which is upstream's own
 * failure behaviour applied to the items evaluation never got to, not a new
 * mode invented for the timeout.
 */
export type ChildMessage =
  | { v: 1, kind: 'ready' }
  | { v: 1, kind: 'item', id: string, result: ItemResult, ops: Op[] }
  | { v: 1, kind: 'done' }
  | { v: 1, kind: 'fatal', error: string }

/** What the host gets back for a whole batch. */
export interface BatchOutcome {
  /** One entry per item of the request, in the same order. */
  results: { id: string, result: ItemResult }[]
  /** Every write, in the order the templates performed them. */
  ops: Op[]
  /**
   * Set when the child was killed for overrunning `deadlineMs`.
   *
   * Items already returned are kept; the rest are reported as failures naming
   * the timeout, so a caller that falls back to original text does the right
   * thing without special-casing this.
   */
  timedOut: boolean
}
