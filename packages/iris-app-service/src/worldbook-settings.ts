/**
 * The world-info settings this host actually runs on.
 *
 * Until now the activation engine ran on {@link DEFAULT_ACTIVATION_SETTINGS}
 * hard-coded fallbacks while the card-facing `getLorebookSettings()` reported
 * SillyTavern's defaults — two views of settings nobody could change, and on
 * `matchWholeWords` the two disagreed outright (engine substring-boundary,
 * facade substring). A book tuned on SillyTavern under-fired here with nothing
 * reporting why.
 *
 * These are the real stored knobs now. The names and defaults are ST's
 * (`world-info.js:69-82`), because a book's author tuned their entries against
 * those numbers and a plausible house default would re-decide what fires.
 *
 * Not stored here: `include_names` — verified dead in ST 1.18.0's Chat
 * Completion path (exported, set, never read while building the prompt) — and
 * `overflow_alert`, which is a UI notice this host has no surface for yet. Both
 * keep riding the card-facing {@link LorebookSettings} table so a card reading
 * them gets the number upstream would have handed it.
 *
 * @module @iris/app-service/worldbook-settings
 */

import type { InsertionStrategy } from '@iris/protocol'

import { invalid } from './errors.ts'

/**
 * The stored world-info settings, in ST's own vocabulary.
 *
 * Every field is optional in the file and present in the answer: an absent
 * field means "never set", and the answer is the stored values merged over the
 * defaults. A partial patch updates only the fields it carries.
 */
export interface WorldbookSettings {
  /** `world_info_depth` — how many messages back a scan reads. */
  scanDepth: number
  /** `world_info_budget` — a percentage of the context window. */
  budgetPercent: number
  /** `world_info_budget_cap` — an absolute token ceiling; `0` disables. */
  budgetCap: number
  /** `world_info_min_activations` — keep widening until this many fire. `0` disables. */
  minActivations: number
  /** `world_info_min_activations_depth_max` — how far that widening may reach. */
  minActivationsDepthMax: number
  /** `world_info_max_recursion_steps` — hard cap on scan loop iterations. */
  maxRecursionSteps: number
  /** `world_info_character_strategy` — how the global and character books interleave. */
  insertionStrategy: InsertionStrategy
  /** `world_info_recursive` — scan activated content for further matches. */
  recursive: boolean
  /** `world_info_case_sensitive` — the default an entry's `null` defers to. */
  caseSensitive: boolean
  /** `world_info_match_whole_words` — the default an entry's `null` defers to. */
  matchWholeWords: boolean
  /** `world_info_use_group_scoring` — resolve inclusion groups by key hits. */
  useGroupScoring: boolean
}

/**
 * ST's shipped defaults, read from `world-info.js:69-82` rather than chosen.
 *
 * The measured installation runs these values, so a book the user imports was
 * almost certainly tuned against them too.
 */
export const DEFAULT_WORLDBOOK_SETTINGS: WorldbookSettings = {
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  maxRecursionSteps: 0,
  insertionStrategy: 'character_first',
  recursive: false,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
}

/** Fields with an integer range; a value outside it is refused, not clamped. */
const NUMERIC_RANGES = {
  scanDepth: [0, 1000],
  budgetPercent: [0, 100],
  budgetCap: [0, 100_000_000],
  minActivations: [0, 1000],
  minActivationsDepthMax: [0, 1000],
  maxRecursionSteps: [0, 1000],
} as const satisfies Partial<Record<keyof WorldbookSettings, readonly [number, number]>>

const BOOLEAN_FIELDS = new Set(['recursive', 'caseSensitive', 'matchWholeWords', 'useGroupScoring'])
const STRATEGIES: readonly InsertionStrategy[] = ['evenly', 'character_first', 'global_first']

/**
 * Validate one world-info settings patch.
 *
 * A bad value is **refused, not clamped**: a scan depth silently snapped into
 * range would report saved and then do something else, and world-info settings
 * are exactly the kind of thing a user sets once and never re-reads. An unknown
 * key is ignored — that is the same reading `settings.set` gives the sampler,
 * and a UI sending a field this host has not grown yet should not have to gate
 * on the host's version.
 * @param patch - the raw patch from the wire or the UI.
 * @returns only the known fields, with their types confirmed.
 * @throws {AppError} `invalid-request` when a known field has the wrong type
 *   or falls outside its range.
 */
export function sanitizeWorldbookSettings(patch: Record<string, unknown>): Partial<WorldbookSettings> {
  const out: Partial<WorldbookSettings> = {}

  for (const [key, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw invalid(`"${key}" must be an integer between ${String(min)} and ${String(max)}`)
    }
    Object.assign(out, { [key]: value })
  }

  for (const key of BOOLEAN_FIELDS) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (typeof value !== 'boolean') throw invalid(`"${key}" must be a boolean`)
    Object.assign(out, { [key]: value })
  }

  if (Object.hasOwn(patch, 'insertionStrategy')) {
    const value = patch['insertionStrategy']
    if (typeof value !== 'string' || !STRATEGIES.includes(value as InsertionStrategy)) {
      throw invalid(`"insertionStrategy" must be one of ${STRATEGIES.join(', ')}`)
    }
    out.insertionStrategy = value as InsertionStrategy
  }

  return out
}

/**
 * Merge stored (possibly partial) settings over the defaults.
 * @param stored - what the settings file carries, when it carries anything.
 * @returns a complete settings table.
 */
export function resolveWorldbookSettings(stored?: Partial<WorldbookSettings>): WorldbookSettings {
  return { ...DEFAULT_WORLDBOOK_SETTINGS, ...stored }
}

/**
 * Map the stored settings onto the activation engine's knobs.
 *
 * A translation, not a rename: the engine's `budget` arrives separately (it
 * needs the context window, which belongs to the model), and the field names
 * differ where the engine speaks of the scan rather than of the setting. Kept
 * beside the settings module so the two vocabularies cannot drift apart in
 * silence — the engine reads only what this function hands it.
 * @param settings - the resolved stored settings.
 * @returns the engine-facing subset.
 */
export function activationSettingsOf(settings: WorldbookSettings): {
  scanDepth: number
  minActivations: number
  minActivationsDepthMax: number
  recursive: boolean
  maxRecursionSteps: number
  caseSensitive: boolean
  matchWholeWords: boolean
  useGroupScoring: boolean
} {
  return {
    scanDepth: settings.scanDepth,
    minActivations: settings.minActivations,
    minActivationsDepthMax: settings.minActivationsDepthMax,
    recursive: settings.recursive,
    maxRecursionSteps: settings.maxRecursionSteps,
    caseSensitive: settings.caseSensitive,
    matchWholeWords: settings.matchWholeWords,
    useGroupScoring: settings.useGroupScoring,
  }
}
