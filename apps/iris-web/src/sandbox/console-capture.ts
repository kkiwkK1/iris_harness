/**
 * A card script's `console.*` arguments, turned into one bounded line.
 *
 * The frame captures `console.log/info/warn/error`, and the shell is the only
 * party that can put what it captured in front of the reader — the frame is
 * behind `srcdoc` and cannot reach the host. The question this module answers is
 * what travels across that hop.
 *
 * **A summary, never the arguments themselves.** A `postMessage` structured
 * clone of a card's own object graph can fail on a function, a DOM node, or an
 * object with a throwing getter — and the whole point of capturing console
 * output is that it must not itself break the card. So every value is turned
 * into text here, in the frame, before it crosses anything.
 *
 * **Bounded, because the card chooses the size.** A card can `console.log` a
 * 10 MB string or an object with a hundred thousand keys. Without a ceiling the
 * summary would cross a message boundary at that size and land in a buffer
 * capped in bytes — one line evicting every real report beside it. Two ceilings
 * apply per value (depth, then characters) and one per line, and the truncation
 * is **visible in the text** (`…(N more)`, `…+M chars`) rather than silent: a
 * reader who cannot tell a short string from a truncated one cannot tell a
 * healthy card from a broken summary.
 *
 * **Circular-safe**, which is not defensive style. `JSON.stringify` throws on a
 * cycle and a card's state object routinely points back at itself; the same
 * `WeakSet` that makes this not throw is what lets the text say `[Circular]`
 * instead.
 *
 * Separated from `frame-entry.ts` for its test: the capture needs a `window`
 * and a `postMessage`, the serialization needs neither, and the serialization is
 * the part with the arithmetic worth pinning.
 *
 * @module iris-web/sandbox/console-capture
 */

/** The levels captured, in the order upstream's `log.js` overrides them. */
export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'] as const

/** One of the four captured levels. */
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

/**
 * The ceiling on how deep one value is described before it is elided.
 *
 * Four, because a card's logged object is usually one or two levels (`{turn,
 * vars}`) and the interesting field is rarely deeper; past that the line is
 * mostly braces, and the whole value is available to the card's own devtools if
 * it wants it.
 */
export const MAX_DEPTH = 4

/**
 * The ceiling on how many entries of one array or object are described.
 *
 * Twelve, because a logged array is a sample — "35 items, the first twelve" is
 * what a reader acts on, and a line listing two hundred of them pushes every
 * other report out of a bounded buffer.
 */
export const MAX_ENTRIES = 12

/**
 * The ceiling on one value's characters, applied after depth and entries.
 *
 * String values are truncated to this directly (with a visible `…+N chars`
 * marker); structured values are serialized and truncated the same way. 512 is
 * roughly one wrapped line in the report panel, which is where this text lands.
 */
export const MAX_VALUE_CHARS = 512

/**
 * The ceiling on the whole line: level, values, everything.
 *
 * Larger than one value's ceiling because a `console.log(a, b, c)` is one
 * line with three values, and smaller than the request schema's own 8 000-char
 * bound so the frame's cut always happens first — the host's bound is a wire
 * sanity check, not where truncation is supposed to be decided.
 */
export const MAX_LINE_CHARS = 4_000

/** What the serializer carries, plus the facts the shell needs to file it. */
export interface ConsoleEntry {
  level: ConsoleLevel
  /** The bounded summary, ready to display. */
  message: string
  /** When the card printed it, on the frame's own clock. */
  at: number
}

/** Truncate a string, saying so, rather than silently cutting it. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…+${String(text.length - limit)} chars`
}

/**
 * Describe one value as text, within the depth/entries/characters ceilings.
 *
 * @param value - anything a card passed to `console.*`.
 * @param depth - the recursion budget left; `0` elides rather than recurses.
 * @param seen - the values on the current path, for cycle detection.
 * @returns a bounded description.
 */
