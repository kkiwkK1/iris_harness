/**
 * Retention for the diagnostic bus, and the shape a debug page reads it in.
 *
 * The host already reported every survived failure — to `ctx.logger.warn`, and
 * then nowhere. Nothing was kept, so a page had nothing to ask for. This adds
 * the retention behind the existing bus and a pull surface over it; it adds no
 * new report sites, because the charter's first layer asks for **context on the
 * reports that exist**, not for more of them.
 *
 * @module @iris/app-service/diagnostics
 */

/**
 * What a report is about.
 *
 * These are today's text prefixes promoted to a field. The set is closed and
 * declared (see {@link WIRED_KINDS}) because a page must be able to tell "this
 * kind is collected and nothing happened" from "this kind was never wired" —
 * and it cannot tell those apart from a count of zero.
 */
export type ReportKind =
  | 'mvu'
  | 'template'
  | 'prompt'
  | 'script'
  | 'variables'
  | 'host'

/**
 * Every kind the host has actually wired a report site for.
 *
 * Handed to the page verbatim so an empty section can say which of the two
 * empties it is. A kind listed here with no records means collection is live
 * and nothing happened; a kind absent from here means nobody is looking. The
 * page must never infer that difference from zero records — that inference is
 * exactly what it cannot make, and guessing "all clear" when the truth is "not
 * instrumented" is the failure a diagnostic page can least afford, because it
 * is the tool people use when they suspect something else is lying.
 */
export const WIRED_KINDS: readonly ReportKind[] = [
  'mvu',
  'template',
  'prompt',
  'script',
  'variables',
  'host',
]

/** One survived failure, as the debug page reads it. */
export interface DebugReport {
  /** Monotonic, and the cursor a page pages with. */
  seq: number
  /** Unix epoch milliseconds. */
  at: number
  kind: ReportKind
  /** Which conversation, when the report site knows. */
  chatId?: string
  /** Which card. */
  characterId?: string
  /** Which script. */
  scriptId?: string
  message: string
  /**
   * The original failure's stack — **present only when there was one**.
   *
   * Most report sites construct their own `Error` to carry a sentence they
   * wrote themselves. Attaching this host's call stack to such a report is
   * worse than attaching nothing: it reads as the origin of the failure while
   * actually being the location of the report. So a stack appears only when a
   * caught error supplied one.
   */
  stack?: string
}

/** Attribution a report site supplies alongside its message. */
export interface ReportContext {
  kind: ReportKind
  chatId?: string
  characterId?: string
  scriptId?: string
}

/**
 * How much to keep. Both caps apply; whichever binds first wins.
 *
 * **The count cap is deliberately loose and the byte cap is the real one.**
 * Measured rate on a card made to fail half its folds is 0.50 reports/turn at a
 * 41 B mean, linear with no accumulation, so 2000 records is roughly 4000 turns
 * of a pathological card — not a binding constraint.
 *
 * **The byte number has no measurement behind it, and that is recorded rather
 * than hidden.** The 41 B mean describes the MVU path; a template failure
 * carries `failure.message`, which can hold a whole rendered output, and no
 * real template failure has been produced yet to size it. A small mean is not a
 * reason to skip a byte cap — the cap exists for the tail the mean cannot see.
 * Revisit after the first real template failure.
 */
export interface BufferLimits {
  maxRecords: number
  maxBytes: number
}

/** Loose on count, deliberate on bytes; the byte figure is unvalidated. */
export const DEFAULT_LIMITS: BufferLimits = { maxRecords: 2000, maxBytes: 1_048_576 }

/** What a read of the buffer answers with. */
export interface ReportPage {
  reports: DebugReport[]
  /**
   * How many records the buffer discarded to stay inside its caps.
   *
   * Required, not decorative: "what I can see is everything" and "there was
   * more before this" are different states that a reader acts on differently,
   * and without this a truncated diagnostic bundle looks exactly like a
   * complete one.
   */
  dropped: number
  /** The oldest `seq` still held, so a page can tell its cursor fell off. */
  oldest: number
  /** The kinds the host declares it collects. See {@link WIRED_KINDS}. */
  kinds: readonly ReportKind[]
}

/**
 * A bounded, in-process ring of reports.
 *
 * Not persisted across restarts, deliberately — a restart empties it and says
 * so through `oldest`. Exporting a diagnostic bundle is a different feature
 * that wants one snapshot, not a log store.
 */
export class DiagnosticBuffer {
  readonly #limits: BufferLimits
  #records: DebugReport[] = []
  #bytes = 0
  #dropped = 0
  #next = 1

  /**
   * @param limits - the count and byte caps.
   */
  constructor(limits: BufferLimits = DEFAULT_LIMITS) {
    this.#limits = limits
  }

  /** Roughly what one record costs to hold, for the byte cap. */
  static #sizeOf(report: DebugReport): number {
    return report.message.length + (report.stack?.length ?? 0) + 64
  }

  /**
   * Keep one report.
   * @param context - which kind, and whatever attribution the site has.
   * @param message - the sentence to show.
   * @param stack - the caught error's stack, when there was one.
   * @returns the stored record.
   */
  record(context: ReportContext, message: string, stack?: string): DebugReport {
    const report: DebugReport = {
      seq: this.#next,
      at: Date.now(),
      kind: context.kind,
      message,
      ...context.chatId === undefined ? {} : { chatId: context.chatId },
      ...context.characterId === undefined ? {} : { characterId: context.characterId },
      ...context.scriptId === undefined ? {} : { scriptId: context.scriptId },
      ...stack === undefined ? {} : { stack },
    }
    this.#next += 1
    this.#records.push(report)
    this.#bytes += DiagnosticBuffer.#sizeOf(report)

    // Both caps, oldest first. A single oversized record still lands and then
    // sits alone: dropping it would lose the one report most likely to matter,
    // and the cap is there to bound the buffer, not to censor an entry.
    while (
      this.#records.length > this.#limits.maxRecords
      || (this.#bytes > this.#limits.maxBytes && this.#records.length > 1)
    ) {
      const evicted = this.#records.shift()
      if (evicted === undefined) break
      this.#bytes -= DiagnosticBuffer.#sizeOf(evicted)
      this.#dropped += 1
    }
    return report
  }

  /**
   * Read forward from a cursor.
   * @param since - return records with a `seq` greater than this.
   * @param limit - at most this many.
   * @returns the page, with the counters a reader needs to trust it.
   */
  read(since?: number, limit?: number): ReportPage {
    const after = since ?? 0
    const matching = this.#records.filter(report => report.seq > after)
    const capped = limit === undefined ? matching : matching.slice(0, Math.max(0, limit))
    return {
      reports: capped.map(report => ({ ...report })),
      dropped: this.#dropped,
      // Zero when nothing is held: there is no oldest record to name, and
      // reporting the next seq instead would tell a page its cursor had fallen
      // off a buffer that is merely empty.
      oldest: this.#records[0]?.seq ?? 0,
      kinds: WIRED_KINDS,
    }
  }

  /** How many records are held right now. */
  get size(): number {
    return this.#records.length
  }

  /** How many were discarded to stay inside the caps. */
  get dropped(): number {
    return this.#dropped
  }
}
