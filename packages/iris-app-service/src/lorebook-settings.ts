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
 * Only `selected_global_lorebooks` is a real Iris setting today; the rest are
 * upstream's defaults. That is stated rather than hidden: a card reading
 * `scan_depth` gets the number SillyTavern would have given it, and when Iris
 * grows a real setting for one of these, the value moves without the field
 * appearing or changing shape.
 * @param globalSelect - the globally selected book names.
 * @returns a fresh object each call, so a card scribbling on it changes nothing.
 */
export function lorebookSettings(globalSelect: readonly string[]): LorebookSettings {
  return {
    selected_global_lorebooks: [...globalSelect],
    ...UPSTREAM_DEFAULTS,
  }
}
