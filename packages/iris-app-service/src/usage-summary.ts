/**
 * What the whole profile has cost, cut by time and by model.
 *
 * `./usage.ts` is the storage half — one record per generation, in the chat
 * file. This is the reading half, and it exists because the question a user
 * actually asks ("what is this costing me, and which model is it") cannot be
 * answered by any one conversation. It has to be answered across all of them.
 *
 * **Why the host does the arithmetic.** The browser could ask `chat.list` and
 * then `chat.open` each conversation, and that is wrong twice over: it ships
 * every floor of every conversation across the wire in order to compute a dozen
 * sums, and `chat.open` is a *stateful* call on this host — it loads the entry,
 * composes the card's scripts, and can raise the legacy-cleanup offer. Reading
 * a statistic must not have side effects. So this scans the files directly, the
 * way `ChatStore.search` does, with the same discipline: one substring check per
 * line, and `JSON.parse` only on the lines the check flags.
 *
 * **The two absences this module is mostly about.** Every usage record written
 * before `TurnUsage.model` and `TurnUsage.at` existed has neither — measured on
 * the 16 real conversations on this machine: 12 usage records, every one of them
 * carrying only the five token buckets (seven of them without even a
 * fingerprint). Those tokens were spent, so they are counted; what they are not
 * is *known*, and this module keeps the two apart. An unknown model is its own
 * series rather than being folded into a neighbour or dropped, and an undated
 * record is placed at its conversation's own last-activity time and **counted
 * in `undatedTurns`**, so a reader can see how much of a time-sliced chart is a
 * reconstruction rather than a reading.
 *
 * **Three populations.** A conversation's cost is not only its turns. A card's
 * own `TavernHelper.generate` / `generateRaw` and this host's own compaction
 * summary are billed on the same route to the same account and produce no
 * reply, so they are stored on the chat header (`./side-usage.ts`) rather than
 * on a message. All three are counted here, and the two side shares are
 * reported as `UsageTotals.script` and `UsageTotals.compaction` — because a
 * total that left them out was about a population narrower than the user's
 * bill, and one that folded them in silently would leave a reader unable to
 * explain why the figure is larger than the replies they can see.
 *
 * @module @iris/app-service/usage-summary
 */

import type { SillyTavernChatHeader, SillyTavernMessage } from '@iris/persistence'
import type {
  TurnUsage, UsageBucket, UsageBuckets, UsageChat, UsageGranularity, UsageSummary, UsageTotals,
} from '@iris/protocol'

import { readMeta } from './entry.ts'
import { readSideUsage } from './side-usage.ts'
import { parseUsage, USAGE_FIELD, usageFieldOf } from './usage.ts'

/**
 * One generation's cost, already placed in time and attributed to a model.
 *
 * The `at` here is **resolved**, not raw: a record that carried its own moment
 * keeps it, and one that did not has been given its conversation's. Which of
 * the two happened is on `undated`, and it is a field rather than a flag
 * computed later because the two cannot be told apart once they are added up —
 * a resolved time looks exactly like a recorded one.
 */
export interface DatedUsage {
  /** The moment this generation is counted at. */
  at: number
  /** Whether {@link at} was reconstructed from the conversation instead of read from the record. */
  undated: boolean
  /** The model, absent when the record does not name one. */
  model?: string
  /** The token buckets. */
  usage: TurnUsage
}

/** One conversation's usage records, plus the facts a subtotal row shows. */
export interface ChatUsage {
  chatId: string
  title: string
  characterId?: string
  updatedAt: number
  records: DatedUsage[]
}

/** How the caller narrows a summary. */
export interface UsageSummaryOptions {
  /** Earliest moment counted, inclusive. */
  since?: number
  /** Latest moment counted, exclusive. */
  until?: number
  /** Default `'day'`. */
  granularity?: UsageGranularity
}

/**
 * The start of the bucket a moment falls in.
 *
 * **Local boundaries.** A reader's "today" is their own midnight, not UTC's,
 * and the same reasoning `parseCreateDate` writes down for reading a chat's
 * `create_date` back applies here: a figure written and read in one zone is
 * stable, and one written in UTC and read locally shifts every summary by the
 * offset. The consequence, stated because it is real: a day bucket spanning a
 * DST change is 23 or 25 hours long, which is the correct answer to "what did I
 * spend on Sunday" and the wrong one to "per 24 hours". This chart is asked the
 * first question.
 * @param at - the moment, Unix epoch milliseconds.
 * @param granularity - day or hour.
 * @returns the bucket's start, Unix epoch milliseconds.
 */
export function bucketStart(at: number, granularity: UsageGranularity): number {
  const when = new Date(at)
  if (granularity === 'hour') when.setMinutes(0, 0, 0)
  else when.setHours(0, 0, 0, 0)
  return when.getTime()
}

