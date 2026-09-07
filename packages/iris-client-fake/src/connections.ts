/**
 * Connection profiles, modelled rather than refused.
 *
 * Honest to model for the same reason the prompt breakdown was: a profile is a
 * named bundle of route and sampling, and a few invented bundles teach the
 * interface nothing false. (The script context was the opposite — a fabricated
 * one lets a runner pass here and fail on the first real card.)
 *
 * The fixture exists to make one property impossible to get wrong. Measured on a
 * real SillyTavern install, the user's selected profile was called
 * `deepseek deepseek-chat` and actually pointed at Gemini: upstream stores the
 * display name as a snapshot taken when the profile was created, so the name and
 * the contents drift apart silently. The contract's answer is that `summary` is
 * **derived on every read and never stored**, and one profile here reproduces the
 * upstream trap — a user label that flatly contradicts the route. An interface
 * that renders only the label will show a lie in development, where it is cheap.
 *
 * @module @iris/client-fake/connections
 */

import type { ConnectionProfile, GenerationSettings, HostDefaultConnection } from '@iris/protocol'

/** What the fake stores. Deliberately without `summary`, which is never stored. */
interface StoredProfile {
  id: string
  label?: string
  provider: string
  model: string
  preset?: string
  sampling?: Partial<GenerationSettings>
  baseURL?: string
  /** A made-up key, for the mask the interface shows. Never projected to the wire. */
  apiKey?: string
  apiKeyHeader?: string
  /**
   * The model ids a probe of this endpoint reported, as the host records them.
   *
   * **Seeded rather than probed, and that distinction is the whole licence for
   * it being here.** The fake still refuses `connection.test`: putting a
   * request on a real network is the one thing that method exists to do, and a
   * fabricated latency would teach a form a verdict no endpoint ever gave. A
   * recorded list is not a verdict — it is fixture data *about a profile*,
   * exactly like `model` and `baseURL` beside it, and it is what lets the model
   * picker be developed without anybody inventing a probe.
   */
  models?: string[]
  modelsProbedAt?: number
}

/** How much of a key a mask may show — matching the host's store. */
const KEY_TAIL_MIN_LENGTH = 8

/**
 * The stamp on the seeded model lists.
 *
 * A literal rather than `Date.now()`: the seed is a fixture, and a fixture that
 * moves on every boot cannot be asserted against. 2026-03-01T00:00:00Z.
 */
const SEEDED_PROBE_AT = 1_772_323_200_000

/**
 * The connection the fake "host" was started with.
 *
 * Modelled because the interface has a **branch** for it — a host configured
 * from its environment shows a read-only row where the panel used to say "no
 * active connection" — and a branch nothing renders in development is a branch
 * whose first execution is in front of a user. It carries a key *source* and
 * the *name* of the variable, never a key, which is the shape the real host
 * projects.
 */
const HOST_DEFAULT: HostDefaultConnection = {
  provider: 'default',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  keySource: 'env',
  keyEnv: 'DEEPSEEK_API_KEY',
  /**
   * A list against the host's own endpoint, seeded on the same licence as the
   * profiles' lists: fixture data *about a connection* rather than a verdict
   * about a network, so it teaches the model menu nothing a real host would
   * contradict while `connection.test` stays refused here.
   *
   * It carries more weight than it looks. This is the row the composer's model
   * menu falls back to when no profile is active — which, on a host configured
   * from its environment, is **the normal state**, and the state the bug was
   * reported from. With no list seeded here, that path could only ever be
   * developed against its own empty case.
   */
  models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-chat-0711'],
  modelsProbedAt: SEEDED_PROBE_AT,
}

/**
 * The key the fake's "host environment" holds, for an adoption to copy.
 *
 * No read returns it — {@link hostDefault} projects the source instead — so the
 * fake reproduces the property that matters: adopting the host's credential is
 * something the host does, never something the browser relays.
 */
const HOST_ENV_KEY = 'sk-fake-host-env-1a2b3c4d'

