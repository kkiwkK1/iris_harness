/**
 * How long each generation took, kept per candidate and carried in the chat
 * file — in SillyTavern's own fields, so the numbers show up in SillyTavern.
 *
 * Upstream measures this already and shows it as a message timer: a
 * `{seconds}s` badge whose hover title carries "Generation queued", "Reply
 * received", "Time to generate", "Time to first token", "Time to think" and
 * **"Token rate: {n} t/s"** (`public/script.js:2681` `formatGenerationTimer`,
 * read at `:2586` from `mes.gen_started`, `mes.gen_finished`,
 * `mes.extra.token_count`, `mes.extra.reasoning_duration` and
 * `mes.extra.time_to_first_token`). The four *inputs* are written by the
 * streaming processor at `:3625`-`:3630`; the token count they are divided by
 * is upstream's own tokenizer estimate of the reply text
 * (`getTokenCountAsync`, `:3638`).
 *
 * So this module is the **measurement** half of a per-turn output speed, and
 * `@iris/protocol`'s `TurnGeneration` is what it produces. What Iris divides by
 * is different, and only that: the provider's reported `outputTokens` rather
 * than a local estimate (`notes/apps/iris-web/DEVIATIONS.md` §47 rules that
 * departure for every usage figure; §92 states it for the rate).
 *
 * **Storage is upstream's four fields, not a key of Iris's own.** `usage.ts`
 * had to invent `iris_usage` because upstream has no place for a provider's
 * bill; here upstream has exactly the place, has had it for years, and a chat
 * file Iris writes must show its timer — and its rate — when the same file is
 * opened in SillyTavern. Which means the two records are stored differently on
 * purpose:
 *
 * - `iris_usage` is a **top-level array parallel to `swipes`**, one entry per
 *   candidate (see `USAGE_FIELD` for the measurement that decided that).
 * - the timer's four fields are **the line's own**, describing the swipe the
 *   line is currently showing, because that is what they mean upstream: the
 *   per-swipe archive is `swipe_info[i].{gen_started, gen_finished, extra}`
 *   (`public/script.js:3648`-`:3653`), a structure this host does not model.
 *
 * The residual, stated because it is real: only the **selected** candidate's
 * timing survives a save. The log holds every candidate's while the chat is
 * open, and a swipe back to an older reading after a reload finds its speed
 * gone. That is a smaller loss than it sounds — the reading a user is looking
 * at is the one whose figure is on screen — and the alternative was either a
 * second parallel array of Iris's own (which would not show in SillyTavern, the
 * whole point of using these fields) or modelling `swipe_info`.
 *
 * @module @iris/app-service/timing
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SillyTavernMessage } from '@iris/persistence'
import type { TurnGeneration } from '@iris/protocol'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * How long one candidate's generation took.
     *
     * Keyed by `candidateSeq` like `iris/usage` and `iris/variables`, and for
     * the same reason: a swipe is its own generation and took its own time.
     * Appended once when the generation settles; a second append for the same
     * candidate is a correction and the newest one is read.
     *
     * A **separate event** from `iris/usage` rather than a field on it,
     * because the two are independently absent: most OpenAI-compatible
     * endpoints report no usage at all, and a turn through one of them still
     * has a duration this host measured itself. Folding timing into the usage
     * event would have made "how fast was that" answerable only for providers
     * that also say what they charged.
     */
    'iris/generation-timing': {
      /** Seq of the `assistant/message` event this generation produced. */
      candidateSeq: number
      timing: TurnGeneration
    }
  }
}

/**
 * Upstream's own names for the four fields, quoted once.
 *
 * Spelled out as constants rather than inlined at the read and the write
 * because they are a **compatibility contract**: `time_to_first_token` is a key
 * in another product's file format, and a typo in one of the two places would
 * make Iris write a file whose timer SillyTavern silently does not show.
 */
export const GEN_STARTED_FIELD = 'gen_started'
/** @see GEN_STARTED_FIELD */
export const GEN_FINISHED_FIELD = 'gen_finished'
/** Inside `extra`, where upstream's streaming processor puts it (`public/script.js:3630`). */
export const FIRST_TOKEN_FIELD = 'time_to_first_token'
/** Inside `extra`, written by upstream's `ReasoningHandler` (`public/scripts/reasoning.js:416`). */
export const REASONING_DURATION_FIELD = 'reasoning_duration'

/**
 * A moment in the format upstream's file carries.
 *
 * Upstream assigns `Date` objects (`chat[messageId].gen_started = this.timeStarted`,
 * `public/script.js:3625`) and `JSON.stringify` turns those into ISO 8601 with
 * milliseconds and a `Z`, which is what `moment(...)` reads back at `:2687`.
 * Measured over the 13,186 message lines of the SillyTavern install on this
 * machine: 12,960 of these timestamps, **all** of them strings and **all** of
 * them canonical `YYYY-MM-DDTHH:mm:ss.sssZ` — so an epoch parsed out of one and
 * re-serialised here is byte-identical to what upstream wrote, and a chat that
 * round-trips through Iris does not change a character of them.
 * @param at - Unix epoch milliseconds.
 * @returns the timestamp as the file spells it.
 */
