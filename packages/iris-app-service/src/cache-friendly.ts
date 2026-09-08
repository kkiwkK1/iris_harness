/**
 * Which contributions change from one turn to the next.
 *
 * A prefix cache hits on the request's leading bytes, so the question the
 * reorder in `@iris/pipeline` needs answered is not "what is this text" but
 * "will this text be the same next turn". This module answers it, and it lives
 * here rather than in the pipeline for one reason: the answer needs **memory
 * across turns**, and the only layer that owns per-conversation state is the
 * host.
 *
 * Two instruments, in this order of authority:
 *
 * 1. **Measurement.** The previous turn's content hash per contribution id. A
 *    different hash under the same id is not a guess — that text changed, and
 *    it will very likely change again.
 * 2. **Prediction**, for a contribution nobody has seen before (a new chat, a
 *    newly activated world-info entry). It reads the **pre-expansion** text for
 *    features that make a value move: an entropy or clock macro, a variable
 *    read, an EJS template, a runtime injection. Prediction only ever gets one
 *    turn's use per id; from the second sighting the hash decides.
 *
 * Why a mark is **held** and not re-decided every turn: coming back into the
 * stable prefix costs one full miss, exactly like leaving it did. A section
 * that changed once and then held still for two turns is not worth two misses
 * to find out. {@link DEFAULT_VOLATILE_HOLD} turns of hysteresis is the price
 * of not flapping.
 *
 * **The entropic-feature list is a prediction, not a definition.** It is here
 * in one place, with its source named per line, and it is wrong in the safe
 * direction on purpose: a feature it misses costs one miss on the second turn
 * and is then measured correctly forever, while a feature it invents moves
 * genuinely stable text out of the prefix and keeps it out for
 * {@link DEFAULT_VOLATILE_HOLD} turns. So the list carries only macros whose
 * value provably moves.
 *
 * @module @iris/app-service/cache-friendly
 */

import { isHelperMacroName } from '@iris/compat-tavernhelper'
import type { Contribution } from '@iris/pipeline'

/**
 * How many recorded assemblies a volatile mark survives without being renewed.
 *
 * Twenty, which for the measured corpus is longer than any conversation's
 * useful stretch of turns — the intent is that a mark effectively sticks unless
 * the content really has gone quiet, because the *return* to the prefix costs a
 * full miss and has to be worth it.
 */
export const DEFAULT_VOLATILE_HOLD = 20

/**
 * How many consecutive unchanged observations earn a contribution a place in
 * the stable prefix.
 *
 * Two, and the reason it is small is that the hold above already dominates: a
 * contribution that ever changed carries a volatile mark for
 * {@link DEFAULT_VOLATILE_HOLD} further generations, and only once that lapses
 * can this counter reach two. So this number governs one case only — a
 * contribution that has *never* been seen to change — and there the cost of
 * waiting is a turn of rent while the cost of acting is one miss. DeepSeek does
 * not serve a prefix until it has seen it twice anyway, so the first two turns
 * of a conversation were never going to hit.
 */
export const DEFAULT_SETTLE_AFTER = 2

/**
 * Macros whose expansion is not stable from one turn to the next.
 *
 * The names are Iris's own registry (`@iris/macro`'s `builtins.ts`), which is
 * what actually runs; upstream's table is `public/scripts/macros.js` and the
 * legacy `evaluateMacros` in it, and the two agree on every name below. Each
 * group says *why* it moves, because that is the part a reader has to check
 * when adding a name.
 *
 * Deliberately **absent**, with the reason, so the omissions read as decisions:
 *
 * - **The whole `{{getvar}}` / `{{setvar}}` / `{{addvar}}` / `{{incvar}}` /
 *   `{{decvar}}` family, global spellings included.** This is the correction
 *   that cost the most to find. They were on the list, and on the operator's own
 *   preset they fired on **136 of its 246 prompts** — `setvar` 70, `addvar` 56,
 *   `getvar` 15 — because a preset uses them for its *own* internal switches (a
 *   two-way writing-mode menu, a style flag), which are constant for a chat's
 *   settings and answer the same string turn after turn. Of those, 37 rendered
 *   non-empty for a real generation and were moved, `main` among them, taking
 *   爱衣's measured ceiling **from 72.2% down to 66.7%**. A variable read that
 *   really does move every turn is caught by the content hash on the second
 *   turn with the full hold — one miss to learn it, against a standing loss for
 *   guessing. After the narrowing the same preset predicts **1 of 246**
 *   (`{{lastUserMessage}}`, which genuinely moves).
 * - `{{outlet}}` — same shape: it reads a world-info bucket, which is usually
 *   the same bucket. The hash decides.
 * - `{{pick}}` — seeded on chat id, a hash of the surrounding text and the
 *   macro's offset in it (`builtins.ts:502-515`), so the same `{{pick}}` in the
 *   same entry answers the same way every rebuild. It is the one
 *   random-*looking* macro that is stable; the task brief listed it as entropic
 *   and, measured, it is not.
 * - `{{char}}` / `{{user}}` / `{{persona}}` / `{{original}}` — projections of
 *   settings. They change when the user renames something, and the hash catches
 *   that on the next turn, which is the right instrument for a once-a-month
 *   event.
 * - `{{maxPrompt}}` / `{{maxResponse}}` — the budget, constant for a chat's
 *   settings.
 *
 * The surviving entries all share one property: **their value provably differs
 * between two expansions, or provably moves as the conversation grows.** That
 * is the bar. "A macro that reads mutable state" is not the bar, because most
 * mutable state does not mutate.
 */
