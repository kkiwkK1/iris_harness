/**
 * Replacing an early span of the conversation with a summary, at assembly time.
 *
 * **Nothing here deletes a message.** The chat file keeps every floor the user
 * ever wrote or received; what a compaction changes is the conversation the
 * *model* is shown — the leading `count` floors stop being sent verbatim and
 * one framed summary floor stands in their place. That is the same relationship
 * SillyTavern's own Summarize extension has to a chat
 * (`[ST 1.18.0] public/scripts/extensions/memory/index.js:964` —
 * `setMemoryContext` injects through `setExtensionPrompt` and writes the text
 * onto a message; it never touches `context.chat`), so a compacted
 * conversation opened in SillyTavern is a complete conversation.
 *
 * Transcribed from deepseek-harness (MIT),
 * `packages/compaction/compaction-basic/src/{config,region,summarizer}.ts`:
 *
 * - the two ratios and their meaning — `thresholdRatio` `0.8`,
 *   `retainRatio` `0.16` (`config.ts`'s `DEFAULT_THRESHOLD_RATIO` /
 *   `DEFAULT_RETAIN_RATIO`), and the load-bearing validation that retention
 *   must be strictly under the threshold or the policy asks for a compaction
 *   it can never satisfy;
 * - {@link selectCompactableSpan}, from `region.ts`'s `selectCompactableRange`:
 *   accumulate from the newest end until the retained tail is paid for, and
 *   compact everything before that index — head-anchored, so a second
 *   compaction is a longer first one rather than a patchwork;
 * - the shrink guard ({@link SummaryNotSmallerError}), from
 *   `region.ts`'s `summarizeCompaction`: a replacement that is not smaller than
 *   what it replaces is refused, because it would lower nothing and the next
 *   turn would ask again;
 * - {@link frameSummary}, from `summarizer.ts`.
 *
 * What the transcription dropped, and why: the harness walks the chosen
 * boundary backwards until it is *tool-pairing balanced*
 * (`toolPairingBalancedBefore`), so a compaction cannot separate an assistant's
 * tool call from its result. A roleplay log has no such pair — the only
 * structure is user line then reply, and splitting that is what the budget
 * trimmer (`@iris/pipeline`'s `trimHistory`) already does on every long chat.
 * There is nothing to keep balanced, so there is no walk.
 *
 * What the transcription added: the durable record. The harness keeps its
 * compaction in an append-only session log it owns; Iris has to survive being
 * written to a SillyTavern chat file and read back, which is why
 * {@link readCompaction} / {@link writeCompaction} exist and why they are
 * fussy about where they put it — see {@link COMPACTION_FIELD}.
 *
 * @module @iris/app-service/compaction
 */

import type { HistoryEntry } from '@iris/pipeline'
import type { SillyTavernChatHeader } from '@iris/persistence'
import type { ChatCompaction } from '@iris/protocol'

import { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG } from './compaction-prompt.ts'

/**
 * Where the record lives: a **top-level key on the chat header**, beside
 * `iris` and `chat_metadata` rather than inside either.
 *
 * Three homes were available and two of them lose the record silently, which is
 * the worst outcome this feature has: a lost summary means the next request
 * quietly re-includes the whole span, so the conversation gets more expensive
 * and nothing says why.
 *
 * - **Not a message's `extra`**, which is where upstream's Summarize puts its
 *   own text (`memory/index.js:982` — `mes.extra.memory = value`). SillyTavern
 *   treats `extra` as per-swipe state it swaps **wholesale**:
 *   `targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {}` on
 *   every swipe (`public/script.js:6956`). One swipe of that floor in
 *   SillyTavern and the record is gone. `./usage.ts` measured this first and
 *   `iris_usage` sits at the top level for the same reason; this key follows
 *   its naming.
 * - **Not `chat_metadata`**, even though that is upstream's home for
 *   chat-scoped state and `timedWorldInfo` and `variables` already live there.
 *   `./context.ts`'s `commitChatMetadata` **replaces the block wholesale**
 *   ("because that is what upstream's object semantics give a card"), and it is
 *   reachable from the browser as `script.saveMetadata`. Any card that reads
 *   the metadata, sets one key and saves would delete the record. The two
 *   existing residents live under that hazard because upstream put them there
 *   and compatibility is the floor; nothing forces a third.
 * - **Not `header.iris`**, which survives save and open but not a round trip:
 *   `ChatStore.importFile` re-mints that block wholesale
 *   (`./chats.ts` — `chat.header['iris'] = { chatId, characterId, title, updatedAt }`).
 *
 * A sibling top-level header key survives all three: `SillyTavernChatHeader`
 * has an index signature, `formatChatFile` writes the header verbatim,
 * `parseChatFile` reads it verbatim, `importFile` does not touch unknown header
 * keys, and SillyTavern itself ignores header keys it does not know — which is
 * exactly why `iris` is allowed to live there in the first place.
 */
