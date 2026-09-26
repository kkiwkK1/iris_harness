/**
 * The difference between two floors' variable tables, derived in one place.
 *
 * **In the contract because both halves derive it**, the argument `digests.ts`
 * is here for: the host answers `chat.variablesDiff` from real chat files and
 * the fake client from its seeded floors, and a page reading either must not
 * be able to tell them apart by how a change was classified. Two copies of
 * this walk would drift in exactly the places that matter — whether a key
 * reordered is a change, where an MVU pair is compared, what an index means.
 *
 * What it decides, and how:
 *
 * - **Objects** compare key by key, own keys only, order-blind. A key present
 *   on one side is one `added` or `removed` entry carrying the whole subtree —
 *   a card creating a 34-item section is one fact, not 34 rows (the rule the
 *   state margin's own round diff keeps).
 * - **Arrays** compare **by position**, and every entry at or under an index
 *   carries the `index` note: an element inserted at the front reads as every
 *   later position changing, and the note is what lets a reader know the diff
 *   paired positions rather than identities.
 * - **MVU `[value, description]` pairs** compare by their value half when the
 *   description is the same on both sides, and the entry names the pair's own
 *   path with the `mvu` note — `hp: 40 → 50`, not `hp/0: 40 → 50`. A pair whose
 *   description changed falls back to the positional rule. Recognised by shape
 *   only (two elements, the second a string, the first not an array); no card
 *   and no key is named.
 * - **A change of kind** (object to array, number to string, a value to null)
 *   is one `changed` entry for the whole path with the `type` note, never a
 *   walk into mismatched children.
 * - **Keys are data.** Whether a side has a key is asked with
 *   `hasOwnProperty`, never `in`, so a key named `constructor` or
 *   `hasOwnProperty` on one side is not "found" on the other's prototype; a
 *   literal `__proto__` key (JSON.parse makes it an own property) is compared
 *   like any other. Nothing here assigns into an object keyed by table data —
 *   the answer is arrays of paths — so no key can reach a prototype.
 *
 * A side that is `undefined` — no snapshot on that floor — is compared as an
 * empty table, so every top-level key of the other side is one entry. The
 * caller says *that* it was missing; this module only says what differs.
 *
 * @module @iris/protocol/variables-diff
 */

/** A path into a variable table: object keys as strings, array positions as numbers (zero-based). */
export type VariablePath = (string | number)[]

/** What happened at a path, reading A as before and B as after. */
export type VariableDiffKind = 'added' | 'removed' | 'changed'

/**
 * How an entry was arrived at.
 *
 * - `index`: the path runs through an array position, compared by position.
 * - `type`: the two sides hold different kinds of value.
 * - `mvu`: compared as the value half of an MVU `[value, description]` pair;
 *   `before` / `after` are the value halves.
 */
export type VariableDiffNote = 'index' | 'type' | 'mvu'

/** One difference. `before` is absent on `added`, `after` on `removed`. */
export interface VariableDiffEntry {
  path: VariablePath
  kind: VariableDiffKind
  before?: unknown
  after?: unknown
  notes?: VariableDiffNote[]
}

/** How many entries of each kind. */
export interface VariableDiffSummary {
  added: number
  removed: number
  changed: number
}

/** The whole comparison. */
export interface VariableDiff {
  entries: VariableDiffEntry[]
  summary: VariableDiffSummary
  /** True when the two tables hold the same values. */
  identical: boolean
}

/** One side of a `chat.variablesDiff`, as the host resolved it. */
export interface VariablesDiffSide {
  chatId: string
  floor: number
  /** The reading whose table was compared: the one asked for, else the selected one. */
  swipe: number
  /** How many readings the floor has (1 for a user line). */
  swipes: number
  /** Whose line the floor is, when there is a floor. */
  role?: 'user' | 'assistant'
  /**
   * Where the table came from: the floor's own slot (`chat[i].variables[swipe]`),
   * or — for a user line that carries none — its turn's table, which is what a
   * card reading that floor is given on this host (DEVIATIONS 14).
   */
  source: 'floor' | 'turn' | 'none'
  /**
   * Why there is no table, when there is none: the floor does not exist, the
   * reading does not, or the floor never had a table written.
   */
  missing?: 'no-floor' | 'no-swipe' | 'no-table'
  /** Set when a cleanup trimmed keys from this table; what is compared is what survived. */
  pruned?: true
}