export const ENTROPIC_MACROS: readonly string[] = [
  // Fresh entropy: `Math.random` per expansion (`builtins.ts:495-536`,
  // `registry.ts:197-199` — upstream is `entropy: true` on the same two).
  'random',
  'roll',
  // The wall clock. Every one of these renders a different string as the day
  // moves (`builtins.ts:293-320`).
  'time',
  'date',
  'weekday',
  'isotime',
  'isodate',
  'datetimeformat',
  'timeDiff',
  'idleDuration',
  'idle_duration',
  // The conversation's own shape, which grows by two every turn
  // (`builtins.ts:184-241`).
  'lastMessage',
  'lastUserMessage',
  'lastCharMessage',
  'lastMessageId',
  'allChatRange',
  'lastSwipeId',
  'currentSwipeId',
  'firstIncludedMessageId',
  'firstDisplayedMessageId',
  'input',
]

/** The entropic macro names as a lookup, case-folded the way the expander matches. */
const ENTROPIC = new Set(ENTROPIC_MACROS.map(name => name.toLowerCase()))

/**
 * Every macro head in a piece of text, before expansion.
 *
 * `{{name}}` and `{{name::args}}` both yield `name`. Deliberately loose about
 * arguments: the head is the only part that decides whether the value can move.
 */
const MACRO_HEAD = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)/gu

/**
 * The one legacy spelling that hides its argument inside the macro name.
 *
 * `{{time_UTC-10}}`, transcribed from `@iris/macro`'s own `LEGACY_TIME_UTC`
 * (`expand.ts:249`) rather than approximated by splitting names on `_`: a
 * general split would read `{{date_of_birth}}` as `{{date}}` and quietly move a
 * stable section out of the prefix, and this is the only macro upstream spells
 * that way.
 *
 * The offset is optional here because {@link MACRO_HEAD} stops at the `+`: the
 * head it hands over is `time_UTC`, not `time_UTC+2`.
 */
const LEGACY_TIME_UTC = /^time_UTC([+-]\d+)?$/i

/**
 * EJS delimiters, which `@iris/compat-prompt-template` evaluates as arbitrary JS.
 *
 * Kept on the list where the variable macros were dropped, and the difference is
 * evidence: a `{{getvar}}` is a *read* of state that mostly does not move, while
 * `<% %>` is a program — it can read the clock, the floor list or anything else,
 * and nothing here can decide which. Measured cost of keeping it: the
 * operator's own 246-prompt preset contains **no** EJS at all, so the false
 * positive rate is zero on the corpus that exposed the other mistake.
 */
const EJS_TEMPLATE = /<%[\s\S]*?%>/u

/**
 * Why a piece of text is predicted volatile.
 *
 * A list rather than a boolean because it is the diagnostic: "this entry was
 * moved because it reads `{{getvar}}`" is actionable — the user can move the
 * variable read into a depth entry, which is `CACHE-PREFIX.md` §3 提案 C's
 * whole point — and "this entry was moved" is not.
 */
export type EntropicFeature = string

/**
 * Features in `text` that make its expansion differ between turns.
 *
 * **Takes pre-expansion text.** By the time a contribution reaches the
 * assembler its `{{roll}}` is already a number, so this must be called where
 * the raw text still exists: the world-info entry's own `content`, the preset
 * prompt's own `content`, the card's `depth_prompt.prompt`, the value a script
 * handed `setExtensionPrompt`.
 * @param text - the text as its author wrote it.
 * @returns the feature names found, empty when none.
 */
export function entropicFeatures(text: string): EntropicFeature[] {
  const found = new Set<EntropicFeature>()
  if (EJS_TEMPLATE.test(text)) found.add('<% %>')
  for (const match of text.matchAll(MACRO_HEAD)) {
    const name = match[1] ?? ''
    const lower = name.toLowerCase()
    if (ENTROPIC.has(lower)) found.add(name)
    else if (LEGACY_TIME_UTC.test(name)) found.add('time')
    // Tavern Helper's `{{format_message_variable::…}}` family, asked of the one
    // module that owns the scope list — MVU's status block is exactly this, and
    // it is the single largest re-sent block measured in the corpus (5 367 B a
    // turn on 爱衣).
    else if (isHelperMacroName(name)) found.add(name)
  }
  return [...found]
}

