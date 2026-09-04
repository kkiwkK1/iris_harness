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
import type { GenerationSettings, ReasoningEffort } from '@iris/protocol'

import { invalid } from './errors.ts'

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
   * names is neither. Upstream keeps this apart too — `globalSelect` lives
   * under `world_info_settings.world_info`, not beside the sampler.
   */
  worldbooks?: { globalSelect: string[] }
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
    } catch {
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
   * Deliberately not migrated from a SillyTavern installation: importing
   * settings is its own unstarted piece of work, and silently adopting another
   * application's live selection would make this host's prompts depend on that
   * application's current state. A user moving across re-selects their global
   * books once.
   * @param names - book names, verbatim.
   */
  async setGlobalSelect(names: readonly string[]): Promise<void> {
    this.#file.worldbooks = { globalSelect: [...names] }
    await this.save()
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

  return { set, clear }
}
