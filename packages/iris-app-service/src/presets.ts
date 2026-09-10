/**
 * The profile's preset library, beside the installation.
 *
 * Upstream keeps Chat Completion presets as one JSON file per preset in
 * `data/<user>/OpenAI Settings/`, addressed by name (`src/endpoints/presets.js`
 * sanitizes the name and writes the body; the frontend addresses them by that
 * name through `preset_settings_openai`). One file per preset, named by it, is
 * the whole storage model — so this store is a folder plus the four file
 * operations, and the interesting part is elsewhere: which preset is *active*,
 * and what a switch applies. That lives in the settings store and the service.
 *
 * **Read-only towards the SillyTavern install.** Importing copies files in;
 * nothing here writes there, the same rule the world books keep.
 *
 * @module @iris/app-service/presets
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  toTavernHelperPreset,
  trimPresetForFrame,
  type TavernHelperPreset,
} from '@iris/compat-tavernhelper'
import type { ChatCompletionPreset } from '@iris/preset'
import type { GenerationSettings } from '@iris/protocol'

import { invalid, notFound } from './errors.ts'
import { fileFor, isSafeId } from './paths.ts'

// —— family③: preset ——

/**
 * The live settings, written back into the file field names a preset uses.
 *
 * The exact inverse of `presetScalarPatch` (service.ts), and the pairing is the
 * point rather than a nicety: a switch copies a preset's scalar fields *out*
 * into the global settings layer, so from that moment the layer — not the
 * body — is what the host generates with. `getPreset('in_use')` has to report
 * what will actually be sent, which means reading the same fields back. Reading
 * them off the body instead would answer with the temperature the preset
 * shipped while the host generates at the one the user has since typed, and
 * nothing in the answer would say so.
 *
 * Upstream faces the same split and solves it the same way — `toPreset(…, {
 * in_use: true })` reads `preset.temp_openai` (the running value) where a named
 * preset reads `preset.temperature` (the stored one), `preset.ts:441-448`.
 * Hence the `*_openai` spellings here: they are the "in use" half of that pair,
 * and {@link toTavernHelperPreset} reads exactly those for `'in_use'`.
 *
 * **Only the fields this host acts on.** `top_a`, `n`, `stream_openai`,
 * `show_thoughts`, `request_images`, `function_calling`, `enable_web_search`,
 * `image_inlining`, `video_inlining`, `names_behavior` and `wrap_in_quotes`
 * have no Iris equivalent, so they are absent here and the *body's* own values
 * stand — which is the honest answer: the body is the last thing that said
 * anything about them. DEVIATIONS host §65 carries the field-by-field table.
 * @param settings - the global generation settings.
 * @returns a patch of preset-file field names, carrying only what is set.
 */
export function livePresetFields(settings: GenerationSettings): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const put = (key: string, value: number | boolean | string | undefined): void => {
    if (value !== undefined) patch[key] = value
  }
  put('openai_max_context', settings.contextWindow)
  put('openai_max_tokens', settings.maxTokens)
  put('temp_openai', settings.temperature)
  put('freq_pen_openai', settings.frequencyPenalty)
  put('pres_pen_openai', settings.presencePenalty)
  put('top_p_openai', settings.topP)
  put('repetition_penalty_openai', settings.repetitionPenalty)
  put('min_p_openai', settings.minP)
  put('top_k_openai', settings.topK)
  put('seed', settings.seed)
  put('squash_system_messages', settings.squashSystemMessages)
  put('reasoning_effort', settings.reasoningEffort)
  put('max_context_unlocked', settings.contextUnlocked)
  return patch
}

/**
 * Give an order-less preset the ordering its assembly already implies.
 *
 * Upstream's `getPreset` reads `prompt_order[100001]` and puts every prompt the
 * ordering does not name into `prompts_unused` (`preset.ts:402-410`), so a file
 * carrying no ordering at all comes back with `prompts: []`. On SillyTavern
 * that state is unreachable — its prompt manager writes an ordering the moment
 * a preset is selected — but here it is ordinary, because this host reads
 * preset files straight off a disk, and two of the eight in the local corpora
 * are hand-written.
 *
 * Answering `prompts: []` for such a preset would tell a card that nothing is
 * in the prompt list while the assembler runs every entry of it
 * (`resolveOrder`'s own file-order fallback). A card reads a preset in order to
 * reason about what the model will be sent, so the answer that matches the
 * assembler is the correct one. Deliberate divergence, recorded in host §65;
 * the seeding is the same one `withSeededOrder` does for the prompt manager,
 * for the same reason.
 * @param preset - the stored body.
 * @returns a body carrying the global ordering group, unchanged if it had one.
 */
