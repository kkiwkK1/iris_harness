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

import type { ConnectionProfile, GenerationSettings } from '@iris/protocol'

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
}

/** How much of a key a mask may show — matching the host's store. */
const KEY_TAIL_MIN_LENGTH = 8

const STORED: StoredProfile[] = [
  {
    id: 'local-qwen',
    label: 'Fast local',
    provider: 'openai-compat',
    model: 'local/qwen3-8b',
    sampling: { temperature: 0.9, topP: 0.95 },
    baseURL: 'http://127.0.0.1:11434/v1',
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
  },
  {
    // Never named. The interface has to fall back to something, and the summary
    // is the only honest candidate.
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
  }
}

/**
 * Every profile, plus which one is active.
 * @returns the list.
 */
export function listConnections(): { profiles: ConnectionProfile[], activeId?: string } {
  return {
    profiles: STORED.map(project),
    ...(activeId === undefined ? {} : { activeId }),
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
}): { profiles: ConnectionProfile[], activeId?: string } {
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
  if (patch.apiKey === undefined) {
    if (previous?.apiKey !== undefined) stored.apiKey = previous.apiKey
  } else if (patch.apiKey.length > 0) {
    stored.apiKey = patch.apiKey
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
): { profiles: ConnectionProfile[], activeId?: string } | undefined {
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
