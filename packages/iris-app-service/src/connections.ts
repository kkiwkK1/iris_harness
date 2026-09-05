/**
 * Saved connections: an endpoint, a model and a preset switched as a set.
 *
 * Kept in their own file rather than a section of `settings.json`, because the
 * two answer different questions: settings are *what this chat is using now*,
 * these are *the sets the user has put together*. Resetting one should not
 * empty the other.
 *
 * The one design rule here comes from a measurement rather than taste. Upstream
 * stores a display name generated at creation time from the values as they then
 * were, and the profile the user currently has selected is called
 * `deepseek deepseek-chat - Default` while pointing at a Gemini model on a
 * different endpoint with a different preset. So nothing derived is stored: a
 * profile keeps only the user's own words, and everything shown is computed from
 * the live values. A name that disagrees with its contents is not something to
 * be careful about — it is unrepresentable.
 *
 * @module @iris/app-service/connections
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ConnectionProfile, GenerationSettings } from '@iris/protocol'

import { notFound } from './errors.ts'
import { sanitize } from './settings.ts'

/**
 * How much of a stored key a read may show.
 *
 * The tail is a convenience for the one question a user asks of a masked
 * field — "which of my keys is this?" — and a boundary: shorter than this,
 * showing four characters shows most of the key, so nothing is shown at all.
 */
export const KEY_TAIL_MIN_LENGTH = 8
/** How many trailing characters a masked key shows. */
export const KEY_TAIL_LENGTH = 4

/** A profile as it is stored: no derived values. */
interface StoredProfile {
  id: string
  label?: string
  provider: string
  model: string
  preset?: string
  sampling?: Partial<GenerationSettings>
  /** The endpoint this profile generates through. Absent rides the host's route. */
  baseURL?: string
  /** The key as the user typed it. Stored in the file; never projected to the wire. */
  apiKey?: string
  /** The header the key is sent in. Absent means the OpenAI-compatible default. */
  apiKeyHeader?: string
}

/** The file's shape. */
interface ConnectionsFile {
  profiles: StoredProfile[]
  activeId?: string
}

/** What a caller may set. */
export interface ProfileInput {
  id?: string
  label?: string
  provider: string
  model: string
  preset?: string
  sampling?: Record<string, unknown>
  baseURL?: string
  /**
   * Write-only, with merge semantics the other fields do not have.
   *
   * Absent keeps whatever is stored — a caller editing a label cannot re-send
   * a key it was never shown. Empty string clears. Non-empty replaces.
   */
  apiKey?: string
  apiKeyHeader?: string
}

/**
 * The last characters of a stored key, for the mask a form shows.
 * @param key - the stored key, or absent.
 * @returns the tail, or undefined when there is no key or it is too short to show one.
 */
export function keyTailOf(key: string | undefined): string | undefined {
  if (key === undefined || key.length < KEY_TAIL_MIN_LENGTH) return undefined
  return key.slice(-KEY_TAIL_LENGTH)
}

/**
 * Describe a profile from its current values.
 *
 * Computed on every read, never stored — this is the whole point. The moment
 * this became a field, it would start being true only of the values it was
 * written from.
 *
 * The endpoint rides in the summary as its origin, because for a profile that
 * carries one, **where it points is the truth the summary exists to tell** —
 * the measured failure this design answers is a profile whose name says one
 * provider and whose endpoint says another.
 * @param profile - the stored values.
 * @returns a one-line description of what the profile currently is.
 */
export function summarize(profile: StoredProfile): string {
  const parts = [profile.provider, profile.model]
  if (profile.preset !== undefined && profile.preset.length > 0) parts.push(profile.preset)
  if (profile.baseURL !== undefined && profile.baseURL.length > 0) {
    try {
      parts.push(new URL(profile.baseURL).origin)
    } catch {
      // Not a parseable URL — show it raw rather than hide where it points.
      parts.push(profile.baseURL)
    }
  }
  return parts.join(' · ')
}

/** Project a stored profile onto the wire shape. **Never carries the key.** */
function toWire(profile: StoredProfile): ConnectionProfile {
  const tail = keyTailOf(profile.apiKey)
  return {
    id: profile.id,
    ...profile.label === undefined ? {} : { label: profile.label },
    summary: summarize(profile),
    provider: profile.provider,
    model: profile.model,
    ...profile.preset === undefined ? {} : { preset: profile.preset },
    ...profile.sampling === undefined ? {} : { sampling: profile.sampling },
    ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
    ...profile.apiKey === undefined ? {} : { hasKey: true },
    ...tail === undefined ? {} : { keyTail: tail },
    ...profile.apiKeyHeader === undefined ? {} : { apiKeyHeader: profile.apiKeyHeader },
  }
}

/** Reads and persists the user's saved connections. */
export class ConnectionStore {
  readonly #path: string
  #file: ConnectionsFile = { profiles: [] }
  #loaded = false

  /**
   * @param path - the JSON file backing the store.
   */
  constructor(path: string) {
    this.#path = path
  }

