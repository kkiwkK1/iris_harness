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

import type { ConnectionProfile, GenerationSettings, HostDefaultConnection } from '@iris/protocol'

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
  /**
   * The ids a successful probe of {@link baseURL} last reported.
   *
   * The one non-user, non-derived field in this file, and the module's opening
   * rule survives it: nothing *derived* is stored, and this is not derived —
   * it is an observation, kept with the moment it was made so it cannot be
   * mistaken for the present. Dropped whenever {@link baseURL} changes, because
   * a list from the endpoint this profile used to point at is not a stale
   * version of the truth, it is a different endpoint's answer.
   */
  models?: string[]
  /** Unix epoch milliseconds of the probe {@link models} came from. */
  modelsProbedAt?: number
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
  /**
   * The model list a probe just reported, recorded on the profile.
   *
   * Merges like the key does — absent keeps what was recorded, because a caller
   * editing a label has no probe result to re-send. An empty array is a real
   * record ("probed, advertised nothing"), not a clear.
   */
  models?: string[]
}

/**
 * The connection the host process was started with, as this runtime is told it.
 *
 * Preferably **handed in** by the composition, which is the one place that
 * decides what the host generates through. When it is not — and on the shipped
 * composition today it is not, because the `app` row carries no endpoint —
 * {@link hostConnectionFromEnv} reads the same variables that composition
 * reads, which makes it a second *reader* of one answer rather than a second
 * answer. `HOST_CONNECTION_ENV` names that coupling and a test holds it.
 *
 * `apiKey` stays inside the process — it is what a bare probe and an adoption
 * use, and it is never projected onto {@link hostDefaultView}.
 */
export interface HostConnection {
  /** The adapter route the composition registered. */
  provider: string
  /** The endpoint, when the host was configured with one. */
  baseURL?: string
  /** The model the host was configured with. */
  model?: string
  /** The credential the process holds, if any. **Never leaves the process.** */
  apiKey?: string
  /** The header it is sent in. Absent means `Authorization: Bearer`. */
  apiKeyHeader?: string
  /** The environment variable the key came from, for a form to name it by. */
  keyEnv?: string
}

/**
 * The environment variables the shipped composition configures the host's own
 * endpoint from.
 *
 * Named as a constant because this list is a **coupling to another file**:
 * `apps/iris/cordis.yml` reads exactly these three for its
 * `llm-openai-compat` row, and this module reads them only as a fallback for a
 * host that did not hand its connection in. A rename there with no rename here
 * would leave the panel quietly reporting a host default that is not the one
 * generating — so `tests/host-connection.test.ts` parses that file and holds
 * the two together, and the drift goes red instead of silent.
 */
export const HOST_CONNECTION_ENV = {
  baseURL: 'IRIS_BASE_URL',
  model: 'IRIS_MODEL',
  /** Not the key — the *name of the variable* holding it, which is the indirection upstream of the key. */
  keyEnv: 'IRIS_API_KEY_ENV',
} as const

/**
 * Read the host's own connection out of the environment, as a fallback.
 *
 * **The composition is the authority**; this is what a host that never told
 * this runtime what it generates through can still be asked. It reads the same
 * variables that composition reads, which is what makes it a second *reader*
 * rather than a second *answer*.
 *
 * `baseURL` stays absent when `IRIS_BASE_URL` is unset, rather than repeating
 * the composition's `http://127.0.0.1:11434/v1` default here: an absent
 * endpoint already means "rides the host's configured route" everywhere else in
 * this protocol, and a copied default is a constant that drifts.
 * @param env - the environment to read (`process.env` in the product).
 * @param route - the provider and model the settings layer already knows,
 * which is where the composition's own `provider` / `model` row landed.
 * @returns what the environment says the host is; the route alone when it says nothing.
 */
export function hostConnectionFromEnv(
  env: Record<string, string | undefined>,
  route: { provider: string, model: string },
): HostConnection {
  const baseURL = env[HOST_CONNECTION_ENV.baseURL]
  const keyEnv = env[HOST_CONNECTION_ENV.keyEnv]
  const apiKey = keyEnv === undefined || keyEnv.length === 0 ? undefined : env[keyEnv]
  return {
    provider: route.provider,
    model: route.model,
    ...baseURL === undefined || baseURL.length === 0 ? {} : { baseURL },
    ...apiKey === undefined || apiKey.length === 0 ? {} : { apiKey },
    ...keyEnv === undefined || keyEnv.length === 0 ? {} : { keyEnv },
  }
}

/**
 * What a probe of the host's own endpoint reported, held in memory.
 *
 * `origin` is stored beside the list rather than assumed: the host connection
 * this runtime reads can change between two reads (a composition that hands one
 * in, an environment read that now answers differently), and a list attributed
 * to the wrong endpoint is worse than no list at all. {@link hostDefaultView}
 * drops the record rather than project it when the origins disagree.
 */
