/**
 * The model route and sampling, globally and per chat.
 *
 * Two layers rather than one because that is how the feature is actually used:
 * a user sets a temperature they like once, then nudges it for the one
 * conversation that needs it. Storing only the merged result would make the
 * global default unrecoverable the moment any chat overrode it.
 *
 * @module @iris/app-service/settings
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ChatCompletionPreset } from '@iris/preset'
import type { ContinuePostfix, GenerationSettings, ReasoningEffort } from '@iris/protocol'

import { invalid } from './errors.ts'
import {
  resolveWorldbookSettings, sanitizeWorldbookSettings,
  type WorldbookImport, type WorldbookSettings,
} from './worldbook-settings.ts'

/** Numeric sampling fields, with the range each is accepted in. */
const NUMERIC_FIELDS = {
  temperature: [0, 5],
  maxTokens: [1, 1_000_000],
  contextWindow: [1, 4_000_000],
  topP: [0, 1],
  topK: [0, 10_000],
  minP: [0, 1],
  repetitionPenalty: [0, 4],
  frequencyPenalty: [-2, 2],
  presencePenalty: [-2, 2],
  seed: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
} as const satisfies Partial<Record<keyof GenerationSettings, readonly [number, number]>>

/**
 * The reasoning-effort values upstream accepts, verbatim.
 *
 * `reasoning_effort_types` (openai.js:237): six words, and nothing else a
 * client may send — an unknown level would either be refused by the provider
 * or silently ignored by it, and neither failure says where it came from.
 */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'min', 'max']

/**
 * The continue-postfix words upstream's radio group stands for, mapped onto
 * the separators they send (`continue_postfix_types`, openai.js:211). The
 * words travel the wire; the separators reach the prompt.
 */
export const CONTINUE_POSTFIX_SEPARATORS: Record<ContinuePostfix, string> = {
  none: '',
  space: ' ',
  newline: '\n',
  double: '\n\n',
}

const CONTINUE_POSTFIXES = Object.keys(CONTINUE_POSTFIX_SEPARATORS) as readonly ContinuePostfix[]

/**
 * Boolean reply-shaping fields, each named after the upstream key it maps.
 *
 * A boolean gets the same three-case treatment as every other field: omitted
 * leaves it alone, `null` clears the override, and a non-boolean value is
 * refused — a `"true"` string would read as on forever and never say why.
 */
const BOOLEAN_FIELDS = ['trimSentences', 'squashSystemMessages'] as const satisfies
  readonly (keyof GenerationSettings)[]

/**
 * One character's additional book bindings, in upstream's own shape.
 *
 * `world_info.charLore[]` (`world-info.js:6039`): a row per character that has
 * at least one extra book, keyed by the character's **file name** —
 * `getCharaFilename`'s stem, which is what this host's `characterId` already
 * is (the card file's name without its extension). The row exists only while
 * the list is non-empty: upstream's writer splices it when the last book is
 * unbound (`world-info.js:6044`), and so does the write here.
 */
export interface WorldbookCharLoreRow {
  /** The character file stem this row binds books to. */
  name: string
  /** Additional book names, in the order the user bound them. */
  extraBooks: string[]
}

/** What one settings file holds. */
interface SettingsFile {
  global: GenerationSettings
  /** Per-chat overrides, keyed by chat id. */
  chats: Record<string, Partial<GenerationSettings>>
  /**
   * World book settings, which are installation-wide rather than per chat.
   *
   * Its own section rather than a field of {@link GenerationSettings}: that
   * type is merged per chat and range-checked as numbers, and a list of book
   * names is neither. Upstream keeps this apart too — `globalSelect` and
   * `charLore` live under `world_info_settings.world_info`, not beside the
   * sampler.
   */
  worldbooks?: {
    globalSelect: string[]
    /** The scan knobs, stored only when the user has set at least one. */
    settings?: Partial<WorldbookSettings>
    /** Rows only for characters with at least one additional book. */
    charLore?: WorldbookCharLoreRow[]
  }
  /**
   * The active preset and the prompt manager's state on top of it.
   *
   * Present only once a switch or an edit has happened: a host still running
   * on its configured file carries no section at all, which is what makes the
   * configuration the authority while it is the only decision ever made.
   * Upstream's equivalent is the `prompts` / `prompt_order` /
   * `preset_settings_openai` triple inside `oai_settings`, persisted in its
   * settings.json the same way.
   */
  preset?: { name?: string, body: ChatCompletionPreset }
}