/** The answer to `chat.variablesDiff`. */
export interface VariablesDiffView extends VariableDiff {
  a: VariablesDiffSide
  b: VariablesDiffSide
  /** The two tables compared, when the request asked for them; a missing side is absent. */
  tables?: { a?: Record<string, unknown>, b?: Record<string, unknown> }
}

/**
 * The `tables` field of an answer, built the same way by both halves.
 * @param a - side A's table, or undefined when missing.
 * @param b - side B's table, likewise.
 * @returns the field, with a missing side left out.
 */
export function diffTables(a: unknown, b: unknown): NonNullable<VariablesDiffView['tables']> {
  const table = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const left = table(a)
  const right = table(b)
  return { ...left === undefined ? {} : { a: left }, ...right === undefined ? {} : { b: right } }
}

/** The kinds a value can be, for deciding whether two values are comparable. */
type Shape = 'object' | 'array' | 'null' | 'string' | 'number' | 'boolean' | 'other'

function shapeOf(value: unknown): Shape {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'object': return 'object'
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    default: return 'other'
  }
}

/** An own property's value, read without going through any accessor a key could name. */
function own(record: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Whether a value has the MVU `[value, description]` shape.
 * @param value - any value.
 * @returns true for a two-element array whose second element is a string and whose first is not an array.
 */
export function isMvuPair(value: unknown): value is [unknown, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && !Array.isArray(value[0])
}

/**
 * Deep equality over JSON-shaped values: objects order-blind by own keys,
 * arrays by position, scalars by `Object.is` (so `NaN` equals itself).
 * @param a - one value.
 * @param b - the other.
 * @returns whether they hold the same thing.
 */
export function sameVariables(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  const shape = shapeOf(a)
  if (shape !== shapeOf(b)) return false
  if (shape === 'array') {
    const left = a as unknown[]
    const right = b as unknown[]
    return left.length === right.length && left.every((entry, at) => sameVariables(entry, right[at]))
  }
  if (shape === 'object') {
    const left = a as object
    const right = b as object
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every(key => hasOwn(right, key) && sameVariables(own(left, key), own(right, key)))
  }
  return false
}

/**
 * Compare two variable tables.
 * @param before - side A; `undefined` when that floor has no snapshot.
 * @param after - side B; likewise.
 * @returns every difference, in B's key order with A-only keys after, and the counts.
 */
export function diffVariables(before: unknown, after: unknown): VariableDiff {
  const entries: VariableDiffEntry[] = []
  walk(before === undefined ? {} : before, after === undefined ? {} : after, [], [])
  const summary: VariableDiffSummary = { added: 0, removed: 0, changed: 0 }
  for (const entry of entries) summary[entry.kind] += 1
  return { entries, summary, identical: entries.length === 0 }

  function push(entry: Omit<VariableDiffEntry, 'notes'>, notes: readonly VariableDiffNote[]): void {
    const unique = [...new Set(notes)]
    entries.push(unique.length === 0 ? entry : { ...entry, notes: unique })
  }

  function walk(was: unknown, now: unknown, path: VariablePath, notes: readonly VariableDiffNote[]): void {
    if (sameVariables(was, now)) return

    // The value half of an MVU pair, at the pair's own path.
    if (isMvuPair(was) && isMvuPair(now) && was[1] === now[1]) {
      walk(was[0], now[0], path, [...notes, 'mvu'])
      return
    }

    const shape = shapeOf(was)
    if (shape !== shapeOf(now)) {
      push({ path, kind: 'changed', before: was, after: now }, [...notes, 'type'])
      return
    }

    if (shape === 'object') {
      const left = was as object
      const right = now as object
      for (const key of Object.keys(right)) {
        const here = [...path, key]
        if (hasOwn(left, key)) walk(own(left, key), own(right, key), here, notes)
        else push({ path: here, kind: 'added', after: own(right, key) }, notes)
      }
      for (const key of Object.keys(left)) {
        if (!hasOwn(right, key)) push({ path: [...path, key], kind: 'removed', before: own(left, key) }, notes)
      }
      return
    }

    if (shape === 'array') {
      const left = was as unknown[]
      const right = now as unknown[]
      const indexed: VariableDiffNote[] = [...notes, 'index']
      for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
        const here = [...path, at]
        if (at < left.length && at < right.length) walk(left[at], right[at], here, indexed)
        else if (at < right.length) push({ path: here, kind: 'added', after: right[at] }, indexed)
        else push({ path: here, kind: 'removed', before: left[at] }, indexed)
      }
      return
    }

    push({ path, kind: 'changed', before: was, after: now }, notes)
  }
}