export const COMPACTION_FIELD = 'iris_compaction'

/** Compact at this fraction of the prompt's available budget. The harness's `thresholdRatio`. */
export const DEFAULT_THRESHOLD_RATIO = 0.8

/** Keep this fraction of the budget as verbatim recent conversation. The harness's `retainRatio`. */
export const DEFAULT_RETAIN_RATIO = 0.16

/**
 * Generation cap for one summarization call.
 *
 * The harness's default (`config.ts`'s `maxTokens: 8192`), kept rather than
 * tuned down: it is a **cap, not a target**, and the bound that actually
 * matters is {@link SummaryNotSmallerError} — a summary is refused for being
 * too long relative to what it replaces, which is the only measure of "too
 * long" that means anything here. A smaller cap would trade a refusal a reader
 * can act on for a truncated checkpoint nothing downstream can detect.
 */
export const SUMMARY_MAX_TOKENS = 8192

/** A replacement that would not lower the next request's cost. */
export class SummaryNotSmallerError extends Error {
  /** What the framed replacement costs. */
  readonly summaryTokens: number
  /** What the span it would replace costs. */
  readonly spanTokens: number

  /**
   * @param summaryTokens - what the framed replacement costs.
   * @param spanTokens - what the span it would replace costs.
   */
  constructor(summaryTokens: number, spanTokens: number) {
    super(
      `the summary is not smaller than the history it would replace (${String(summaryTokens)} `
      + `estimated tokens >= ${String(spanTokens)})`,
    )
    this.name = 'SummaryNotSmallerError'
    this.summaryTokens = summaryTokens
    this.spanTokens = spanTokens
  }
}

/**
 * Whether a value reads as one stored compaction record.
 *
 * Structural rather than exact, the same way `entry.ts`'s
 * `isStoredTimedEffect` is: a malformed record must degrade to "this chat has
 * no compaction" and re-send the whole history, never poison the boundary
 * arithmetic. A `count` of `"12"` would slice nothing and drop nothing while
 * looking like a live record.
 * @param value - the candidate read off the header.
 * @returns true when every field the substitution does arithmetic on is usable.
 */
function isStoredCompaction(value: unknown): value is ChatCompaction {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row['count'] === 'number'
    && Number.isInteger(row['count'])
    && row['count'] > 0
    && typeof row['summary'] === 'string'
    && row['summary'].trim().length > 0
    && typeof row['spanTokens'] === 'number'
    && typeof row['summaryTokens'] === 'number'
    && typeof row['at'] === 'number'
    && typeof row['model'] === 'string'
}

/**
 * Read the compaction record out of a chat header.
 * @param header - the chat file's first line, as parsed.
 * @returns the record, or undefined when there is none or it is unusable.
 */
export function readCompaction(header: SillyTavernChatHeader): ChatCompaction | undefined {
  const stored = header[COMPACTION_FIELD]
  if (!isStoredCompaction(stored)) return undefined
  return { ...stored }
}

/**
 * Write the compaction record into a chat header, in place.
 *
 * The next `chats.save(entry)` puts it on disk; the header is not rebuilt by
 * `ChatEntry.rebuild`, so an edit or a deletion elsewhere in the conversation
 * cannot take it with them.
 * @param header - the chat header, mutated in place.
 * @param record - the record to store.
 */
export function writeCompaction(header: SillyTavernChatHeader, record: ChatCompaction): void {
  header[COMPACTION_FIELD] = { ...record }
}

/**
 * Wrap a summary in the framing that makes it established context.
 *
 * Transcribed from the harness's `frameSummary`: preamble, open tag, the
 * model's own text, close tag. The tags are what let the *next* compaction
 * recognise a prior checkpoint and merge it instead of quoting it — see
 * `./compaction-prompt.ts`'s last rule.
 * @param summary - the model's summary text.
 * @returns the text of the replacement floor.
 */