/** Fields of {@link GenerationSettings} that may simply be absent. */
type OptionalField = Exclude<keyof GenerationSettings, 'provider' | 'model'>

/** What one `settings.set` patch asks for. */
export interface SettingsPatch {
  /** Fields to write. */
  set: Partial<GenerationSettings>
  /** Fields whose override is being removed, so the layer below shows through. */
  clear: (keyof GenerationSettings)[]
}

/** Reads, merges and persists generation settings. */
export class SettingsStore {
  readonly #path: string
  /** The configured route, kept so a cleared global field has something to fall back to. */
  readonly #defaults: GenerationSettings
  #file: SettingsFile
  /**
   * Whether `load` found a file: `undefined` until it has run at all.
   *
   * Three states rather than two, because {@link seedWorldbookSettings} keys a
   * one-time migration off "this profile is brand new" and the difference
   * between *no file* and *not looked yet* is the whole safety of that. A
   * caller that seeds before loading gets no import — a missed convenience —
   * rather than a seed written over settings that were already on disk.
   */
  #found: boolean | undefined

  /**
   * @param path - the JSON file backing the store.
   * @param defaults - the route to use before anything has been configured.
   */
  constructor(path: string, defaults: GenerationSettings) {
    this.#path = path
    this.#defaults = defaults
    this.#file = { global: defaults, chats: {} }
  }