const STORED: StoredProfile[] = [
  {
    id: 'local-qwen',
    label: 'Fast local',
    provider: 'openai-compat',
    model: 'local/qwen3-8b',
    sampling: { temperature: 0.9, topP: 0.95 },
    baseURL: 'http://127.0.0.1:11434/v1',
    // A local serve advertising several tags, one of which is the profile's
    // own model — so the picker has both a match to tick and alternatives to
    // offer. This is the profile the seed activates, so it is the list the
    // composer's model menu reads.
    models: ['local/qwen3-8b', 'local/qwen3-14b', 'local/gemma3-12b', 'local/llama3.1-8b'],
    modelsProbedAt: SEEDED_PROBE_AT,
  },
  {
    // The upstream trap, reproduced: the label says one thing and the route says
    // another. Whoever renders only the label ships the bug this field exists to
    // prevent, and will see it here first.
    id: 'misnamed',
    label: 'deepseek deepseek-chat',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    preset: 'MengJing-V1',
    sampling: { temperature: 1.1 },
    // A key the mask can render, and a tail long enough to be shown.
    apiKey: 'sk-fake-key-9f2e77ab',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // A list that does **not** contain this profile's own model, which is the
    // case the picker has to render without losing the current value: it keeps
    // it as a "(custom) current value" row rather than silently re-pointing
    // the profile at whatever the list happens to offer first.
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    modelsProbedAt: SEEDED_PROBE_AT,
  },
  {
    // Never named. The interface has to fall back to something, and the summary
    // is the only honest candidate. No recorded list either — a profile that has
    // never been probed is the state every profile starts in, and the picker has
    // to fall back to a text field and say why.
    id: 'unnamed',
    provider: 'openai-compat',
    model: 'deepseek-v4-flash',
  },
]

let activeId: string | undefined = 'local-qwen'
let nextId = 1

/**
 * Describe a profile from its current values.
 *
 * Computed on every read, never stored — which is the whole point. A stored
 * display string is a snapshot, and a snapshot of a mutable thing becomes a
 * confident falsehood the moment the thing changes.
 * @param profile - the stored values.
 * @returns a one-line description of where this profile actually goes.
 */
export function summarize(profile: { provider: string, model: string, preset?: string, baseURL?: string }): string {
  const parts = [profile.provider, profile.model]
  if (profile.preset !== undefined && profile.preset !== '') parts.push(profile.preset)
  if (profile.baseURL !== undefined && profile.baseURL !== '') {
    try {
      parts.push(new URL(profile.baseURL).origin)
    } catch {
      parts.push(profile.baseURL)
    }
  }
  return parts.join(' · ')
}

/** Project a stored profile to the wire shape. **Never carries the key.** */
function project(profile: StoredProfile): ConnectionProfile {
  const tail = profile.apiKey !== undefined && profile.apiKey.length >= KEY_TAIL_MIN_LENGTH
    ? profile.apiKey.slice(-4)
    : undefined
  return {
    id: profile.id,
    ...(profile.label === undefined ? {} : { label: profile.label }),
    summary: summarize(profile),
    provider: profile.provider,
    model: profile.model,
    ...(profile.preset === undefined ? {} : { preset: profile.preset }),
    ...(profile.sampling === undefined ? {} : { sampling: { ...profile.sampling } }),
    ...(profile.baseURL === undefined ? {} : { baseURL: profile.baseURL }),
    ...(profile.apiKey === undefined ? {} : { hasKey: true }),
    ...(tail === undefined ? {} : { keyTail: tail }),
    ...(profile.apiKeyHeader === undefined ? {} : { apiKeyHeader: profile.apiKeyHeader }),
    ...(profile.models === undefined ? {} : { models: [...profile.models] }),
    ...(profile.modelsProbedAt === undefined ? {} : { modelsProbedAt: profile.modelsProbedAt }),
  }
}

/**
 * The connection the fake host was started with.
 * @param options.models - whether the row carries a recorded model list.
 * `false` is the **never-probed** host: a real host holds this list in memory
 * only, so every launch starts without one, and the model menu's "fetch it
 * now" path is reachable in development only if something can serve that shape.
 * `createFakeClient({ empty: true })` is where it comes from.
 * @returns the read-only row, carrying the key's source and never the key.
 */
export function hostDefault(options: { models?: boolean } = {}): HostDefaultConnection {
  if (options.models === false) {
    const { models: _dropped, modelsProbedAt: _stamp, ...rest } = HOST_DEFAULT
    return rest
  }
  return { ...HOST_DEFAULT }
}

/**
 * Every profile, plus which one is active.
 * @returns the list.
 */