/** An empty bucket set; the optional buckets stay absent until one is reported. */
function emptyBuckets(): UsageBuckets {
  return { cacheMiss: 0, output: 0, turns: 0, cacheTurns: 0, cachePrompt: 0 }
}

/**
 * An empty accumulator.
 *
 * `script` is **absent** here rather than an empty bucket set, and stays absent
 * unless a script-sourced record is folded in: the protocol reads its absence
 * as "no card generation was counted in this range", which is a different
 * statement from a row of zeros — and the same rule `summariseUsage` already
 * follows when it refuses to emit a conversation subtotal of zeros.
 * @returns the accumulator.
 */
function emptyTotals(): UsageTotals {
  return { ...emptyBuckets(), undatedTurns: 0 }
}

/**
 * Fold one generation into an accumulator.
 *
 * `sumUsage`'s rule, one layer out: the two required buckets add plainly, and
 * an optional one is added **only over the generations that reported it** and
 * stays absent when none did. That is what makes the hit rate a fact — see
 * `cacheTurns` and `cachePrompt`, which restrict the share's numerator and
 * denominator to the same population, so a route that never mentions caching
 * cannot dilute one that does.
 *
 * `reasoning` is added but never added *into* `output`: the provider reports it
 * as the reasoning share of the completion it is already inside, and adding it
 * would bill the same tokens twice.
 *
 * **A generation that is not a turn is folded in twice: into the whole, and
 * into its own share.** Into the whole because it was billed to the same
 * account on the same route, so a total that left it out would be a total of
 * something other than the bill; into `script` or `compaction` so a surface can
 * say how much of the figure it is. The shares are not parallel populations to
 * be added — each is a subset of the enclosing figure, and a reader wanting the
 * turn share subtracts both.
 *
 * Two shares rather than one merged "not a turn" figure, for the reason
 * `UsageTotals.compaction` gives: a card's spend is the card author's doing and
 * a compaction's is this host's own policy, so a reader who wants less of one
 * acts somewhere different from a reader who wants less of the other.
 * @param into - the accumulator, mutated.
 * @param record - one generation.
 */
export function addUsage(into: UsageTotals, record: DatedUsage): void {
  foldBuckets(into, record.usage)
  if (record.undated) into.undatedTurns += 1
  const source = record.usage.source
  if (source !== 'script' && source !== 'compaction') return
  // Keyed by the source rather than branched per share. The field name and the
  // source spelling are the same word by construction, so a third side source
  // folds by widening the guard above rather than by someone remembering to
  // copy an arm — and a forgotten arm here does not fail, it reports a share of
  // zero, which reads as "this profile does not do that" on every page.
  const share = into[source] ?? emptyBuckets()
  into[source] = share
  foldBuckets(share, record.usage)
}

/**
 * Fold one generation's buckets into one bucket set.
 *
 * Separate from {@link addUsage} because it runs twice for a script record and
 * once for a turn's, and the two facts that are about the *reading* rather than
 * the spend — `undatedTurns`, and the `script` subset itself — must not be
 * folded twice or nested.
 * @param into - the bucket set, mutated.
 * @param usage - one generation's cost.
 */
function foldBuckets(into: UsageBuckets, usage: TurnUsage): void {
  into.turns += 1
  into.cacheMiss += countable(usage.inputTokens)
  into.output += countable(usage.outputTokens)
  if (usage.cacheWriteTokens !== undefined) {
    into.cacheWrite = (into.cacheWrite ?? 0) + countable(usage.cacheWriteTokens)
  }
  if (usage.reasoningTokens !== undefined) {
    into.reasoning = (into.reasoning ?? 0) + countable(usage.reasoningTokens)
  }
  if (usage.cacheReadTokens === undefined) return
  // The cache-reporting population. A generation enters it on the presence of
  // `cacheReadTokens` — the field the *hit* is read from — so the denominator
  // below covers exactly the generations whose numerator is known.
  into.cacheRead = (into.cacheRead ?? 0) + countable(usage.cacheReadTokens)
  into.cacheTurns += 1
  into.cachePrompt += countable(usage.inputTokens)
    + countable(usage.cacheReadTokens)
    + countable(usage.cacheWriteTokens ?? 0)
}

/**
 * A token count fit to be added.
 *
 * The counts came from a provider over the wire and then through a JSON file, so
 * a fractional, negative or non-finite value is reachable. `parseUsage` has
 * already refused the non-numbers; this refuses the rest, because one `NaN`
 * reaching a sum turns every figure downstream of it into `NaN` — a whole
 * summary of blanks, from one bad entry, with nothing naming which.
 * @param value - the reported count.
 * @returns a non-negative safe integer.
 */