export function withTavernHelperOrder(preset: ChatCompletionPreset): ChatCompletionPreset {
  const orders = preset.prompt_order ?? []
  if (orders.some(entry => entry.character_id === TH_ORDER_ID)) return preset
  return {
    ...preset,
    prompt_order: [
      ...orders,
      {
        character_id: TH_ORDER_ID,
        order: preset.prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })),
      },
    ],
  }
}

/**
 * The ordering group both sides read, 100001.
 *
 * `@iris/preset`'s `GLOBAL_ORDER_ID` and
 * `@iris/compat-tavernhelper-core`'s `TH_ORDER_CHARACTER_ID` are the same
 * number for the same reason; this module names it once more only because it is
 * the one that has to agree with **both**, and `presets.test.ts` pins all three
 * equal.
 */
const TH_ORDER_ID = 100001

/**
 * The largest card-facing preset this host will hand a frame, in bytes of JSON.
 *
 * A policy number, not a measurement, and the distinction matters because a
 * constant that encodes a measurement drifts silently. What is measured is
 * beside it: over the eight real presets in the two local corpora on
 * 2026-09-10, the trimmed card-facing body runs 1.4 KiB to 720 KiB, and it is
 * structured-cloned once per live frame — 12.7 MiB per reading window at
 * `FRAME_COUNT_LIMIT` 18 for the largest. This ceiling sits above all eight on
 * purpose: it is not tuning, it is the guard that stops a preset nobody has
 * measured from turning one card's synchronous read into a page that never
 * paints. Past it, `getPreset('in_use')` throws with the size in the sentence.
 */
export const FRAME_PRESET_LIMIT = 2 * 1024 * 1024

/**
 * One preset as a card sees it.
 *
 * @param body - the stored preset body.
 * @param options - `live` supplies the running settings, which marks this as
 *   the `'in_use'` reading; absent means a named library preset, read as
 *   stored. `forFrame` trims the extension sub-trees that cannot be
 *   structured-cloned once per live frame — see `trimPresetForFrame`.
 * @returns the card-facing preset.
 */
export function cardFacingPreset(
  body: ChatCompletionPreset,
  options: { live?: GenerationSettings, forFrame?: boolean } = {},
): TavernHelperPreset {
  const preset = toTavernHelperPreset(
    withTavernHelperOrder(body),
    options.live === undefined ? {} : { live: livePresetFields(options.live) },
  )
  return options.forFrame === true ? trimPresetForFrame(preset) : preset
}

// —— family③ end ——

/**
 * Turn a preset name into the file stem we would store it under.
 *
 * The same character classes upstream's `sanitize-filename` strips through
 * `stFileName` — illegal characters, control characters, reserved device
 * names, trailing dots and spaces — because a preset **imported** from an
 * install must keep the name the install knows it by, or switching back and
 * forth across imports would fork one preset into two spellings.
 * @param name - the preset's name, straight off the wire or off a disk.
 * @returns a safe stem, never empty.
 */
export function sanitizePresetName(name: string): string {
  const illegal = /[/?<>\\:*|"]/gu
  const control = /[\u0000-\u001f\u0080-\u009f]/gu
  const reserved = /^\.+$/u
  const windowsReserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/iu
  const trailing = /[. ]+$/u

  let cleaned = name
    .replace(illegal, '')
    .replace(control, '')
    .replace(reserved, '')
    .replace(trailing, '')
  if (windowsReserved.test(cleaned)) cleaned = ''

  const bytes = Buffer.from(cleaned, 'utf8')
  cleaned = bytes.length <= 255 ? cleaned : Buffer.from(bytes.subarray(0, 255)).toString('utf8')
  if (cleaned.length === 0 || !isSafeId(cleaned)) {
    throw invalid(`"${name}" is not a usable preset name`)
  }
  return cleaned
}

/**
 * Whether a parsed file is a Chat Completion preset at all.
 *
 * The one thing every real preset carries and nothing else does is a `prompts`
 * array — the same check `loadPreset` has always applied to the configured
 * file, now applied to every file in the library.
 * @param value - the parsed JSON.
 * @returns the preset, or undefined when the file is something else.
 */
export function asPreset(value: unknown): ChatCompletionPreset | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { prompts?: unknown }
  if (!Array.isArray(candidate.prompts)) return undefined
  return value as ChatCompletionPreset
}