  /** Load on first use; a missing or unreadable file is an empty list. */
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<ConnectionsFile>
      if (Array.isArray(parsed.profiles)) {
        this.#file = {
          profiles: parsed.profiles,
          ...typeof parsed.activeId === 'string' ? { activeId: parsed.activeId } : {},
        }
      }
    } catch {
      // Nothing saved yet, which is the state every install starts in.
    }
  }

  /** Persist the file, creating its directory on a first run. */
  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    await writeFile(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`, 'utf8')
  }

  /**
   * Every saved profile, with its summary derived fresh.
   * @returns the profiles and which one was last activated.
   */
  async list(): Promise<{ profiles: ConnectionProfile[], activeId?: string }> {
    await this.#load()
    return {
      profiles: this.#file.profiles.map(toWire),
      ...this.#file.activeId === undefined ? {} : { activeId: this.#file.activeId },
    }
  }

  /**
   * Create a profile, or replace one by id.
   * @param input - the values to store; anything derived is not among them.
   * @returns the profiles after the change.
   * @throws {AppError} `invalid-request` when the sampling block is malformed.
   */
  async save(input: ProfileInput): Promise<{ profiles: ConnectionProfile[], activeId?: string }> {
    await this.#load()

    // Sampling goes through the same validation a settings patch does, so a
    // profile cannot store a temperature that `settings.set` would refuse.
    const sampling = input.sampling === undefined ? undefined : sanitize(input.sampling).set

    const stored: StoredProfile = {
      id: input.id ?? randomUUID(),
      ...input.label === undefined || input.label.length === 0 ? {} : { label: input.label },
      provider: input.provider,
      model: input.model,
      ...input.preset === undefined || input.preset.length === 0 ? {} : { preset: input.preset },
      ...sampling === undefined || Object.keys(sampling).length === 0 ? {} : { sampling },
      ...input.baseURL === undefined || input.baseURL.length === 0 ? {} : { baseURL: input.baseURL },
      ...input.apiKeyHeader === undefined || input.apiKeyHeader.length === 0
        ? {}
        : { apiKeyHeader: input.apiKeyHeader },
    }

    // The key is the one field that merges. Every read withholds it, so a
    // caller replacing a profile cannot send it back — treating absent as
    // "clear it" would silently disarm a profile whose label someone edited.
    // `''` is the explicit clear; anything else replaces.
    const at = this.#file.profiles.findIndex(profile => profile.id === stored.id)
    const previous = at === -1 ? undefined : this.#file.profiles[at]
    if (input.apiKey === undefined) {
      if (previous?.apiKey !== undefined) stored.apiKey = previous.apiKey
    } else if (input.apiKey.length > 0) {
      stored.apiKey = input.apiKey
    }

    if (at === -1) this.#file.profiles.push(stored)
    else this.#file.profiles[at] = stored

    await this.#save()
    return this.list()
  }

  /**
   * Remove a profile.
   * @param id - which one.
   * @returns the profiles after the change.
   * @throws {AppError} `not-found` when no profile has that id.
   */
  async delete(id: string): Promise<{ profiles: ConnectionProfile[], activeId?: string }> {
    await this.#load()
    const at = this.#file.profiles.findIndex(profile => profile.id === id)
    if (at === -1) throw notFound(`no connection profile "${id}"`)

    this.#file.profiles.splice(at, 1)
    // The active id is cleared with it: pointing at a profile that is gone would
    // make the next read report an active connection nobody can inspect.
    if (this.#file.activeId === id) delete this.#file.activeId
    await this.#save()
    return this.list()
  }

  /**
   * The stored values of one profile, for activation.
   * @param id - which one.
   * @returns the stored profile.
   * @throws {AppError} `not-found` when no profile has that id.
   */
  async get(id: string): Promise<StoredProfile> {
    await this.#load()
    const found = this.#file.profiles.find(profile => profile.id === id)
    if (found === undefined) throw notFound(`no connection profile "${id}"`)
    return found
  }

  /**
   * Record which profile was last applied.
   * @param id - the profile.
   */
  async markActive(id: string): Promise<void> {
    await this.#load()
    this.#file.activeId = id
    await this.#save()
  }

  /**
   * The settings patch that applying a profile amounts to.
   * @param profile - the stored profile.
   * @param route - the provider route the patch should name, when it differs
   * from the profile's own (a profile with an endpoint of its own is served
   * by a runtime-installed adapter, not the route its `provider` was named for).
   * @returns a patch for `SettingsStore.set`.
   */
  static patchOf(profile: StoredProfile, route?: string): Record<string, unknown> {
    const patch = { provider: profile.provider, model: profile.model, ...profile.sampling }
    // The runtime-installed route wins over anything a sampling block carried:
    // the adapter registered for it is the one that can actually reach this
    // profile's endpoint.
    return route === undefined ? patch : { ...patch, provider: route }
  }
}

/**
 * The adapter route a profile is served through once activated.
 *
 * A profile carrying its own endpoint cannot generate through `default`: that
 * route belongs to the composition's own adapter registration, which this
 * runtime neither owns nor may displace. Everything else generates through
 * the route its provider names — presets install there on activation, and two
 * profiles of one provider take turns by replacing that registration.
 * @param profile - the stored profile (the id matters only for the derived route).
 * @returns the route key to install an adapter under and to write into settings.
 */
export function routeOf(
  profile: Pick<StoredProfile, 'id' | 'provider' | 'model'> & { baseURL?: string | undefined },
): string {
  if (profile.baseURL === undefined || profile.baseURL.length === 0) return profile.provider
  return profile.provider === 'default' ? `conn/${profile.id}` : profile.provider
}
