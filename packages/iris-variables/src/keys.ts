/**
 * The keys a card may never write.
 *
 * Every variable table in Iris is a plain JavaScript object, and every write
 * face reaches it through lodash — `mergeWith` in `semantics.ts`, `_.set` in
 * MVU and in the template realm, a hand-written `writePath` in the app
 * service. Lodash 4.18's `safeGet` refuses `__proto__` and `constructor`
 * *inside* `baseMerge`, which is why the range in this package's manifest is
 * load-bearing; but a dependency range is a promise about a file on disk, not
 * a property of this code, and the three names are refused here so that the
 * guarantee survives a resolution nobody looked at.
 *
 * Upstream SillyTavern does not filter these. `chat_metadata.variables` is
 * written with `_.set` and with direct assignment
 * (`public/scripts/variables.js`), so a card there can put whatever it likes
 * into the page's own `Object.prototype`. Iris runs card code in a frame and
 * the tables cross a wire into a *host process* that also serves every other
 * conversation, which is the difference that makes the refusal worth the
 * divergence — see `notes/packages/iris-variables/DEVIATIONS.md` §1.
 *
 * @module @iris/variables/keys
 */

/**
 * The three names.
 *
 * `__proto__` is the accessor that re-points an object's prototype, so an
 * assignment through it is a write into a *shared* object rather than into the
 * table. `constructor` and `prototype` are the two steps of the classic ladder
 * from any object to `Object.prototype` (`x.constructor.prototype`), so a path
 * naming either of them is a walk out of the table and into a shared object.
 */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Whether a name may not be used as a variable key or as a path segment.
 *
 * All three, in both positions, and that width is a **measurement** rather
 * than a preference. Over the corpus — 13,838 JSON documents, 765,759 objects
 * walked, 3,518 deduplicated script and interface-text bodies, 2,855 variable
 * API call sites — no card, world book, chat, group, preset or settings file
 * holds any of the three as an own data key, and no variable path contains one
 * as a segment. `constructor` and `prototype` do occur 21 times in card code,
 * every one of them ordinary JavaScript (18 class `constructor(…)`
 * definitions, 3 × `Object.prototype.hasOwnProperty.call`), which is not a
 * table key and is untouched by this predicate.
 *
 * So the narrower rule the audit allowed for — refuse the two only as path
 * segments, keep them as leaf data — would buy nothing and cost a second rule
 * to remember. What would overturn that: a card that stores a *map keyed by
 * arbitrary strings* in its variables. One such object exists on disk already,
 * `data/_cache/deepseek.json` at `$.model.vocab.constructor` — a tokenizer
 * vocabulary whose BPE tokens happen to include the word — and it is not a
 * variable table, but it is the shape that would reopen this.
 * @param name - the candidate key.
 * @returns true when the name is one of the three.
 */
export function isForbiddenKey(name: string): boolean {
  return FORBIDDEN.has(name)
}

/**
 * Split a lodash-style path into its segments.
 *
 * `a.b[0].c` and `a["__proto__"].b` both reach the same place, so both spellings
 * have to be seen. Quotes are stripped because lodash strips them.
 * @param path - a lodash path.
 * @returns the segments, empty ones dropped.
 */
export function pathSegments(path: string): string[] {
  return path
    .split(/[.[\]]/u)
    .map(segment => segment.replace(/^\s*['"]|['"]\s*$/gu, ''))
    .filter(segment => segment !== '')
}

/**
 * The first forbidden segment of a path, if it has one.
 *
 * Every segment is tested against the wide set: `a.constructor.b` is a walk
 * through `Object`, and `stat_data.prototype` is a lookup that answers
 * `undefined` for a data table and something quite different for a function.
 * @param path - a lodash path, e.g. `角色.络络.好感度`.
 * @returns the offending segment, or undefined when the path is ordinary.
 */
export function forbiddenSegmentIn(path: string): string | undefined {
  for (const segment of pathSegments(path)) {
    if (isForbiddenKey(segment)) return segment
  }
  return undefined
}

/**
 * Walk a tree and report the first forbidden own key.
 *
 * Arrays are walked too: `JSON.parse` puts a literal `"__proto__"` member on an
 * array as readily as on an object, and `_.merge` copies it across.
 *
 * The walk reads own property *names* rather than `Object.entries`, because a
 * key `JSON.parse` created is an own enumerable data property while the same
 * name written by a JavaScript object literal is not a key at all — it has
 * already moved the prototype. The prototype itself is checked so that the
 * second case is not silently walked past; `assertStorable` in the app service
 * makes the same check for a different reason and both are load-bearing.
 * @param value - the tree.
 * @param path - where the tree sits, for the message.
 * @returns the full path of the offending key, or undefined when the tree is clean.
 */
export function findForbiddenKey(value: unknown, path = 'value'): string | undefined {
  const seen = new Set<object>()
  const walk = (node: unknown, at: string): string | undefined => {
    if (typeof node !== 'object' || node === null) return undefined
    if (seen.has(node)) return undefined
    seen.add(node)

    // `{ __proto__: {...} }` written in JavaScript source is not an own key at
    // all — it has already moved the prototype — so the own-key loop below
    // would walk straight past the one shape this module exists to refuse.
    const prototype = Object.getPrototypeOf(node) as unknown
    const expected: unknown = Array.isArray(node) ? Array.prototype : Object.prototype
    if (prototype !== expected && prototype !== null) return `${at}.__proto__`

    for (const key of Object.getOwnPropertyNames(node)) {
      if (Array.isArray(node) && (key === 'length' || /^\d+$/u.test(key))) {
        const found = walk((node as unknown[])[Number(key)], `${at}[${key}]`)
        if (found !== undefined) return found
        continue
      }
      if (isForbiddenKey(key)) return `${at}.${key}`
      const found = walk((node as Record<string, unknown>)[key], `${at}.${key}`)
      if (found !== undefined) return found
    }
    return undefined
  }

  return walk(value, path)
}

/** Raised when a write names one of the three. */
export class ForbiddenKeyError extends Error {
  /** The offending path, as the walker or the splitter named it. */
  readonly keyPath: string

  /**
   * @param keyPath - the offending path.
   * @param what - what was being written, for the sentence.
   */
  constructor(keyPath: string, what = 'a variable write') {
    super(`${what} names "${keyPath}", which cannot be used as a variable key`)
    this.name = 'ForbiddenKeyError'
    this.keyPath = keyPath
  }
}

/**
 * Refuse a tree that carries a forbidden own key.
 * @param value - the tree about to be stored.
 * @param path - where it sits, for the message.
 * @throws {ForbiddenKeyError} at the first offending key.
 */
export function assertNoForbiddenKeys(value: unknown, path = 'value'): void {
  const found = findForbiddenKey(value, path)
  if (found !== undefined) throw new ForbiddenKeyError(found)
}

/**
 * Refuse a path that walks through a forbidden segment.
 * @param path - the lodash path about to be written.
 * @throws {ForbiddenKeyError} when any segment is one of the three.
 */
export function assertPathWritable(path: string): void {
  const segment = forbiddenSegmentIn(path)
  if (segment !== undefined) throw new ForbiddenKeyError(segment, `the path "${path}"`)
}