/** Why an install preset could not be imported. Each needs a different sentence. */
export type ImportSkip =
  | 'not-configured'
  | 'absent'
  | 'unreadable'
  | 'not-a-preset'

/** What one name's import produced. */
export type ImportOutcome =
  | { name: string, imported: true }
  | { name: string, imported: false, why: ImportSkip }

/**
 * The fields upstream treats as sensitive on hand import (`openai.js`
 * `sensitiveFields`): proxy routes, proxy credentials, custom endpoints and
 * provider identifiers. Upstream asks the reader about each one — cancel,
 * strip them, or import as-is. This host reads none of them (the route lives
 * in the connection settings), but a file carrying a password should be
 * *said*, not silently stored and not silently stripped.
 */
const SENSITIVE_FIELDS: readonly string[] = [
  'reverse_proxy',
  'proxy_password',
  'custom_url',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
  'vertexai_region',
  'vertexai_express_project_id',
  'azure_base_url',
  'azure_deployment_name',
  'workers_ai_account_id',
]

/** Why a hand-carried file could not come in. Each needs a different sentence. */
export type FileImportSkip =
  | 'invalid-json'
  | 'not-a-preset'
  | 'unusable-name'

/** What one hand-carried file produced. */
export type FileImportOutcome =
  | { name: string, imported: true, overwritten: boolean, sensitive: readonly string[] }
  | { name: string, imported: false, reason: FileImportSkip }

/** Reads, writes and imports the profile's preset files. */
export class PresetStore {
  readonly #dir: string

  /**
   * @param dir - the profile's `presets` directory, which need not exist yet.
   */
  constructor(dir: string) {
    this.#dir = dir
  }

