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
 * ~~Not stored here: `include_names` — verified dead in ST 1.18.0's Chat
 * Completion path (exported, set, never read while building the prompt).~~
 *
 * **That was wrong, and it is the reason this knob went unbuilt.** It is read
 * at `script.js:4565`, in `Generate()` at the function's own top level (brace
 * depth 1, no `main_api` guard), on the line that builds the world-info scan
 * buffer:
 *
 * ```js
 * const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
 * ```
 *
 * The Chat Completion path runs it like every other. What made "never read
 * while building the prompt" *feel* verified is that it is true of the prompt
 * — the buffer is for matching and never reaches the model — and the two were
 * one sentence. `include_names` decides what the scan reads, not what is sent.
 *
 * Nothing observed the gap because the reference install has
 * `world_info_settings.world_info_include_names: false`, which is exactly the
 * branch this host had hard-coded. The one machine available to disagree was
 * configured to agree. ST's own default is `true` (`world-info.js:74`), so a
 * default install is where the two part.
 *
 * Still not stored here: `overflow_alert`, a UI notice this host has no
 * surface for yet. It keeps riding the card-facing {@link LorebookSettings}
 * table so a card reading it gets the number upstream would have handed it.
 * It is therefore also the one key of the family that
 * {@link importWorldbookSettings} does not take from an installation — there is
 * no field to put it in, and inventing storage for a setting nothing reads
 * would make the import look more complete than the host is.
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
  /**
   * `world_info_include_names` — prefix each scanned message with its speaker.
   *
   * Changes what the scan *reads*, never what the model receives: the buffer
   * is built for matching only. With it on, an entry keyed on a character's
   * name fires on any line that character spoke; with it off, only on lines
   * that mention the name in their text.
   */
  includeNames: boolean
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
  includeNames: true,
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

const BOOLEAN_FIELDS = new Set(['recursive', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'includeNames'])
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
 * ST's key for each numeric knob, for the first-run import.
 *
 * Every value is a key of {@link NUMERIC_RANGES}, so the range a user's own
 * patch is checked against is the range an imported value is checked against —
 * one table, not a second one that can drift.
 */
const IMPORTED_NUMBERS = {
  world_info_depth: 'scanDepth',
  world_info_budget: 'budgetPercent',
  world_info_budget_cap: 'budgetCap',
  world_info_min_activations: 'minActivations',
  world_info_min_activations_depth_max: 'minActivationsDepthMax',
  world_info_max_recursion_steps: 'maxRecursionSteps',
} as const satisfies Record<string, keyof typeof NUMERIC_RANGES>

/** ST's key for each boolean knob. Every value is in {@link BOOLEAN_FIELDS}. */
const IMPORTED_BOOLEANS = {
  world_info_recursive: 'recursive',
  world_info_case_sensitive: 'caseSensitive',
  world_info_match_whole_words: 'matchWholeWords',
  world_info_use_group_scoring: 'useGroupScoring',
  world_info_include_names: 'includeNames',
} as const satisfies Record<string, keyof WorldbookSettings>

/**
 * `world_info_insertion_strategy` (`world-info.js:27-31`), indexed by its value.
 *
 * The one knob whose stored shape is not this host's: upstream persists
 * `world_info_character_strategy` as **`0 | 1 | 2`** and Iris stores the word,
 * so the import is a translation rather than a copy. The reference install
 * carries `1`, which is `character_first` — the same value Iris defaults to, so
 * this mapping is the part of the import that no real installation here can
 * disprove by agreeing with it.
 */
const STRATEGY_BY_NUMBER: readonly InsertionStrategy[] = ['evenly', 'character_first', 'global_first']

/**
 * The scan knobs this host models, with every ST key it reads them from.
 *
 * Exported for the test that pins the invariant: **every field of
 * {@link WorldbookSettings} has an ST key here.** A knob added to the model
 * without a key would import as its default and read as "the user's install
 * says so", which is the failure mode this list exists to make impossible.
 */