export function stampOf(at: number): string {
  return new Date(at).toISOString()
}

/** The newest timing recorded for each candidate. */
export function timingBySeq(session: Session): Map<number, TurnGeneration> {
  const timings = new Map<number, TurnGeneration>()
  for (const event of session.events) {
    if (event.type === 'iris/generation-timing') timings.set(event.data.candidateSeq, event.data.timing)
  }
  return timings
}

/** A finite, non-negative millisecond span, or `undefined` for anything else. */
function spanOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value)
}

/**
 * Read one message line's generation timer.
 *
 * Strict in the two directions that produce a *wrong* number rather than a
 * missing one:
 *
 * - both ends or nothing. `formatGenerationTimer` returns `{}` for a missing
 *   one (`public/script.js:2682`) and so does this: half a window is not a
 *   duration.
 * - a window that runs backwards is refused, which is upstream's own
 *   `isNaN(seconds) || seconds < 0` branch at `:2701`. A negative duration
 *   would divide a token count into a negative rate.
 *
 * Lenient about the two `extra` figures, because absence there is the ordinary
 * case and so is `null`: upstream assigns `extra.time_to_first_token =
 * this.timeToFirstToken` unconditionally and that field is initialised to
 * `null` (`:3512`), and `reasoning_duration` is `getDuration()`, which returns
 * `null` when no reasoning happened (`public/scripts/reasoning.js:381`). The
 * corpus on this machine has 1,260 lines carrying `reasoning_duration: null`
 * against 5,221 carrying a number, so a reader that treated `null` as `0` would
 * put "thought for 0 seconds" on a fifth of them.
 * @param line - one message line from a chat file.
 * @returns the timing, or `undefined` when the line carries none.
 */
export function parseTiming(line: SillyTavernMessage): TurnGeneration | undefined {
  const started = line[GEN_STARTED_FIELD]
  const finished = line[GEN_FINISHED_FIELD]
  if (typeof started !== 'string' || typeof finished !== 'string') return undefined
  const startedAt = Date.parse(started)
  const finishedAt = Date.parse(finished)
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return undefined
  const durationMs = finishedAt - startedAt
  if (durationMs < 0) return undefined

  const extra = line.extra
  const bag: Record<string, unknown> = typeof extra === 'object' && extra !== null && !Array.isArray(extra)
    ? extra
    : {}
  const firstTokenMs = spanOf(bag[FIRST_TOKEN_FIELD])
  const reasoningMs = spanOf(bag[REASONING_DURATION_FIELD])
  return {
    startedAt,
    durationMs,
    ...firstTokenMs === undefined ? {} : { firstTokenMs },
    ...reasoningMs === undefined ? {} : { reasoningMs },
  }
}

/**
 * Write one message line's generation timer, in upstream's fields.
 *
 * **Only the fields this record has.** A timing with no `reasoningMs` leaves
 * whatever the line already carried alone rather than writing `0` or deleting
 * the key: an imported line may carry upstream's own `reasoning_duration: null`
 * (1,260 lines of the corpus do), and both overwriting it with a number Iris
 * did not measure and dropping it from the round trip would be this host
 * editing another product's record of its own work.
 *
 * `extra` is created only when there is something to put in it, so a chat
 * played through a provider that never reasoned and never sent a first token
 * gains no empty object it did not have.
 * @param line - the line to stamp, mutated in place.
 * @param timing - the record to write.
 */
export function writeTiming(line: SillyTavernMessage, timing: TurnGeneration): void {
  line[GEN_STARTED_FIELD] = stampOf(timing.startedAt)
  line[GEN_FINISHED_FIELD] = stampOf(timing.startedAt + timing.durationMs)
  if (timing.firstTokenMs === undefined && timing.reasoningMs === undefined) return
  const existing = line.extra
  // **A copy, never the object that was there.** An imported line's `extra`
  // is the very object the log's `iris/st-meta` event remembers, handed back
  // by `rowFields` — the log's records are frozen, so writing into it throws
  // (`Cannot assign to read only property 'time_to_first_token'`, which is how
  // this was found), and if they were not frozen it would edit the log's copy
  // of what the file originally held. Either way the export must build a new
  // object and leave the record alone.
  const extra: Record<string, unknown> = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    ? { ...existing }
    : {}
  if (timing.firstTokenMs !== undefined) extra[FIRST_TOKEN_FIELD] = timing.firstTokenMs
  if (timing.reasoningMs !== undefined) extra[REASONING_DURATION_FIELD] = timing.reasoningMs
  line.extra = extra
}
