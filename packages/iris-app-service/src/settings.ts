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

import type { GenerationSettings } from '@iris/protocol'

import { invalid } from './errors.ts'

/** Numeric sampling fields, with the range each is accepted in. */
const NUMERIC_FIELDS = {
  temperature: [0, 5],
  maxTokens: [1, 1_000_000],
  topP: [0, 1],
  topK: [0, 10_000],
  minP: [0, 1],
  repetitionPenalty: [0, 4],
  frequencyPenalty: [-2, 2],
  presencePenalty: [-2, 2],
  seed: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
} as const satisfies Partial<Record<keyof GenerationSettings, readonly [number, number]>>

/** What one settings file holds. */
interface SettingsFile {
  global: GenerationSettings
  /** Per-chat overrides, keyed by chat id. */
  chats: Record<string, Partial<GenerationSettings>>
}

/** Reads, merges and persists generation settings. */
export class SettingsStore {
  readonly #path: string
  #file: SettingsFile

  /**
   * @param path - the JSON file backing the store.
   * @param defaults - the route to use before anything has been configured.
   */
  constructor(path: string, defaults: GenerationSettings) {
    this.#path = path
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
      this.#file = {
        global: { ...this.#file.global, ...parsed.global },
        chats: parsed.chats ?? {},
      }
    } catch {
      // Keep the defaults.
    }
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
   * @param chatId - the chat to scope the patch to, or absent for the global layer.
   * @param patch - the fields to change; unknown keys are ignored.
   * @returns the merged settings after the change.
   * @throws {AppError} `invalid-request` when a known field has the wrong type
   *   or falls outside its range.
   */
  async set(chatId: string | undefined, patch: Record<string, unknown>): Promise<GenerationSettings> {
    const clean = sanitize(patch)
    if (chatId === undefined) {
      this.#file.global = { ...this.#file.global, ...clean }
    } else {
      this.#file.chats[chatId] = { ...this.#file.chats[chatId], ...clean }
    }
    await this.save()
    return this.get(chatId)
  }

  /**
   * Drop a chat's overrides, when its conversation is deleted.
   * @param chatId - the chat.
   */
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
 * Keep the fields the contract defines and refuse ones that are malformed.
 *
 * Silently dropping a bad value would be worse than refusing it: the user would
 * see their temperature change reported as saved and then not applied.
 * @param patch - the raw patch from the wire.
 * @returns the fields worth storing.
 * @throws {AppError} `invalid-request` for a known field of the wrong shape.
 */
export function sanitize(patch: Record<string, unknown>): Partial<GenerationSettings> {
  const clean: Partial<GenerationSettings> = {}

  for (const key of ['provider', 'model'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length === 0) throw invalid(`"${key}" must be a non-empty string`)
    clean[key] = value
  }

  for (const [key, [min, max]] of Object.entries(NUMERIC_FIELDS)) {
    const value = patch[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw invalid(`"${key}" must be a number between ${String(min)} and ${String(max)}`)
    }
    Object.assign(clean, { [key]: key === 'maxTokens' || key === 'topK' || key === 'seed' ? Math.round(value) : value })
  }

  const stop = patch['stop']
  if (stop !== undefined) {
    if (!Array.isArray(stop) || stop.some(entry => typeof entry !== 'string')) {
      throw invalid('"stop" must be an array of strings')
    }
    clean.stop = stop as string[]
  }

  return clean
}