/**
 * Whether a piece of pre-expansion text is predicted volatile.
 * @param text - the text as its author wrote it.
 * @returns true when it carries at least one entropic feature.
 */
export function isEntropic(text: string): boolean {
  return entropicFeatures(text).length > 0
}

/**
 * What one conversation remembers about its own contributions.
 *
 * Persisted with the chat, so a host restart does not throw away every
 * classification and pay a fresh round of misses discovering them again.
 */
export interface VolatilityRecord {
  /**
   * How many assemblies have been recorded for this chat.
   *
   * Its own counter rather than the chat's turn number, because a regenerate
   * assembles again at the same turn and a `{{roll}}` that moved between two
   * swipes is exactly the evidence wanted.
   */
  generation: number
  /** Content hash per contribution id, as of the last recorded assembly. */
  seen: Record<string, string>
  /** Generation at which each mark lapses. An id absent from here is stable. */
  until: Record<string, number>
  /**
   * Generation at which each id's **current** content was first seen.
   *
   * Kept separately from {@link until} because it answers a different question:
   * `until` says "do not trust this yet", `since` says "how long has this held
   * still". Only the second one can justify moving something *into* the prefix,
   * which costs a miss of its own and must not be done on one observation.
   *
   * Absent for a record written before this field existed — such a record is
   * still perfectly usable for the volatile direction, and the promote
   * direction simply waits for its first observation.
   */
  since?: Record<string, number>
}

/** A conversation that has never assembled. */
export function emptyVolatility(): VolatilityRecord {
  return { generation: 0, seen: {}, until: {}, since: {} }
}

/** What {@link classifyVolatility} returns. */
export interface VolatilityVerdict {
  /** Ids classified volatile for this assembly. */
  volatile: ReadonlySet<string>
  /**
   * Ids whose content has held still long enough to be worth pulling into the
   * prefix — {@link DEFAULT_SETTLE_AFTER} consecutive unchanged observations.
   *
   * Disjoint from {@link volatile} by construction: an id cannot be both, and
   * volatility is always the newer evidence.
   */
  settled: ReadonlySet<string>
  /**
   * The record to store when this assembly is a real turn.
   *
   * Separate from the verdict so a **preview** can see the same classification
   * the next real turn will use without advancing anything. A read that writes
   * is the defect this shape exists to prevent — `prompt.itemize` used to store
   * three menu choices into `chat_metadata.variables` for exactly that reason.
   */
  next: VolatilityRecord
}

/**
 * A stable, short content hash.
 *
 * FNV-1a over UTF-16 units, hex. Not a cryptographic digest — the question is
 * only "did these bytes change", the inputs are not adversarial, and a 32-bit
 * collision costs at worst one section staying in the prefix a turn longer
 * than it should. It has to be **stable across processes**, which rules out
 * anything seeded per run.
 * @param text - the content.
 * @returns eight hex digits.
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Knobs for one classification. */
export interface ClassifyOptions {
  /** Turns a *measured* mark survives without renewal. Defaults to {@link DEFAULT_VOLATILE_HOLD}. */
  hold?: number
  /**
   * Ids whose pre-expansion text carried an entropic feature.
   *
   * Supplied by the caller because only the caller saw the raw text. Applied on
   * **first sight of the id and nowhere else** — from the second sighting the
   * hash is the authority — but it earns the **full hold**, exactly like a
   * measurement.
   *
   * Both halves of that were measured, and each was wrong the other way first:
   *
   * - Giving a prediction the full hold with a **broad** feature list marked 45
   *   of 爱衣's contributions volatile (`main` and 37 preset prompts) and took
   *   its ceiling from 72.2% to 66.7%. Fixed by narrowing the list — see
   *   {@link ENTROPIC_MACROS}, which now carries only macros whose value
   *   provably moves.
   * - Giving a prediction **one** generation instead made the *layout itself*
   *   the volatile thing: assembly 1 moved a section back, assembly 2 (now
   *   holding a hash) did not, and the same conversation state assembled twice
   *   agreed on **0.3%** of its bytes where the control had been 100%. A layout
   *   that flips is worse than either layout.
   *
   * So: predict rarely, and once you have predicted, hold.
   */
  entropic?: ReadonlySet<string>
  /**
   * Ids whose **source** makes them volatile, re-asserted every generation.
   *
   * Not a reading of text: a card script's `setExtensionPrompt` value is
   * computed while the turn is being prepared, so the fact that two turns
   * produced the same string is not evidence the third will. This one *is*
   * renewed on every classification, and so never lapses while the injection is
   * live — which is the intended asymmetry, because such an injection lands
   * ahead of the whole preset (`placementFor`, `main.order - 1`) where a single
   * change costs the entire request.
   */
  runtime?: ReadonlySet<string>
  /**
   * Consecutive unchanged observations before an id counts as settled.
   * Defaults to {@link DEFAULT_SETTLE_AFTER}.
   */
  settleAfter?: number
}

