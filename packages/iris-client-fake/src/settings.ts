/**
 * Folding an untrusted settings patch onto generation settings.
 *
 * `settings.set` carries an open record, because the schema cannot enumerate a
 * sampling surface that is still growing. That makes this the place where the
 * open shape narrows back to the protocol's, and the narrowing is deliberately
 * lossy: a key the protocol does not name is dropped rather than stored, so a
 * typo in the settings panel cannot masquerade as a supported parameter.
 *
 * @module @iris/client-fake/settings
 */

import type { GenerationSettings } from '@iris/protocol'

/** Numeric sampling fields, listed once so the switch below cannot drift from the type. */
const NUMERIC = [
  'temperature',
  'maxTokens',
  'topP',
  'topK',
  'minP',
  'repetitionPenalty',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
] as const

/** One numeric field name. */
type NumericField = (typeof NUMERIC)[number]

/** Whether a key names a numeric sampling field. */
function isNumericField(key: string): key is NumericField {
  return (NUMERIC as readonly string[]).includes(key)
}

/**
 * The effort words, which are the host's own set (`@iris/app-service`'s
 * `REASONING_EFFORTS`) rather than a fresh list.
 *
 * Added 2026-09-10 with the composer's bar (web §80), which offers this ladder
 * beside the model: before it, a patch naming `reasoningEffort` was dropped
 * here — the key is not numeric, not `stop`, and not the route — so the seeded
 * page answered a chosen effort by forgetting it, and every surface that offers
 * one looked broken against the fake while being correct against a host. The
 * value is checked against the set for the reason the module doc gives: this is
 * where an open record narrows back to the protocol's shape, so a typo must not
 * become a stored field.
 *
 * **Its neighbours are still dropped**, and deliberately not fixed here:
 * `contextWindow`, `contextUnlocked`, `continuePostfix`, `trimSentences`,
 * `squashSystemMessages` and `cacheFriendly` are all settings the drawer can
 * write and this fake still forgets. Each needs its own kind of check, none is
 * on this task's path, and a blanket pass-through would defeat the narrowing.
 */
const EFFORTS = ['auto', 'low', 'medium', 'high', 'min', 'max'] as const

/** One effort word. */
type Effort = (typeof EFFORTS)[number]

/** Whether a value is one of the six effort words. */
function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

/**
 * Apply a patch to the settings in force.
 *
 * `null` clears an optional field, which the panel needs: "no explicit top-k"
 * and "top-k of zero" are different requests, and an omitted key cannot say
 * either because omission is how a partial patch works.
 * @param current - the settings in force.
 * @param patch - the untrusted patch.
 * @returns the new settings.
 */
export function mergeSettings(
  current: GenerationSettings,
  patch: Record<string, unknown>,
): GenerationSettings {
  const next: GenerationSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'provider' || key === 'model') {
      if (typeof value === 'string' && value.trim() !== '') next[key] = value
      continue
    }
    if (isNumericField(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) next[key] = value
      else if (value === null) delete next[key]
      continue
    }
    if (key === 'stop') {
      if (Array.isArray(value)) next.stop = value.filter((row): row is string => typeof row === 'string')
      else if (value === null) delete next.stop
      continue
    }
    if (key === 'reasoningEffort') {
      if (isEffort(value)) next.reasoningEffort = value
      else if (value === null) delete next.reasoningEffort
    }
  }
  return next
}

/**
 * Apply a patch to a chat's **override layer**, where `null` really does delete.
 *
 * Kept apart from {@link mergeSettings} because the two layers differ on
 * exactly one question, and it is the interesting one: at the global layer
 * `provider` and `model` cannot be cleared — the wire shape requires them, so
 * there is nothing below to show through — while at the chat layer clearing
 * them is the entire point of a "back to the connection's default" control. A
 * single function serving both would have to be told which layer it is on,
 * which is two functions wearing one name.
 *
 * Unknown keys are dropped here as they are there: the fake narrows an open
 * record back to the protocol's shape, and a typo must not become a stored
 * field that nothing will ever read.
 * @param current - the layer as it stands.
 * @param patch - the untrusted patch; `null` removes a field from the layer.
 * @returns the new layer.
 */
export function mergeOverrides(
  current: Partial<GenerationSettings>,
  patch: Record<string, unknown>,
): Partial<GenerationSettings> {
  const next: Partial<GenerationSettings> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'provider' || key === 'model') {
      if (value === null) delete next[key]
      else if (typeof value === 'string' && value.trim() !== '') next[key] = value
      continue
    }
    if (isNumericField(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) next[key] = value
      else if (value === null) delete next[key]
      continue
    }
    if (key === 'stop') {
      if (Array.isArray(value)) next.stop = value.filter((row): row is string => typeof row === 'string')
      else if (value === null) delete next.stop
      continue
    }
    if (key === 'reasoningEffort') {
      if (isEffort(value)) next.reasoningEffort = value
      else if (value === null) delete next.reasoningEffort
    }
  }
  return next
}