export interface HostProbeRecord {
  /** The origin the list was read from. */
  origin: string
  /** The ids the endpoint advertised, in its own order. */
  models: readonly string[]
  /** Unix epoch milliseconds of that read. */
  probedAt: number
}

/**
 * Project the host's own connection onto the wire — **without the credential**.
 *
 * The whole point of the row is that a user can see what is answering their
 * messages, and the whole point of this function is that seeing it does not
 * mean holding its key.
 * @param host - what the composition told this runtime.
 * @param probe - what a probe of that endpoint reported, when one has run in
 * this process. Projected only when it was read from the endpoint this host
 * currently points at, so a moved route cannot inherit the old one's list.
 * @returns the read-only row, carrying the key's *source* and never the key.
 */
export function hostDefaultView(
  host: HostConnection,
  probe?: HostProbeRecord | undefined,
): HostDefaultConnection {
  const hasKey = host.apiKey !== undefined && host.apiKey.length > 0
  const listed = probe !== undefined && sameEndpointOrigin(host.baseURL, probe.origin)
    ? probe
    : undefined
  return {
    provider: host.provider,
    ...host.baseURL === undefined || host.baseURL.length === 0 ? {} : { baseURL: host.baseURL },
    ...host.model === undefined || host.model.length === 0 ? {} : { model: host.model },
    keySource: hasKey ? 'env' : 'none',
    ...hasKey && host.keyEnv !== undefined && host.keyEnv.length > 0 ? { keyEnv: host.keyEnv } : {},
    // The list and its stamp travel together or not at all, as they do on a
    // profile: half of this pair is an undatable claim.
    ...listed === undefined ? {} : { models: [...listed.models], modelsProbedAt: listed.probedAt },
  }
}

/**
 * Whether two endpoints are the same place, for the purpose of reusing a key.
 *
 * Origin, not the full URL: `…/v1` and `…/v1/` and `…/v1beta/openai` are the
 * same host holding the same credential, and demanding a character-identical
 * base URL would refuse to reuse a key the user plainly meant. The path is
 * deliberately *not* compared — but the origin is, and that is the line that
 * matters: a stored key must never be sent to a **different** host because the
 * page asked for a bare probe of one.
 * @param left - one endpoint.
 * @param right - the other.
 * @returns true when both parse and share an origin.
 */
export function sameEndpointOrigin(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    // One of them is not a URL. Refusing is the safe direction: the question
    // this answers is "may this key go there", and "I could not tell" is no.
    return false
  }
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
    // The list travels as it was recorded, timestamp included. Sending one
    // without the other would hand a picker a list it cannot date, which is
    // the shape that turns an observation into a claim.
    ...profile.models === undefined ? {} : { models: [...profile.models] },
    ...profile.modelsProbedAt === undefined ? {} : { modelsProbedAt: profile.modelsProbedAt },
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

    // The recorded model list merges like the key, and for the same reason —
    // the caller editing a label has no probe result in hand. The one case that
    // is *not* a merge is a moved endpoint: a list recorded against the old
    // base URL describes a different server, so it goes rather than becoming a
    // set of model names this profile will never be able to reach.
    if (input.models !== undefined) {
      stored.models = [...input.models]
      stored.modelsProbedAt = Date.now()
    } else if (previous?.models !== undefined && sameEndpointOrigin(previous.baseURL, stored.baseURL)) {
      stored.models = previous.models
      if (previous.modelsProbedAt !== undefined) stored.modelsProbedAt = previous.modelsProbedAt
    }

    if (at === -1) this.#file.profiles.push(stored)
    else this.#file.profiles[at] = stored

    await this.#save()
    return this.list()
  }

  /**
   * Record what a probe of a profile's endpoint just reported.
   *
   * Its own method rather than a `save` call, because `save` replaces a whole
   * profile from a caller's values and a probe has none of them: routing this
   * through `save` would mean the probe path had to re-send the label, preset
   * and sampling it was never given, and getting that wrong would silently
   * blank a field.
   *
   * A profile that has since been deleted is not an error — the probe answered
   * a question about an endpoint, and the answer having nowhere to be filed is
   * not a failure of the probe.
   * @param id - the profile the probe was pointed at.
   * @param models - the ids it reported, possibly empty.
   */
  async recordModels(id: string, models: readonly string[]): Promise<void> {
    await this.#load()
    const found = this.#file.profiles.find(profile => profile.id === id)
    if (found === undefined) return
    found.models = [...models]
    found.modelsProbedAt = Date.now()
    await this.#save()
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