export function listConnections(): {
  profiles: ConnectionProfile[]
  activeId?: string
  host: HostDefaultConnection
} {
  return {
    profiles: STORED.map(project),
    ...(activeId === undefined ? {} : { activeId }),
    host: hostDefault(),
  }
}

/**
 * Create or replace a profile.
 * @param patch - the values; an `id` replaces that profile, its absence creates one.
 * @returns the new list.
 */
export function saveConnection(patch: {
  // `| undefined` on each optional, not just `?`. Under
  // `exactOptionalPropertyTypes` a zod-inferred optional is `string | undefined`
  // and a bare `?` will not accept it — and widening here is the right direction,
  // because the caller is a validated wire payload where an absent field really
  // does arrive as `undefined`.
  id?: string | undefined
  label?: string | undefined
  provider: string
  model: string
  preset?: string | undefined
  sampling?: Record<string, unknown> | undefined
  baseURL?: string | undefined
  apiKey?: string | undefined
  apiKeyHeader?: string | undefined
  adoptHostKey?: boolean | undefined
  models?: string[] | undefined
}): { profiles: ConnectionProfile[], activeId?: string, host: HostDefaultConnection } {
  const stored: StoredProfile = {
    id: patch.id ?? `profile-${nextId++}`,
    ...(patch.label === undefined ? {} : { label: patch.label }),
    provider: patch.provider,
    model: patch.model,
    ...(patch.preset === undefined ? {} : { preset: patch.preset }),
    ...(patch.sampling === undefined ? {} : { sampling: patch.sampling as Partial<GenerationSettings> }),
    ...(patch.baseURL === undefined || patch.baseURL === '' ? {} : { baseURL: patch.baseURL }),
    ...(patch.apiKeyHeader === undefined || patch.apiKeyHeader === '' ? {} : { apiKeyHeader: patch.apiKeyHeader }),
  }

  // The key merges, exactly as the host's store merges it: absent keeps what
  // is stored (the caller was never shown it, so it cannot re-send it), `''`
  // clears, anything else replaces.
  const at = STORED.findIndex(row => row.id === stored.id)
  const previous = at === -1 ? undefined : STORED[at]
  if (patch.apiKey === undefined || patch.apiKey.length === 0) {
    // Adopting the host's credential happens here, where the fake's "host
    // environment" holds it — the browser asked for it by name. A typed key
    // outranks the flag, as it does on the real host: it is the newer decision.
    if (patch.adoptHostKey === true && patch.apiKey === undefined) stored.apiKey = HOST_ENV_KEY
    else if (patch.apiKey === undefined && previous?.apiKey !== undefined) stored.apiKey = previous.apiKey
  } else {
    stored.apiKey = patch.apiKey
  }

  // The recorded list merges like the key, and is dropped when the endpoint
  // moves — a list from the address this profile used to point at is another
  // server's answer, not a stale version of this one's.
  if (patch.models !== undefined) {
    stored.models = [...patch.models]
    stored.modelsProbedAt = SEEDED_PROBE_AT
  } else if (previous?.models !== undefined && previous.baseURL === stored.baseURL) {
    stored.models = previous.models
    if (previous.modelsProbedAt !== undefined) stored.modelsProbedAt = previous.modelsProbedAt
  }

  if (at === -1) STORED.push(stored)
  else STORED[at] = stored

  return listConnections()
}

/**
 * Remove a profile.
 * @param id - which one.
 * @returns the new list, or undefined when there was no such profile.
 */
export function deleteConnection(
  id: string,
): { profiles: ConnectionProfile[], activeId?: string, host: HostDefaultConnection } | undefined {
  const at = STORED.findIndex(row => row.id === id)
  if (at === -1) return undefined
  STORED.splice(at, 1)
  // A deleted profile cannot stay active. Left set, the interface would show a
  // selection pointing at nothing.
  if (activeId === id) activeId = undefined
  return listConnections()
}

/**
 * Activate a profile.
 * @param id - which one.
 * @returns the settings it produces, or undefined when there was no such profile.
 */
export function activateConnection(
  id: string,
): { settings: GenerationSettings, activeId: string } | undefined {
  const profile = STORED.find(row => row.id === id)
  if (profile === undefined) return undefined
  activeId = id
  return {
    settings: { provider: profile.provider, model: profile.model, ...profile.sampling },
    activeId: id,
  }
}