/**
 * Classify this assembly's contributions against what the chat remembers.
 *
 * The three rules, each weighted by the evidence behind it:
 *
 * 1. **Measured** — the content hash differs from the stored one. Volatile, and
 *    the mark holds for `hold` further generations. This outranks everything:
 *    the text demonstrably changed.
 * 2. **Runtime source** — the id is in `options.runtime`. Volatile, renewed
 *    every generation, so it never lapses while the source is live.
 * 3. **Predicted** — first sight of the id *and* it is in `options.entropic`.
 *    Volatile, and it holds like a measurement, because a mark that lapses on
 *    the next assembly makes the layout itself change and costs more than
 *    either layout would (measured: a one-generation prediction dropped a
 *    same-state control from 100% to 0.3%). From the second sighting rule 1 has
 *    real evidence, and a wrongly predicted id returns to the prefix once the
 *    hold runs out.
 *
 * Otherwise the stored mark decides: volatile while `until > generation`.
 *
 * Contributions absent from this assembly keep their stored rows. A world-info
 * entry that did not activate this turn has not become stable — it was not
 * asked.
 * @param record - what the chat remembers, or a fresh one.
 * @param contributions - this assembly's contributions.
 * @param options - hysteresis length, the prediction, and the runtime set.
 * @returns the ids classified volatile, and the record to store on a real turn.
 */
export function classifyVolatility(
  record: VolatilityRecord,
  contributions: readonly Contribution[],
  options: ClassifyOptions = {},
): VolatilityVerdict {
  const hold = options.hold ?? DEFAULT_VOLATILE_HOLD
  const settleAfter = options.settleAfter ?? DEFAULT_SETTLE_AFTER
  const entropic = options.entropic ?? new Set<string>()
  const runtime = options.runtime ?? new Set<string>()
  const generation = record.generation
  const seen = { ...record.seen }
  const until = { ...record.until }
  const since = { ...record.since }
  const volatile = new Set<string>()
  const settled = new Set<string>()

  for (const contribution of contributions) {
    const id = contribution.id
    const hash = contentHash(contribution.text)
    const previous = record.seen[id]
    const changed = previous !== undefined && previous !== hash

    if (changed) {
      // Measured: the full hold, because returning to the prefix costs a miss.
      until[id] = generation + 1 + hold
    } else if (runtime.has(id)) {
      until[id] = generation + 1 + hold
    } else if (previous === undefined && entropic.has(id)) {
      // Predicted, first sight only, and it holds: a mark that lapsed next
      // assembly would move the section back and forth, and a layout that
      // flips is the worst of the three outcomes.
      until[id] = generation + 1 + hold
    }

    // The clock on "how long has this held still" restarts whenever the content
    // does change, starts on first sight, and — the third case, which is a
    // record written by a build that had no `since` at all — starts *now*
    // rather than being treated as having held forever. An id whose clock is
    // simply missing has not been observed holding still; it has not been
    // observed at all.
    if (changed || since[id] === undefined) since[id] = generation
    const heldFor = generation - (since[id] ?? generation)

    if ((until[id] ?? -1) > generation) volatile.add(id)
    else if (heldFor >= settleAfter) settled.add(id)
    seen[id] = hash
  }

  return {
    volatile,
    settled,
    next: { generation: generation + 1, seen, until, since },
  }
}

/**
 * Apply a verdict to the contributions the assembler will be handed.
 *
 * A copy per contribution rather than a mutation: `#contributions` hands the
 * same array to the driver's assembly and to the recorded itemization, and both
 * must see the same flags — but the objects themselves came from the preset
 * resolver and the world-info scan, and writing into them would leak a
 * per-turn verdict into whatever else holds a reference.
 * @param contributions - this assembly's contributions.
 * @param verdict - the classification for this assembly.
 * @returns the same contributions, classified ones flagged.
 */
export function markCachePhase(
  contributions: readonly Contribution[],
  verdict: Pick<VolatilityVerdict, 'volatile' | 'settled'>,
): Contribution[] {
  return contributions.map((contribution) => {
    if (verdict.volatile.has(contribution.id)) return { ...contribution, volatile: true }
    if (verdict.settled.has(contribution.id)) return { ...contribution, settled: true }
    return contribution
  })
}