export const IMPORTED_WORLDBOOK_KEYS: Readonly<Record<keyof WorldbookSettings, string>> = {
  ...Object.fromEntries(Object.entries(IMPORTED_NUMBERS).map(([st, field]) => [field, st])),
  ...Object.fromEntries(Object.entries(IMPORTED_BOOLEANS).map(([st, field]) => [field, st])),
  insertionStrategy: 'world_info_character_strategy',
} as Record<keyof WorldbookSettings, string>

/** What a first-run import of an installation's scan knobs produced. */
export interface WorldbookImport {
  /** The knobs adopted, ready to store; absent fields keep their default. */
  settings: Partial<WorldbookSettings>
  /** One sentence per key that could not be adopted. Empty on a clean import. */
  reports: string[]
}

/**
 * Read ST's world-info scan knobs out of an installation's `settings.json`.
 *
 * **A migration convenience, not upstream behaviour**, and it runs once — on
 * the very first creation of a profile's settings file. See `DEVIATIONS.md`
 * §21 for why it is a deviation at all and why it is not a sync.
 *
 * Two shapes are accepted, because upstream accepts two:
 * `script.js:7954` calls `setWorldInfoSettings(settings.world_info_settings ??
 * settings, data)`, so the family lives under `world_info_settings` in a
 * current file and at the top level in an older one. Reading only the nested
 * shape would import nothing from a pre-migration install and report a clean
 * "nothing to take", which is a missing key wearing the face of a default.
 *
 * **Stricter than upstream on values, deliberately.** `setWorldInfoSettings`
 * coerces — `Number('deep')` is `NaN` and `Boolean('false')` is `true` — and
 * gets away with it because its result lives in a module variable that the next
 * settings write replaces. Here the value is *stored* into a profile, so a
 * `NaN` scan depth would persist and every later read would inherit it. A value
 * whose shape is wrong falls back to that one knob's default and says so; the
 * other knobs still import.
 * @param file - the parsed `settings.json`, whatever it turned out to be.
 * @returns the knobs to store and a line per key that fell back.
 */
export function importWorldbookSettings(file: unknown): WorldbookImport {
  const settings: Partial<WorldbookSettings> = {}
  const reports: string[] = []

  if (typeof file !== 'object' || file === null) {
    return {
      settings,
      reports: ['the installation\'s settings.json is not a JSON object;'
        + ' every scan knob starts at ST\'s own default'],
    }
  }

  const nested = (file as { world_info_settings?: unknown }).world_info_settings
  const source = (typeof nested === 'object' && nested !== null ? nested : file) as Record<string, unknown>

  for (const [key, field] of Object.entries(IMPORTED_NUMBERS)) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    const [min, max] = NUMERIC_RANGES[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      reports.push(`${key} is ${JSON.stringify(value) ?? 'undefined'}, not an integer between`
        + ` ${String(min)} and ${String(max)}; ${field} keeps its default`
        + ` ${String(DEFAULT_WORLDBOOK_SETTINGS[field])}`)
      continue
    }
    Object.assign(settings, { [field]: value })
  }

  for (const [key, field] of Object.entries(IMPORTED_BOOLEANS)) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    if (typeof value !== 'boolean') {
      reports.push(`${key} is ${JSON.stringify(value) ?? 'undefined'}, not a boolean;`
        + ` ${field} keeps its default ${String(DEFAULT_WORLDBOOK_SETTINGS[field])}`)
      continue
    }
    Object.assign(settings, { [field]: value })
  }

  if (Object.hasOwn(source, 'world_info_character_strategy')) {
    const value = source['world_info_character_strategy']
    const strategy = typeof value === 'number' ? STRATEGY_BY_NUMBER[value] : undefined
    if (strategy === undefined) {
      reports.push(`world_info_character_strategy is ${JSON.stringify(value) ?? 'undefined'}, not one of`
        + ` ${STRATEGY_BY_NUMBER.map((name, index) => `${String(index)} (${name})`).join(', ')};`
        + ` insertionStrategy keeps its default ${DEFAULT_WORLDBOOK_SETTINGS.insertionStrategy}`)
    } else {
      settings.insertionStrategy = strategy
    }
  }

  return { settings, reports }
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
