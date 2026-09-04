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

import type { ChatCompletionPreset } from '@iris/preset'

import { invalid, notFound } from './errors.ts'
import { fileFor, isSafeId } from './paths.ts'

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
}