  /**
   * Read the file, keeping the constructed defaults when there is none.
   *
   * A malformed file is ignored rather than fatal: a broken settings file must
   * not stop the host from starting, because then there is no way to fix it
   * from the UI that the file broke.
   */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#path, 'utf8')
      this.#found = true
    } catch {
      this.#found = false
      return
    }
    try {
      const parsed = JSON.parse(text) as Partial<SettingsFile>
      const preset = this.#validatedPreset(parsed.preset)
      this.#file = {
        global: { ...this.#file.global, ...parsed.global },
        chats: parsed.chats ?? {},
        // A section that fails its one invariant is not a state to restore: the
        // active preset must be a preset, or the first generation would fail
        // somewhere far from the file that caused it.
        ...preset === undefined ? {} : { preset },
        // Carried through, not derived: **this line is a fix, not a refactor.**
        // `load` rebuilds `#file` wholesale, and an earlier version stopped at
        // `chats` — so the `worldbooks` section this store writes survived only
        // until the next restart, and a user's global selection silently
        // reset. Whatever the file holds is what the store holds.
        ...(parsed.worldbooks === undefined ? {} : { worldbooks: parsed.worldbooks }),
      }
    } catch {
      // Keep the defaults.
    }
  }

  /**
   * The stored preset section, when it still names a real preset.
   * @param section - what the file carried.
   * @returns the section, or undefined when it is not one.
   */
  #validatedPreset(section: SettingsFile['preset']): SettingsFile['preset'] {
    if (section === undefined || typeof section !== 'object') return undefined
    if (section.body === undefined || (section.body as { prompts?: unknown }).prompts === undefined) return undefined
    return section
  }

  /**
   * The settings one chat runs with.
   * @param chatId - the chat, or absent for the global defaults.
   * @returns the merged settings.
   */
  get(chatId?: string): GenerationSettings {
    if (chatId === undefined) return { ...this.#file.global }
    return { ...this.#file.global, ...this.#file.chats[chatId] }
  }

  /**
   * Apply a patch and persist it.
   *
   * Three cases, per the contract: an omitted key leaves the field alone, an
   * explicit `null` removes the override so the layer below shows through, and
   * an unknown key is dropped. The middle one is what a "use host default"
   * control sends, and without it that control would silently do nothing.
   * @param chatId - the chat to scope the patch to, or absent for the global layer.
   * @param patch - the fields to change.
   * @returns the merged settings after the change.
   * @throws {AppError} `invalid-request` when a known field has the wrong type
   *   or falls outside its range.
   */
  async set(chatId: string | undefined, patch: Record<string, unknown>): Promise<GenerationSettings> {
    const { set, clear } = sanitize(patch)

    if (chatId === undefined) {
      const global: GenerationSettings = { ...this.#file.global, ...set }
      for (const key of clear) {
        // Nothing sits below the global layer, so clearing here means returning
        // to what the composition configured. `provider` and `model` are not
        // optional in the wire shape, so they are restored rather than removed;
        // everything else goes absent and the adapter's own default applies.
        if (key === 'provider' || key === 'model') global[key] = this.#defaults[key]
        else delete global[key as OptionalField]
      }
      this.#file.global = global
    } else {
      const override: Partial<GenerationSettings> = { ...this.#file.chats[chatId], ...set }
      for (const key of clear) delete override[key]
      // An empty override is noise in the file, and would otherwise accumulate
      // one entry per chat the user ever opened a settings panel on.
      if (Object.keys(override).length === 0) delete this.#file.chats[chatId]
      else this.#file.chats[chatId] = override
    }

    await this.save()
    return this.get(chatId)
  }

  /**
   * Drop a chat's overrides, when its conversation is deleted.
   * @param chatId - the chat.
   */
  /**
   * The books injected into every chat, whatever character is playing.
   *
   * Upstream's `world_info.globalSelect`. Names verbatim, because a book's
   * name is its identity and 13 of 18 real names change under `toId`.
   * @returns the selected names, empty when none are.
   */
  globalSelect(): string[] {
    return [...this.#file.worldbooks?.globalSelect ?? []]
  }

  /**
   * Choose the books injected into every chat.
   *
   * Deliberately not migrated from a SillyTavern installation, and **the
   * reason narrowed on 2026-09-07 rather than going away**: importing settings
   * used to be an unstarted piece of work outright, and now
   * {@link seedWorldbookSettings} does import the scan knobs from the same
   * `world_info_settings` section this selection lives in. This one still does
   * not travel, because it is not a knob — silently adopting another
   * application's live *selection* would make this host's prompts depend on
   * that application's current state. A user moving across re-selects their
   * global books once.
   * @param names - book names, verbatim.
   */
  async setGlobalSelect(names: readonly string[]): Promise<void> {
    // The scan settings and the per-character bindings inside the section are
    // preserved, not reset: the selection, the knobs and the bindings are
    // unrelated facts, and rewriting one must not silently undo the others.
    const section = this.#file.worldbooks ?? { globalSelect: [] }
    this.#file.worldbooks = {
      ...section,
      globalSelect: [...names],
    }
    await this.save()
  }

  /**
   * The additional books one character is bound to, in binding order.
   *
   * Upstream's read half of `world_info.charLore`: `getCharacterLore` finds the
   * row whose `name` is the character's file stem and takes its `extraBooks`.
   * A character with no row — the normal case, and the case after an unbind —
   * answers empty rather than absent, so a caller never branches on undefined.
   * @param characterId - the character file stem.
   * @returns the bound names; empty when none are.
   */
  charBooks(characterId: string): string[] {
    const row = this.#file.worldbooks?.charLore?.find(row => row.name === characterId)
    return row === undefined ? [] : [...row.extraBooks]
  }

  /**
   * Replace one character's additional books, and persist.
   *
   * A **whole-list** write, matching upstream's `updateAuxBooks`
   * (`world-info.js:6039`): the caller computes the next list, this stores it.
   * Three properties carried over from that function because each one is a
   * behaviour a caller can observe:
   *
   * 1. **Duplicates collapse to their first occurrence.** Upstream normalises
   *    the array (`normalizeArray`) before storing; a doubled name would
   *    otherwise load the same book twice into one scan.
   * 2. **An empty list removes the row entirely.** Not an empty `extraBooks`
   *    beside the name — the row is spliced out (`world-info.js:6044`), so an
   *    unbound character leaves no key behind. This is the "解绑不留残键"
   *    property, and it is upstream's own, not an addition.
   * 3. **The other rows, the global selection and the scan knobs survive.**
   *    The section is amended, not rewritten.
   *
   * Not written anywhere near the card file: the binding is runtime state about
   * an installation, and the card file is shared between installations.
   * @param characterId - the character file stem to bind under.
   * @param names - the additional book names, in the order to keep.
   * @returns the stored list after normalisation, read back.
   */
  async setCharBooks(characterId: string, names: readonly string[]): Promise<string[]> {
    const next: string[] = []
    for (const name of names) {
      if (!next.includes(name)) next.push(name)
    }

    const rest = (this.#file.worldbooks?.charLore ?? []).filter(row => row.name !== characterId)
    const { charLore: _dropped, ...keep } = this.#file.worldbooks ?? { globalSelect: [] as string[] }
    this.#file.worldbooks = {
      ...keep,
      // `_dropped` is not spread through: an unbind that contributed no key of
      // its own would otherwise restore exactly the row it was removing.
      ...(next.length === 0
        ? rest.length === 0 ? {} : { charLore: rest }
        : { charLore: [...rest, { name: characterId, extraBooks: next }] }),
    }
    await this.save()
    return [...next]
  }

  /**
   * The world-info settings this host runs its scans on.
   *
   * Stored values merged over ST's defaults, so the answer is always complete:
   * the caller deciding what a scan should do must not have to know which knobs
   * the user has ever touched.
   * @returns the effective settings.
   */
  worldbookSettings(): WorldbookSettings {
    return resolveWorldbookSettings(this.#file.worldbooks?.settings)
  }

  /**
   * Apply a world-info settings patch and persist it.
   *
   * An omitted field leaves the stored value alone; clearing is expressed by
   * sending the default. The `globalSelect` write above replaces the whole
   * `worldbooks` section wholesale — wrong for a list of unrelated scan knobs,
   * which is why this patch keeps the section it was given and amends the
   * settings block inside it.
   * @param patch - the fields to change; unknown fields are refused by name.
   * @returns the effective settings after the change.
   */
  async setWorldbookSettings(patch: Record<string, unknown>): Promise<WorldbookSettings> {
    const set = sanitizeWorldbookSettings(patch)
    const section = this.#file.worldbooks ?? { globalSelect: [] }
    this.#file.worldbooks = {
      ...section,
      settings: { ...section.settings, ...set },
    }
    await this.save()
    return this.worldbookSettings()
  }

  /**
   * Seed the scan knobs from a SillyTavern installation, once per profile.
   *
   * Runs only when `load` found **no file** — a profile being created right
   * now. An existing profile is never touched, whatever the installation says:
   * the user's knobs here are their own decisions, and a host that re-read
   * another application's settings on every boot would quietly undo them. That
   * is why this is a seed and not a sync (`DEVIATIONS.md` §21).
   *
   * **The read is a callback, not a value.** An existing profile must not even
   * open the installation's `settings.json`, and passing an already-read import
   * would make that property depend on the caller checking first — the kind of
   * ordering that survives review and then dies in a refactor. Here the
   * installation is untouched unless this store asks.
   * @param read - fetches the installation's knobs; called at most once, ever.
   * @returns the report lines to hand the host's log, empty when there are none.
   */
  async seedWorldbookSettings(read: () => Promise<WorldbookImport>): Promise<string[]> {
    if (this.#found !== false) return []
    // Marked before the read, not after it: "at most once, ever" is the whole
    // contract, and a second call — from a retry, or from a composition that
    // grew a second boot path — must not reopen the install even when the first
    // one found nothing to take.
    this.#found = true
    const { settings: imported, reports } = await read()
    if (Object.keys(imported).length > 0) {
      const section = this.#file.worldbooks ?? { globalSelect: [] }
      // Imported values go *under* anything already in the section, not over
      // it. On a first run there is nothing there, so the order is invisible —
      // it is here so that the day something else writes the section before the
      // seed runs, the seed loses rather than silently wins.
      this.#file.worldbooks = { ...section, settings: { ...imported, ...section.settings } }
      await this.save()
    }
    return reports
  }

  /**
   * The active preset's name, when it came from the library.
   *
   * Upstream's `preset_settings_openai`. Absent means the host is still
   * assembling with what its composition configured — a state upstream cannot
   * represent and this one can, because the configured file is a decision the
   * composition owns rather than one the user made here.
   * @returns the name, or undefined.
   */
  presetName(): string | undefined {
    return this.#file.preset?.name
  }

  /**
   * The prompt manager's live state: the active preset's body.
   *
   * Undefined until a switch or an edit first happens, and that absence is
   * load-bearing — the assembler falls back to the configured preset for it,
   * which is what keeps a config-driven host config-driven.
   * @returns the active preset body, or undefined.
   */
  presetBody(): ChatCompletionPreset | undefined {
    return this.#file.preset?.body
  }

  /**
   * Replace the active preset and persist it.
   *
   * Whole-body replacement rather than a merge, on purpose: this is what a
   * switch means (upstream copies the preset's fields over `oai_settings` and
   * keeps nothing of what was there), and a merge would turn "switch" into
   * "sometimes switch".
   * @param name - the library name, when it has one.
   * @param body - the preset the manager now runs on.
   */
  async setPreset(name: string | undefined, body: ChatCompletionPreset): Promise<void> {
    this.#file.preset = { ...name === undefined ? {} : { name }, body }
    await this.save()
  }

  async forget(chatId: string): Promise<void> {
    if (this.#file.chats[chatId] === undefined) return
    delete this.#file.chats[chatId]
    await this.save()
  }

  /** Write the file, creating its directory on a first run. */
  async save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`, 'utf8')
  }
}

/**
 * Split a wire patch into writes and clears, refusing malformed values.
 *
 * Silently dropping a bad value would be worse than refusing it: the user would
 * see their temperature change reported as saved and then not applied. An
 * unknown key is a different matter — it is not a value at all, so it is
 * ignored rather than refused.
 *
 * Presence is tested with `hasOwn` rather than against `undefined`, so a key
 * that is genuinely absent and a key explicitly set to `null` stay
 * distinguishable — that distinction is the whole feature.
 * @param patch - the raw patch from the wire.
 * @returns the fields to write and the fields to un-set.
 * @throws {AppError} `invalid-request` for a known field of the wrong shape.
 */
export function sanitize(patch: Record<string, unknown>): SettingsPatch {
  const set: Partial<GenerationSettings> = {}
  const clear: (keyof GenerationSettings)[] = []

  for (const key of ['provider', 'model'] as const) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (value === null) {
      clear.push(key)
      continue
    }
    if (typeof value !== 'string' || value.length === 0) throw invalid(`"${key}" must be a non-empty string`)
    set[key] = value
  }

  for (const [key, [min, max]] of Object.entries(NUMERIC_FIELDS)) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (value === null) {
      clear.push(key as keyof GenerationSettings)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw invalid(`"${key}" must be a number between ${String(min)} and ${String(max)}`)
    }
    Object.assign(set, { [key]: key === 'maxTokens' || key === 'topK' || key === 'seed' ? Math.round(value) : value })
  }

  if (Object.hasOwn(patch, 'stop')) {
    const stop = patch['stop']
    if (stop === null) clear.push('stop')
    else if (!Array.isArray(stop) || stop.some(entry => typeof entry !== 'string')) {
      throw invalid('"stop" must be an array of strings')
    } else {
      set.stop = stop as string[]
    }
  }

  if (Object.hasOwn(patch, 'reasoningEffort')) {
    const value = patch['reasoningEffort']
    if (value === null) clear.push('reasoningEffort')
    else if (typeof value !== 'string' || !REASONING_EFFORTS.includes(value as ReasoningEffort)) {
      throw invalid(`"reasoningEffort" must be one of ${REASONING_EFFORTS.join(', ')}`)
    } else {
      set.reasoningEffort = value as ReasoningEffort
    }
  }

  if (Object.hasOwn(patch, 'continuePostfix')) {
    const value = patch['continuePostfix']
    if (value === null) clear.push('continuePostfix')
    else if (typeof value !== 'string' || !CONTINUE_POSTFIXES.includes(value as ContinuePostfix)) {
      throw invalid(`"continuePostfix" must be one of ${CONTINUE_POSTFIXES.join(', ')}`)
    } else {
      set.continuePostfix = value as ContinuePostfix
    }
  }

  for (const key of BOOLEAN_FIELDS) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (value === null) {
      clear.push(key)
      continue
    }
    if (typeof value !== 'boolean') throw invalid(`"${key}" must be a boolean`)
    Object.assign(set, { [key]: value })
  }

  return { set, clear }
}