function countable(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/**
 * Read one chat file's usage records, without loading the conversation.
 *
 * `ChatStore.search`'s discipline: the cheap check first. A line that does not
 * contain the {@link USAGE_FIELD} key cannot carry a usage record, so it is
 * skipped before `JSON.parse` is ever paid for — which is what keeps this
 * proportional to bytes rather than to floors on a 19 MiB conversation where
 * every floor is long and only a handful were billed.
 *
 * **The undated fallback is named here, once.** A record with no `at` is placed
 * at the conversation's own `updatedAt`, and where the header carries none at
 * `create_date`. That is a *reconstruction*: every undated record in a chat
 * lands in one bucket, so an old conversation shows as a single spike at its
 * last activity rather than as the sessions it really was. It is reported as
 * such (`undatedTurns`) rather than smoothed, because smoothing would invent a
 * distribution the file does not contain.
 *
 * **Three populations, two locations.** The turns are on the message lines; a
 * card's own generations and this host's compaction summaries are on the
 * **header**, because none of them produced a candidate to hang off
 * (`./side-usage.ts`). Both locations are read here, and between them they
 * decide whether a record is a turn: a per-message array is by construction a
 * candidate's and the header array is by construction not, so neither can be
 * talked out of its column by a `source` a file from elsewhere wrote. *Which*
 * side source a header record is comes from its own field — one location holds
 * two askers, so the location cannot say — and `parseSideUsage` refuses
 * anything but a side source there. Records written before generations were
 * recorded at all carry no `source` and are turns, which is what they are.
 * @param chatId - the file's stem, which is the conversation's id.
 * @param text - the whole file.
 * @returns the conversation's records, or undefined when the file is not a chat.
 */
export function readChatUsage(chatId: string, text: string): ChatUsage | undefined {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const first = lines[0]
  if (first === undefined) return undefined

  let header: SillyTavernChatHeader
  try {
    header = JSON.parse(first) as SillyTavernChatHeader
  } catch {
    return undefined
  }
  const meta = readMeta(header)
  // `readMeta` reports 0 for a header with no Iris block; the file's own
  // user-facing date is the next best moment, and 0 the last resort — a record
  // at the epoch still counts in an unbounded summary and simply falls outside
  // every dated range, which is the honest outcome for a record with no time.
  const fallback = meta.updatedAt > 0
    ? meta.updatedAt
    : parseHeaderDate(header) ?? 0

  const records: DatedUsage[] = []
  // The header's own records first, because they are already in hand — the
  // header was parsed above for the title and the fallback moment, so reading
  // them costs no second parse. Order inside a conversation is not a reading:
  // `summariseUsage` places every record by its own moment.
  for (const side of readSideUsage(header)) {
    const at = side.usage.at
    records.push({
      at: at ?? fallback,
      undated: at === undefined,
      ...side.usage.model === undefined ? {} : { model: side.usage.model },
      usage: side.usage,
    })
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.includes(USAGE_FIELD)) continue
    let floor: SillyTavernMessage
    try {
      floor = JSON.parse(line) as SillyTavernMessage
    } catch {
      continue
    }
    // A user line shares its turn number with the reply after it and could not
    // have been billed; `toFile` never writes the field there, so a field found
    // on one is a file from somewhere else and is not read.
    if (floor.is_user === true) continue
    for (const entry of usageFieldOf(floor)) {
      const usage = parseUsage(entry)
      // The ordinary case is `null`: that swipe was generated and its provider
      // reported nothing. Nothing to count and nothing to report.
      if (usage === undefined) continue
      const at = usage.at
      // No `source`, which reads as `'turn'`. `parseUsage` does not carry the
      // field at all, so a `source: 'script'` written onto a message line by
      // something else cannot claim to be a card's spend from a location that
      // is by construction a candidate's.
      records.push({
        at: at ?? fallback,
        undated: at === undefined,
        ...usage.model === undefined ? {} : { model: usage.model },
        usage,
      })
    }
  }

  return {
    chatId,
    title: meta.title,
    ...meta.characterId === undefined ? {} : { characterId: meta.characterId },
    updatedAt: meta.updatedAt > 0 ? meta.updatedAt : fallback,
    records,
  }
}

