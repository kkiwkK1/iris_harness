/**
 * Reading scripts out of a character card.
 *
 * Three shapes are in the wild and they all mean the same thing. Measured
 * across the 19 cards of the local corpus:
 *
 * ```
 * extensions.tavern_helper = { scripts: [...], variables: {...} }         8 cards
 * extensions.tavern_helper = [["scripts", [...]], ["variables", {...}]]   7 cards
 * extensions.TavernHelper_scripts = [{ type, value }]                    3 cards
 * ```
 *
 * The second is `Object.entries()` of the first — a `Map` that went through
 * `JSON.stringify` somewhere upstream. Handling only the object form loses
 * seven of fifteen cards without any error, which is exactly how an earlier
 * count of this corpus came out low.
 *
 * Nothing here throws on bad input. A card with one unreadable script has to
 * keep the rest, so failures are collected in `skipped` and the caller decides
 * how loud to be.
 *
 * @module @iris/script/extract
 */

import type { CardScript, CardScriptBundle } from './types.ts'

/** The extension keys scripts have been found under. */
const KEYS = ['tavern_helper', 'TavernHelper_scripts'] as const

/** A record that may hold anything. */
type Unknown = Record<string, unknown>

/** Whether a value is a plain object we can read keys off. */
function isRecord(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Undo an `Object.entries()` serialization.
 *
 * Recognized by shape rather than by a flag, because the card carries no flag:
 * an array whose every element is a two-element array with a string first is an
 * entries list and nothing else in this format looks like one.
 * @param value - the candidate.
 * @returns the object it encodes, or undefined when it is not entries.
 */
function fromEntries(value: unknown): Unknown | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const pairs: [string, unknown][] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return undefined
    pairs.push([entry[0], entry[1]])
  }
  return Object.fromEntries(pairs)
}

/**
 * Normalize one script object.
 * @param value - the stored script.
 * @param index - its position, for naming an unnamed script.
 * @returns the script, or the reason it could not be read.
 */
function toScript(raw: unknown, index: number): CardScript | { reason: string, detail?: string } {
  if (!isRecord(raw)) return { reason: 'a script was not an object', detail: typeof raw }

  // `TavernHelper_scripts` wraps each script one level down, as
  // `{ type, value: { id, name, content, … } }`. Recognized by `value` holding
  // an object rather than by the key it arrived under, because the wrapper is
  // what varies and the script inside it does not.
  //
  // The fixture first written for this shape had `value` as the content string,
  // invented from a summary of the key names rather than read off a card, so the
  // test passed against its author's own guess. What the corpus showed was 13
  // entries reported as unreadable; they turned out to be the same scripts the
  // other key also carries, so nothing was actually lost there — every card
  // using this shape uses both keys. It is still load-bearing: a card exported
  // with only this key would lose all of its scripts, silently.
  const value = isRecord(raw['value']) ? raw['value'] : raw

  // `content` is the one field with no sensible default: a script without a
  // body is not a script, and inventing an empty one would put a dead entry in
  // the user's list with no way to tell it from a real one that does nothing.
  const content = value['content'] ?? value['value']
  if (typeof content !== 'string' || content.length === 0) {
    return { reason: 'a script had no content', detail: String(value['name'] ?? `#${String(index)}`) }
  }

  const id = typeof value['id'] === 'string' && value['id'].length > 0
    ? value['id']
    // Positional, and marked as synthesized. Grants are stored against this id,
    // so one invented here must be stable for the same card and must not be
    // mistakable for an author's own.
    : `iris-unnamed-${String(index)}`

  return {
    id,
    name: typeof value['name'] === 'string' && value['name'].length > 0 ? value['name'] : id,
    // On the wrapper in the nested shape, on the script itself otherwise.
    type: typeof value['type'] === 'string'
      ? value['type']
      : typeof raw['type'] === 'string' ? raw['type'] : 'script',
    // Absent means on: the field was added to the format after cards existed,
    // and a card written before it expects its scripts to run.
    enabled: value['enabled'] === undefined ? true : value['enabled'] !== false,
    content,
    ...typeof value['info'] === 'string' ? { info: value['info'] } : {},
    ...value['button'] === undefined ? {} : { button: value['button'] },
    ...value['data'] === undefined ? {} : { data: value['data'] },
    ...value['export_with'] === undefined ? {} : { exportWith: value['export_with'] },
  }
}

/**
 * Read every script a card carries.
 *
 * @param card - a decoded character card, or anything shaped like one.
 * @returns the scripts, the variables shipped beside them, and what was skipped.
 */
export function extractScripts(card: unknown): CardScriptBundle {
  const bundle: CardScriptBundle = { scripts: [], variables: {}, skipped: [] }
  if (!isRecord(card)) return bundle

  // V2/V3 nest under `data`; a bare card object is also accepted because a
  // caller holding `card.data` should not have to rewrap it.
  const data = isRecord(card['data']) ? card['data'] : card
  const extensions = isRecord(data['extensions']) ? data['extensions'] : undefined
  if (extensions === undefined) return bundle

  const seen = new Set<string>()
  for (const key of KEYS) {
    const raw = extensions[key]
    if (raw === undefined) continue

    // A bare array under either key is the script list itself, except when it
    // is an entries serialization of the wrapper object.
    const holder = isRecord(raw) ? raw : fromEntries(raw) ?? { scripts: raw }
    const list = holder['scripts']

    if (isRecord(holder['variables'])) {
      // Merged rather than replaced: both keys can be present, and the later
      // one is not authoritative over the earlier.
      bundle.variables = { ...bundle.variables, ...holder['variables'] }
    }

    if (!Array.isArray(list)) {
      if (list !== undefined) bundle.skipped.push({ reason: `${key}.scripts was not a list`, detail: typeof list })
      continue
    }

    for (const [index, entry] of list.entries()) {
      const result = toScript(entry, index)
      if (!('content' in result)) {
        bundle.skipped.push(result)
        continue
      }
      // The same script can appear under both keys on a card that was exported
      // by two different versions of the extension. First wins.
      if (seen.has(result.id)) continue
      seen.add(result.id)
      bundle.scripts.push(result)
    }
  }

  return bundle
}

/**
 * The scripts that should actually run.
 *
 * Separate from extraction so that a script list UI can show a disabled script
 * as disabled instead of not showing it at all — the user needs to see what the
 * card contains, and the runner needs to see what the card's author allowed.
 * @param bundle - an extracted bundle.
 * @returns the enabled scripts, in card order.
 */
export function runnableScripts(bundle: CardScriptBundle): CardScript[] {
  return bundle.scripts.filter(script => script.enabled)
}