export function frameSummary(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary.trim()}\n${SUMMARY_CLOSE_TAG}`
}

/**
 * The floor that stands in for the compacted span.
 *
 * `role: 'system'`, because it is the host speaking about the conversation
 * rather than either party in it — which is also the role upstream's Summarize
 * injects its own text under (`memory/index.js:115`,
 * `role: extension_prompt_roles.SYSTEM`).
 *
 * `pinned: true`, because the budget trimmer drops from the oldest end and this
 * entry *is* the oldest end. An unpinned summary would be the first thing
 * dropped on the very request its existence is meant to make fit.
 * @param record - the stored record.
 * @returns one history entry.
 */
export function summaryEntry(record: ChatCompaction): HistoryEntry {
  return { role: 'system', text: frameSummary(record.summary), pinned: true }
}

/**
 * Substitute the summary for the span it stands for.
 *
 * **Clamped, and that clamp is a decision.** `count` is a number of leading
 * floors, and a user who deletes one of them leaves it one too large. Rather
 * than trust it, this keeps at least one verbatim floor: a record that has gone
 * stale then costs the reader one over-compacted turn, where an unclamped slice
 * would hand the model a conversation with no present in it.
 * @param history - the full projected history, oldest first.
 * @param record - the record, or undefined for no compaction.
 * @returns the conversation the model should see.
 */
export function applyCompaction(
  history: readonly HistoryEntry[],
  record: ChatCompaction | undefined,
): HistoryEntry[] {
  if (record === undefined || history.length === 0) return [...history]
  const covered = Math.min(record.count, history.length - 1)
  if (covered <= 0) return [...history]
  return [summaryEntry(record), ...history.slice(covered)]
}

/** One model's concrete pressure and retention budget, in tokens. */
export interface CompactionSpec {
  /** Compact once an assembled request is estimated at or above this. */
  thresholdTokens: number
  /** Keep at least this much recent conversation verbatim. */
  retainTokens: number
}

/**
 * Scale the two ratios onto one chat's budget.
 *
 * **Against `context - reserve`, not against the window**, which is the one
 * deliberate departure from the harness's arithmetic. The harness has no
 * separate reply allowance in this formula; Iris's assembler does
 * (`@iris/pipeline`'s `assemble` spends `context - reserve - fixed` on
 * history), so a threshold measured against the whole window would sit *above*
 * the point at which the trimmer starts silently dropping floors whenever the
 * reserve exceeds a fifth of the window — and dropping a floor is precisely the
 * outcome compaction exists to replace. Dividing by the same figure
 * `itemization.ts`'s `budgetUse` calls "available" also means the meter's
 * percentage and this trigger cannot disagree about what full means.
 * @param available - `context - reserve` for this chat.
 * @returns the two budgets, or null when the available budget is too small for
 * the policy to be satisfiable at all.
 */
export function compactionSpec(available: number): CompactionSpec | null {
  if (!Number.isFinite(available) || available <= 0) return null
  const thresholdTokens = Math.floor(available * DEFAULT_THRESHOLD_RATIO)
  const retainTokens = Math.floor(available * DEFAULT_RETAIN_RATIO)
  // The harness validates this at plugin load (`validateRatioRetention`);
  // here the ratios are constants, so the only way it can fail is a budget so
  // small that flooring collapses the two together — at which point there is no
  // compaction that both fires and leaves a tail, and saying so beats
  // compacting into nothing.
  if (retainTokens >= thresholdTokens) return null
  return { thresholdTokens, retainTokens }
}

/**
 * Choose how much of the head to compact.
 *
 * Transcribed from the harness's `selectCompactableRange`: walk from the newest
 * end, accumulating each entry's cost, and stop as soon as the retained tail is
 * paid for. Everything before that index is the span. Head-anchored on purpose
 * — a second compaction extends the first rather than leaving a summarised
 * middle between two verbatim stretches.
 *
 * `retainTokens: 0` is the manual case and behaves exactly as it does upstream
 * in the harness: the loop pays for the newest entry on its first iteration and
 * stops, so everything except the last floor is compacted.
 * @param history - the conversation as the model currently sees it (a summary
 * from an earlier compaction included, as its first entry).
 * @param retainTokens - the verbatim tail budget.
 * @param count - the token counter.
 * @returns how many leading entries to compact, or null when there is nothing
 * that can be compacted without emptying the conversation.
 */
export function selectCompactableSpan(
  history: readonly HistoryEntry[],
  retainTokens: number,
  count: (text: string) => number,
): number | null {
  if (history.length < 2) return null
  let accumulated = 0
  let keepFrom = history.length
  for (let index = history.length - 1; index >= 0; index -= 1) {
    accumulated += count((history[index] as HistoryEntry).text)
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  if (keepFrom <= 0) return null
  return keepFrom
}

/**
 * What one stretch of conversation is estimated to cost.
 * @param history - the entries.
 * @param count - the token counter.
 * @returns the sum.
 */
export function historyTokens(
  history: readonly HistoryEntry[],
  count: (text: string) => number,
): number {
  return history.reduce((total, entry) => total + count(entry.text), 0)
}

/**
 * Convert a span chosen in *effective* coordinates back to raw floors.
 *
 * The selection runs over the conversation the model currently sees, whose
 * first entry may be an earlier summary standing for `previous.count` real
 * floors. Compacting `keepFrom` effective entries therefore covers
 * `previous.count + (keepFrom - 1)` raw floors when a summary was present, and
 * `keepFrom` when it was not.
 *
 * Named and tested separately because getting it wrong is invisible: the
 * conversation still reads correctly, the record just claims the wrong span and
 * the next compaction compounds it.
 * @param keepFrom - the effective index the span ends before.
 * @param previous - the record the effective history was built with.
 * @returns how many raw leading floors the new summary stands for.
 */
export function rawCoverage(keepFrom: number, previous: ChatCompaction | undefined): number {
  return previous === undefined ? keepFrom : previous.count + keepFrom - 1
}