  /**
   * Every preset in the library, by name.
   *
   * Files that do not parse as presets are skipped rather than listed: the
   * directory may hold anything a user dropped there, and a broken file in the
   * picker is worse than an absent one.
   * @returns the names, sorted as the filesystem spells them.
   */
  async list(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.#dir)
    } catch {
      // No directory yet: a fresh profile has no presets, which is a state, not
      // an error.
      return []
    }
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const preset = await this.#tryReadFile(join(this.#dir, entry))
      if (preset !== undefined) names.push(entry.slice(0, -'.json'.length))
    }
    return names.sort((left, right) => left.localeCompare(right))
  }

  /**
   * One preset, by the name it is stored under.
   * @param name - the preset's name.
   * @returns the parsed preset.
   * @throws {AppError} `not-found` when no preset has that name.
   */
  async read(name: string): Promise<ChatCompletionPreset> {
    const path = fileFor(this.#dir, sanitizePresetName(name), '.json')
    const preset = await this.#tryReadFile(path)
    if (preset === undefined) throw notFound(`no preset "${name}" in the library`)
    return preset
  }

  /**
   * Whether a preset is in the library, without reading it.
   * @param name - the preset's name.
   * @returns true when a readable preset file has that name.
   */
  async has(name: string): Promise<boolean> {
    try {
      return await this.read(name) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Write one preset into the library, creating the folder on a first save.
   * @param name - the name to store it under.
   * @param preset - the body; must carry a `prompts` array.
   * @throws {AppError} `invalid-request` when the body is not a preset.
   */
  async save(name: string, preset: ChatCompletionPreset): Promise<void> {
    if (asPreset(preset) === undefined) {
      throw invalid(`"${name}" is not a SillyTavern Chat Completion preset: no "prompts" array`)
    }
    const path = fileFor(this.#dir, sanitizePresetName(name), '.json')
    await mkdir(dirname(path), { recursive: true })
    // Four-space indent, because that is what upstream's endpoint writes
    // (`presets.js`) and what every preset on a user's disk is formatted with —
    // a round trip through this store should not show as a full-file diff.
    await writeFile(path, `${JSON.stringify(preset, null, 4)}\n`, 'utf8')
  }

  /**
   * Remove a preset from the library.
   * @param name - the preset's name.
   * @throws {AppError} `not-found` when no preset has that name.
   */
  async delete(name: string): Promise<void> {
    const path = fileFor(this.#dir, sanitizePresetName(name), '.json')
    try {
      await unlink(path)
    } catch {
      throw notFound(`no preset "${name}" in the library`)
    }
  }

  /**
   * Copy presets out of a SillyTavern profile, read-only.
   *
   * A name already in the library is **overwritten**, on purpose: an import is
   * a re-read of a source of truth, and keeping a stale local copy because one
   * existed would make "import" mean "import sometimes". Upstream's own import
   * UI says the same thing in so many words — existing prompts with the same
   * ID are overridden.
   * @param installDir - the SillyTavern **profile** directory (`data/<user>`).
   * @param names - which presets; absent means every one the install has.
   * @returns one outcome per requested or discovered name.
   */
  async importFrom(installDir: string | undefined, names?: readonly string[]): Promise<ImportOutcome[]> {
    if (installDir === undefined) {
      // The one refusal with no per-name meaning — but when names were asked
      // for, they carry the report, so the picker can say which row failed.
      return (names ?? ['(install)']).map(name => ({ name, imported: false, why: 'not-configured' as const }))
    }
    const source = join(installDir, 'OpenAI Settings')

    // Discover when asked for everything; filter when asked for some.
    let available: string[]
    try {
      available = (await readdir(source)).filter(entry => entry.endsWith('.json'))
    } catch {
      // No folder: either not an install or no presets were ever saved there.
      return (names ?? []).map(name => ({ name, imported: false, why: 'absent' as const }))
    }

    const wanted = names === undefined
      ? available.map(entry => entry.slice(0, -'.json'.length))
      : [...names]
    const outcomes: ImportOutcome[] = []
    for (const name of wanted) {
      let stem: string
      try {
        stem = sanitizePresetName(name)
      } catch {
        outcomes.push({ name, imported: false, why: 'absent' })
        continue
      }
      const file = `${stem}.json`
      if (!available.includes(file)) {
        outcomes.push({ name, imported: false, why: 'absent' })
        continue
      }
      try {
        const preset = asPreset(JSON.parse(await readFile(join(source, file), 'utf8')) as unknown)
        if (preset === undefined) {
          outcomes.push({ name, imported: false, why: 'not-a-preset' })
          continue
        }
        await this.save(name, preset)
        outcomes.push({ name, imported: true })
      } catch {
        // Present but unreadable *this time* — the install may be writing it
        // right now. Reported, not thrown, so one bad file cannot stop the
        // other names from arriving.
        outcomes.push({ name, imported: false, why: 'unreadable' })
      }
    }
    return outcomes
  }

  /** Read and validate one file; anything else is simply not a preset. */
  async #tryReadFile(path: string): Promise<ChatCompletionPreset | undefined> {
    try {
      return asPreset(JSON.parse(await readFile(path, 'utf8')) as unknown)
    } catch {
      return undefined
    }
  }

  /**
   * Bring one hand-carried file into the library — upstream's import button.
   *
   * The name is the filename minus its last extension, the way upstream's
   * browser code derives it (`openai.js`: `file.name.replace(/\.[^/.]+$/, '')`)
   * and the endpoint then sanitizes; the derivation lives here so every caller
   * gets the same stem. A name already in the library is overwritten, which
   * upstream also does — behind one confirm dialog this side replaces with the
   * per-file `overwritten` report.
   *
   * Upstream saves **any** parseable JSON; nothing here converts or bends a
   * foreign format. The refusal at the door instead is deliberate: this
   * library's `list` skips files without a `prompts` array, so saving a
   * non-preset would mean storing something that then silently never appears —
   * the quiet kind of wrong.
   * @param filename - the file's name, extension included.
   * @param text - the file's text, parsed here rather than in the client so
   *   the rejection reasons are one code path's.
   * @returns the outcome, per file.
   */
  async importOne(filename: string, text: string): Promise<FileImportOutcome> {
    const stem = filename.replace(/\.[^/.]+$/, '')
    let name: string
    try {
      name = sanitizePresetName(stem)
    } catch {
      return { name: stem, imported: false, reason: 'unusable-name' }
    }
    let parsed: unknown
    try {
      // A leading BOM goes the way upstream's reader strips it: the browser's
      // `readAsText` drops it before `JSON.parse` ever sees the text, and a
      // Buffer decode does not — without this, a file Windows Notepad wrote
      // would be refused as invalid for one invisible character.
      parsed = JSON.parse(text.replace(/^\uFEFF/u, '')) as unknown
    } catch {
      return { name, imported: false, reason: 'invalid-json' }
    }
    const preset = asPreset(parsed)
    if (preset === undefined) {
      return { name, imported: false, reason: 'not-a-preset' }
    }
    const overwritten = await this.has(name)
    await this.save(name, preset)
    const body = preset as unknown as Record<string, unknown>
    const sensitive = SENSITIVE_FIELDS.filter(field => body[field])
    return { name, imported: true, overwritten, sensitive }
  }
}
