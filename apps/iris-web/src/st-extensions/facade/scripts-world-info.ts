/**
 * Facade for `scripts/world-info.js`, served at `<rev>/scripts/world-info.js`.
 *
 * The pilot boundary: `loadWorldInfo` serves the hydrated world book the host
 * supplies through the bridge, and an **empty** book when none was supplied —
 * never a throw, because upstream's chat-open preload calls it on every open
 * and the preload must complete. `getwi`-family template helpers therefore see
 * no entries in the pilot; the report records that as a deviation row, not a
 * silent feature. The scan knobs and position enums carry SillyTavern 1.18.0's
 * own values, since the extension compares and orders against them.
 */

import { state } from '../kernel-entry.ts'

export const world_info_logic = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const

export const world_info_position = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const

export const METADATA_KEY = 'world_info'
export const DEFAULT_DEPTH = 4
export const DEFAULT_WEIGHT = 100

export let world_info_case_sensitive = false
export let world_info_match_whole_words = false
export let world_info_use_group_scoring = false
export let world_info_max_recursion_steps = 0

export const world_names: string[] = []
export const selected_world_info: Array<{ world: string }> = []
export const world_info: { charLore: null, globalSelect: string[] } = { charLore: null, globalSelect: [] }

/** Upstream returns a book object whose `entries` is keyed by uid; empty when the host supplied none. */
export async function loadWorldInfo(name: string): Promise<{ entries: Record<string, unknown> }> {
  const book = state.worldbooks.get(name)
  if (book !== undefined) return book
  console.debug(`[iris-st-compat] loadWorldInfo("${name}") serves an empty book — the pilot hydrates no world-info entries`)
  return { entries: {} }
}

/** Upstream parses `/pattern/flags` literals; anything else is a plain keyword (null here means "not a regex"). */
export function parseRegexFromString(input: string): RegExp | null {
  const match = /^\/(.+)\/([gimsuy]*)$/su.exec(input)
  if (match === null) return null
  const source = match[1]
  const flags = match[2]
  if (source === undefined) return null
  try {
    return new RegExp(source, flags ?? '')
  } catch {
    return null
  }
}