/**
 * A header's `create_date`, as a moment.
 *
 * Not `parseCreateDate` from `./chats.ts`, for two reasons — one structural,
 * one a defect that reader has.
 *
 * Structural: that module pulls in the whole store, and this one is imported by
 * the pure summariser its tests exercise.
 *
 * **The defect: `parseCreateDate` cannot read the headers Iris itself writes.**
 * Its regex requires a trailing `ms` (`(\d{3})?ms`), while `formatCreateDate`
 * in the same file ends the string at the seconds — `2026-08-31 @21h04m17s`,
 * which is that function's own documented example. So it answers `undefined`
 * for every header this host has ever written, and its test only ever tried the
 * SillyTavern spelling (`…21s771ms`), which is why nothing said so. Measured
 * over the 16 real conversations on this machine, 2026-09-08: 16 of 16 headers
 * are the no-`ms` form, and 16 of 16 fail that regex.
 *
 * This reader accepts **both** spellings, milliseconds optional, because the
 * files it has to read are real ones. That is a deliberate divergence rather
 * than a quiet loosening, and `parseCreateDate` is left alone: its one caller
 * is the import path, where an unparseable date falls back to the arrival time,
 * so changing it moves how imported conversations sort — another feature's
 * decision to take.
 * @param header - the chat file's first line, parsed.
 * @returns the moment, or undefined when the field is absent or unreadable.
 */
function parseHeaderDate(header: SillyTavernChatHeader): number | undefined {
  const raw = header.create_date
  if (typeof raw !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2}) @(\d{2})h(\d{2})m(\d{2})s(?:(\d{3})ms)?$/u.exec(raw.trim())
  if (match === null) return undefined
  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(part => Number(part))
  const moment = new Date(
    // `Number(undefined)` is `NaN`, which the absent-milliseconds case now
    // reaches on every Iris-written header — so it is coalesced, not defaulted
    // with `??`, which `NaN` passes straight through.
    year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0,
    Number.isFinite(ms) ? ms as number : 0,
  )
  return Number.isNaN(moment.getTime()) ? undefined : moment.getTime()
}

/**
 * The summary, from scanned conversations.
 *
 * Pure: every file read happens in the caller, so the arithmetic that a reader
 * is going to trust can be tested against records written by hand rather than
 * against a corpus assembled by the same belief as the code.
 *
 * **The range filter runs before the fold**, on each record's resolved moment.
 * A record excluded by the range is absent from the totals, from its model's
 * line and from its conversation's subtotal alike — the three figures on the
 * page are the same reading of the same set, which is what lets a reader add up
 * the subtotals and land on the header card.
 * @param chats - one entry per conversation scanned, in the order they should be listed.
 * @param options - range and granularity.
 * @param scanned - how many conversations were read; defaults to `chats.length`.
 * @param skipped - how many could not be read at all.
 * @returns the summary.
 */
export function summariseUsage(
  chats: readonly ChatUsage[],
  options: UsageSummaryOptions = {},
  scanned: number = chats.length,
  skipped = 0,
): UsageSummary {
  const granularity = options.granularity ?? 'day'
  const since = options.since
  const until = options.until

  const cells = new Map<string, UsageBucket>()
  const chatRows: UsageChat[] = []
  const models = new Set<string>()
  const totals = emptyTotals()

  for (const chat of chats) {
    const perChat = emptyTotals()
    for (const record of chat.records) {
      if (since !== undefined && record.at < since) continue
      if (until !== undefined && record.at >= until) continue
      const bucket = bucketStart(record.at, granularity)
      // The cell key is JSON rather than a joined string, so no separator or
      // sentinel character is needed: `null` and `""` are distinct JSON
      // values, which is what keeps a model literally named after the empty
      // string from merging with the records that name no model at all. The
      // first version of this line used a leading-space sentinel and shipped a
      // raw NUL byte instead - caught by `no-control-chars.test.ts`, invisible
      // to the typechecker and to every other test.
      const key = JSON.stringify([bucket, record.model ?? null])
      let cell = cells.get(key)
      if (cell === undefined) {
        cell = {
          bucket,
          ...record.model === undefined ? {} : { model: record.model },
          ...emptyTotals(),
        }
        cells.set(key, cell)
      }
      if (record.model !== undefined) models.add(record.model)
      addUsage(cell, record)
      addUsage(perChat, record)
      addUsage(totals, record)
    }
    // A conversation with nothing in range is not a row of zeros. A zero row
    // reads as "this chat cost nothing", which is a different claim from "this
    // chat spent nothing in the week you are looking at".
    if (perChat.turns > 0) {
      chatRows.push({
        chatId: chat.chatId,
        title: chat.title,
        ...chat.characterId === undefined ? {} : { characterId: chat.characterId },
        updatedAt: chat.updatedAt,
        ...perChat,
      })
    }
  }

  const buckets = [...cells.values()].sort((left, right) =>
    left.bucket - right.bucket
    || (left.model ?? '').localeCompare(right.model ?? '')
    // An absent model sorts after a present one of the same (empty) name, so
    // the order is total and the reply is byte-identical between two calls.
    || Number(left.model === undefined) - Number(right.model === undefined))

  return {
    buckets,
    chats: chatRows.sort((left, right) => right.updatedAt - left.updatedAt),
    models: [...models].sort((left, right) => left.localeCompare(right)),
    totals,
    granularity,
    scannedChats: scanned,
    skippedChats: skipped,
  }
}
