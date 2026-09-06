/**
 * The world-info settings a card can read, in TavernHelper's shape.
 *
 * `getLorebookSettings()` is the member MVU's chat-level init calls, and it is
 * **synchronous** — one of MVU's two call sites awaits it and one does not, and
 * both work, because awaiting a non-Promise is harmless. Making it async here
 * would break the second. That is why these values ride in the context snapshot
 * a frame already holds rather than behind a request: a synchronous member
 * cannot be backed by a round trip.
 *
 * Upstream returns a `klona` deep copy, so the value is a snapshot and editing
 * it changes nothing. Matching that is not the `live-object vs snapshot`
 * divergence recorded elsewhere — here the snapshot **is** upstream's semantics.
 *
 * @module @iris/app-service/lorebook-settings
 */

import { resolveWorldbookSettings, type WorldbookSettings } from './worldbook-settings.ts'

/** How the character's books and the global ones are interleaved. */
export type InsertionStrategy = 'evenly' | 'character_first' | 'global_first'

/**
 * The sixteen fields TavernHelper maps out of SillyTavern's fourteen settings.
 *
 * **Two names mislead, and both are copied rather than corrected**, because a
 * card reads them by name:
 *
 * - `max_depth` comes from `world_info_min_activations_depth_max` — the depth
 *   ceiling for *minimum activations*, not the scan depth. Scan depth is
 *   `scan_depth`.
 * - `context_percentage` comes from `world_info_budget`, which is a
 *   **percentage**; the byte ceiling is the separate `budget_cap`. Two fields
 *   called budget upstream, one proportional and one absolute.
 */
export interface LorebookSettings {
  selected_global_lorebooks: string[]
  scan_depth: number
  /** From `world_info_budget`: a percentage of context, not a byte count. */
  context_percentage: number
  /** From `world_info_budget_cap`: bytes, and `0` disables the cap. */
  budget_cap: number
  min_activations: number
  /** From `world_info_min_activations_depth_max`; `0` means no ceiling. */
  max_depth: number
  max_recursion_steps: number
  insertion_strategy: InsertionStrategy
  include_names: boolean
  recursive: boolean
  case_sensitive: boolean
  match_whole_words: boolean
  use_group_scoring: boolean
  overflow_alert: boolean
}

/**
 * SillyTavern's own defaults, read from its source rather than chosen here.
 *
 * `world-info.js:69-82` on the measured installation. They are copied because a
 * card that reads a setting is reading it to make a decision, and a plausible
 * house default would make that decision differently from the same card running
 * in SillyTavern — a divergence with no symptom anyone could trace back here.
 */
export const UPSTREAM_DEFAULTS: Omit<LorebookSettings, 'selected_global_lorebooks'> = {
  scan_depth: 2,
  context_percentage: 25,
  budget_cap: 0,
  min_activations: 0,
  max_depth: 0,
  max_recursion_steps: 0,
  insertion_strategy: 'character_first',
  include_names: true,
  recursive: false,
  case_sensitive: false,
  match_whole_words: false,
  use_group_scoring: false,
  overflow_alert: false,
}

/**
 * The settings as this host can answer them.
 *
 * Every numeric and boolean field now reads the **stored** world-info settings
 * (`worldbook-settings.ts`) merged over upstream's defaults — so a scan depth
 * the user set is the scan depth the card is told, which is the same scan depth
 * the engine runs. Before the store existed this table reported the defaults
 * while the engine ran its own, and on `match_whole_words` the two disagreed;
 * that split is what wiring both sides to one store removes.
 * @param globalSelect - the globally selected book names.
 * @param stored - the host's stored settings; absent means defaults.
 * @returns a fresh object each call, so a card scribbling on it changes nothing.
 */
export function lorebookSettings(
  globalSelect: readonly string[],
  stored?: Partial<WorldbookSettings>,
): LorebookSettings {
  const effective = resolveWorldbookSettings(stored)
  return {
    selected_global_lorebooks: [...globalSelect],
    scan_depth: effective.scanDepth,
    context_percentage: effective.budgetPercent,
    budget_cap: effective.budgetCap,
    min_activations: effective.minActivations,
    max_depth: effective.minActivationsDepthMax,
    max_recursion_steps: effective.maxRecursionSteps,
    insertion_strategy: effective.insertionStrategy,
    recursive: effective.recursive,
    case_sensitive: effective.caseSensitive,
    match_whole_words: effective.matchWholeWords,
    use_group_scoring: effective.useGroupScoring,
    // Stored since the `include_names` knob was built: a card asking what the
    // scan runs on now gets the answer the scan actually runs on, not ST's
    // shipped default standing in for it.
    include_names: effective.includeNames,
    // Still not stored (see `worldbook-settings.ts`), reported at the value
    // upstream ships so a card reading it gets ST's answer.
    overflow_alert: UPSTREAM_DEFAULTS.overflow_alert,
  }
}