function describeValue(value: unknown, depth: number, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'undefined':
      return 'undefined'
    case 'string':
      // Quoted, because `console.log('a b')` and `console.log(a, b)` must not
      // read identically — upstream's console distinguishes them and a summary
      // that does not is a summary of a different call.
      return clip(JSON.stringify(value) ?? '""', MAX_VALUE_CHARS)
    case 'number':
      return Number.isFinite(value) ? String(value) : String(value)
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${String(value)}n`
    case 'symbol':
      return value.description === undefined ? 'Symbol()' : `Symbol(${value.description})`
    case 'function':
      return `[Function${(value as { name?: string }).name === undefined || (value as { name?: string }).name === '' ? '' : `: ${(value as { name: string }).name}`}]`
    default:
      break
  }
  const object = value as object
  /*
   * A DOM node, a Promise, an Error and a Map are each described by what they
   * *are* rather than by walking them. A node walk is unbounded and throws on
   * some getters; a Promise has nothing enumerable; an Error's own fields are
   * not what a reader wants first; a Map/Set read as `{}` under `Object.keys`,
   * which would report every non-empty one as empty — a wrong reading, not a
   * partial one.
   */
  if (typeof Node !== 'undefined' && object instanceof Node) {
    const element = object as Node & { outerHTML?: string }
    return typeof element.outerHTML === 'string'
      ? clip(element.outerHTML, MAX_VALUE_CHARS)
      : `[${object.constructor.name}]`
  }
  if (object instanceof Error) {
    return clip(`${object.name}: ${object.message}`, MAX_VALUE_CHARS)
  }
  if (object instanceof Promise) return '[Promise]'
  if (object instanceof Map) {
    const rows = [...object.entries()].slice(0, MAX_ENTRIES)
      .map(([key, entry]) => `${describeValue(key, depth - 1, seen)} => ${describeValue(entry, depth - 1, seen)}`)
    return clip(`Map(${String(object.size)}) {${rows.join(', ')}${object.size > rows.length ? `, …${String(object.size - rows.length)} more` : ''}}`, MAX_VALUE_CHARS)
  }
  if (object instanceof Set) {
    const rows = [...object.values()].slice(0, MAX_ENTRIES).map(entry => describeValue(entry, depth - 1, seen))
    return clip(`Set(${String(object.size)}) {${rows.join(', ')}${object.size > rows.length ? `, …${String(object.size - rows.length)} more` : ''}}`, MAX_VALUE_CHARS)
  }
  if (seen.has(object)) return '[Circular]'
  if (depth <= 0) return Array.isArray(object) ? '[…]' : '{…}'
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      const rows = object.slice(0, MAX_ENTRIES).map(entry => describeValue(entry, depth - 1, seen))
      const rest = object.length - rows.length
      return clip(`[${rows.join(', ')}${rest > 0 ? `, …${String(rest)} more` : ''}]`, MAX_VALUE_CHARS)
    }
    let keys: string[]
    try {
      keys = Object.keys(object)
    } catch {
      // A proxy whose `ownKeys` throws — the read is the card's, and failing it
      // would fail the console call that was only trying to describe something.
      return '[unreadable]'
    }
    const rows: string[] = []
    for (const key of keys.slice(0, MAX_ENTRIES)) {
      let entry: unknown
      try {
        entry = (object as Record<string, unknown>)[key]
      } catch {
        // A throwing getter. Named rather than omitted, so a reader can tell
        // "the object does not have this" from "reading it failed".
        rows.push(`${key}: [getter threw]`)
        continue
      }
      rows.push(`${key}: ${describeValue(entry, depth - 1, seen)}`)
    }
    const rest = keys.length - Math.min(keys.length, MAX_ENTRIES)
    return clip(`{${rows.join(', ')}${rest > 0 ? `, …${String(rest)} more` : ''}}`, MAX_VALUE_CHARS)
  } finally {
    // Removed on the way out, so a shared reference that is *not* a cycle is
    // described each time it appears. A WeakSet that never removed would report
    // the second occurrence of any repeated object as circular.
    seen.delete(object)
  }
}

/**
 * Serialize one `console.*` call into a bounded line.
 *
 * @param level - which console method the card called.
 * @param args - exactly what the card passed.
 * @param at - when it called, on the caller's clock.
 * @returns the entry to carry across the frame boundary.
 */
export function serializeConsole(level: ConsoleLevel, args: readonly unknown[], at: number): ConsoleEntry {
  const seen = new WeakSet<object>()
  const parts = args.map(arg => describeValue(arg, MAX_DEPTH, seen))
  return { level, at, message: clip(`${level}: ${parts.join(' ')}`, MAX_LINE_CHARS) }
}

/**
 * A per-card rate gate for console reports.
 * Every one that crossed the boundary would land in a buffer capped at 2 000
 * records and 1 MiB, evicting the reports a reader actually opened the page for
 * — so the gate is not politeness, it is what keeps the diagnostic surface
 * usable while a card misbehaves.
 *
 * **The budget is per second and it counts the drops**, because the one thing
 * worse than losing lines is losing them silently: a reader who sees 40 lines
 * and no counter concludes the card printed 40.
 *
 * A plain function of `(now, budget)` rather than a class with a timer: this
 * runs in the frame, on the card's own call, and a timer would keep the frame
 * alive to deliver a sentence nobody asked for. The count is reported on the
 * next allowed line instead — see {@link RateGate.admit}.
 */
export class RateGate {
  #windowStart: number
  #admitted = 0
  #dropped = 0
  readonly #budget: number

  /**
   * @param budget - lines admitted per one-second window.
   * @param now - the frame's clock at construction; injectable for tests.
   */
  constructor(budget: number, now: number = Date.now()) {
    this.#budget = budget
    this.#windowStart = now
  }

  /**
   * Decide whether one line may go out, and what to say about what did not.
   * @param now - the current time on the same clock the constructor was given.
   * @returns `undefined` to drop the line, or the text to append to it (the
   *   count of lines dropped since the last admission, when there were any).
   */
  admit(now: number): { dropped: number } | undefined {
    if (now - this.#windowStart >= 1_000) {
      this.#windowStart = now
      this.#admitted = 0
    }
    if (this.#admitted >= this.#budget) {
      this.#dropped += 1
      return undefined
    }
    this.#admitted += 1
    const dropped = this.#dropped
    this.#dropped = 0
    return { dropped }
  }
}

/** How many console lines one card may emit per second before lines are dropped. */
export const CONSOLE_BUDGET_PER_SECOND = 50

/** What one captured line is handed to, once it has been admitted. */
export type ConsoleSink = (level: ConsoleLevel, message: string, at: number) => void

/**
 * Wrap a target's four console methods so every call is forwarded and then
 * passed through to the original.
 *
 * **Both happen, in that order.** A card author develops against devtools, so
 * the original must still run; the forward must happen first so a serializer
 * failure cannot lose the browser line too. The original is called with
 * `apply(target, args)` rather than a bare call — some engines require the
 * console as receiver — and a realm that refuses the write keeps the console it
 * had.
 *
 * Split out of `frame-entry.ts` so the wrapper can be driven with a plain
 * object and a captured sink. The frame's own copy is this function called with
 * `globalThis.console`; what a test cannot get from there is a stable target to
 * assert against, which is what the `target` parameter is for.
 *
 * @param target - the object whose four methods are replaced (a console).
 * @param sink - called with each admitted line, before the original runs.
 * @param options.now - the clock, so a test can drive the rate window without
 *   sleeping.
 * @returns how many of the four levels were wrapped, for a caller that wants to
 *   say whether the capture is live.
 */
export function installConsoleCapture(
  target: Record<string, unknown>,
  sink: ConsoleSink,
  options: { now?: () => number } = {},
): number {
  const now = options.now ?? ((): number => Date.now())
  const gate = new RateGate(CONSOLE_BUDGET_PER_SECOND, now())
  let wrapped = 0
  for (const level of CONSOLE_LEVELS) {
    const original = target[level]
    if (typeof original !== 'function') continue
    try {
      target[level] = (...args: unknown[]): void => {
        try {
          const at = now()
          const verdict = gate.admit(at)
          if (verdict !== undefined) {
            const entry = serializeConsole(level, args, at)
            // The dropped count rides the next admitted line rather than a line
            // of its own: a report about lost reports is the one line that must
            // not itself be losable, and it would be the first to go under the
            // very pressure it is describing.
            const dropped = verdict.dropped === 0
              ? ''
              : ` (${String(verdict.dropped)} earlier line(s) from this card were dropped:`
                + ' over the per-second limit)'
            sink(level, entry.message + dropped, at)
          }
        } catch {
          // A serializer that threw must not break the call it was observing.
        }
        ;(original as (...a: unknown[]) => void).apply(target, args)
      }
      wrapped += 1
    } catch {
      // A realm that refuses the write keeps the console it already had.
    }
  }
  return wrapped
}
