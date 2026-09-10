/**
 * The fake's internal log, and its projection to protocol views.
 *
 * Shaped after the real thing on purpose: every generated candidate is kept
 * and a surface index decides which one is visible. If the fake threw away
 * losing candidates, UI written against it would quietly assume a swipe is a
 * re-fetch, and that assumption would break the day the real host arrives.
 *
 * @module @iris/client-fake/state
 */

import type {
  ChatCompaction,
  ChatSummary,
  ChatView,
  GenerationSettings,
  MessageView,
  TurnGeneration,
  TurnUsage,
  UsageBucket,
  UsageBuckets,
  UsageChat,
  UsageGranularity,
  UsageSummary,
  UsageTotals,
  ViewRole,
} from '@iris/protocol'

import { FAKE_CHAT_BUDGET, FAKE_MEASURED_TOKENS } from './prompt.ts'

/** One alternate reading of a message. */
export interface Candidate {
  text: string
  reasoning?: string
  /**
   * What generating this reading cost, when there was a provider to say.
   *
   * Per candidate rather than per message, because that is where the host
   * keeps it: a turn's swipes are separate generations that were each paid
   * for. Absent on a reading that came from an import, or from an endpoint
   * that reports no usage — which is most of them, so the interface must
   * render that absence as *nothing* rather than as zeros.
   */
  usage?: TurnUsage
  /**
   * How long generating this reading took, when the host measured it.
   *
   * Per candidate for the same reason the cost is, and absent under the same
   * rule with one more case: the host stores this in SillyTavern's own
   * `gen_started` / `gen_finished` pair, which is **one slot per line**, so
   * after a reload only the reading the file was showing still has a timer.
   * The interface therefore has to survive a turn whose swipe 0 has a speed and
   * whose swipe 1 has none, and the seeded conversations put it in that state.
   */
  generation?: TurnGeneration
}

/** A message in the fake log, with every candidate it ever produced. */
export interface FakeMessage {
  role: ViewRole
  /** Speaker name, shown in the margin rather than derived from the role. */
  name: string
  /** Every reading. Non-assistant messages hold exactly one. */
  candidates: Candidate[]
  /** Which candidate the surface shows. */
  index: number
  /**
   * The turn this message belongs to. Both halves of an exchange share it,
   * because `chat.swipe` and `chat.regenerate` address a turn, not an index.
   */
  turn: number
}

/** One conversation in the fake store. */
export interface FakeChat {
  chatId: string
  title: string
  characterId?: string
  messages: FakeMessage[]
  /** Unix epoch milliseconds of the last activity. */
  updatedAt: number
  settings: GenerationSettings
  /**
   * The fields **this conversation** overrides, apart from the merged read.
   *
   * The fake keeps `settings` as a whole copy because that is how it was
   * seeded, so the merged value on its own cannot say whether a field is the
   * conversation's choice or the global default showing through — and an
   * interface that offers to *undo* the choice needs the difference. Tracked
   * rather than reconstructed by diffing against the global layer: two layers
   * carrying the same string is a real state, and a diff would report it as
   * "not overridden".
   *
   * Absent on a seeded chat, which is what "this conversation has decided
   * nothing of its own" looks like.
   */
  settingsOverride?: Partial<GenerationSettings>
  /** Per-chat variables, so a status-bar surface has something to render. */
  variables: Record<string, unknown>
  /**
   * The compaction this conversation has had, once `chat.compact` has run.
   *
   * Absent on a seeded chat: the interesting states are both before and after,
   * and a fixture that arrived pre-compacted would leave the "no compaction
   * yet" surface untested.
   */
  compaction?: ChatCompaction
  /**
   * What this conversation has spent on generations that are **not turns**:
   * its card scripts, and the host's own compaction summaries.
   *
   * A flat list rather than something hanging off a message, because that is
   * the shape of the fact and the shape the host stores: neither a card's
   * `TavernHelper.generate` nor a compaction summary produces a reply, so
   * neither belongs to a message or to a swipe of one — the host keeps them all
   * on the chat header (`@iris/app-service`'s `SIDE_USAGE_FIELD`). Every entry
   * carries `source: 'script'` or `source: 'compaction'`, which is what a
   * summary splits on, and one array holding both is the host's own shape
   * rather than a convenience here.
   *
   * Absent on a conversation with neither, which is most of them: the
   * interesting states are both, and a fixture where every chat had a side
   * share would leave the blank column untested.
   */
  sideUsage?: TurnUsage[]
}

/**
 * Read a message's visible candidate.
 *
 * Total rather than optional: `noUncheckedIndexedAccess` makes every candidate
 * read a branch otherwise, and a message with no candidates is a bug in the
 * fake, not a state the UI should have to render.
 * @param message - the message.
 * @returns the selected candidate, or an empty one if the message has none.
 */
export function selected(message: FakeMessage): Candidate {
  return message.candidates[message.index] ?? { text: '' }
}

/**
 * Project one message to its wire view.
 *
 * `swipes` is attached to assistant messages only, and a count of 1 is still
 * reported: the UI offers regeneration at one candidate and left/right only
 * past that, so it needs to tell "no alternates yet" from "not an assistant
 * message at all".
 * @param message - the log entry.
 * @param id - its position in the conversation.
 * @param streaming - whether this message is the one currently filling in.
 * @returns the view.
 */
export function toMessageView(message: FakeMessage, id: number, streaming: boolean): MessageView {
  const candidate = selected(message)
  return {
    id,
    // Mirrors the host's scheme so the interface cannot come to depend on a
    // shape only the fake produces: user rows key off position, assistant rows
    // off the turn, and a streaming row shares its settled row's key.
    //
    // No consumer may depend on this shape, and the host's is different on
    // purpose. It was briefly copied into the browser's synthesized streaming
    // row, which then matched the fake and never the host — so every real reply
    // remounted the moment it settled, while every test against the fake
    // passed. Identity now travels on `stream.start`; nothing reconstructs it.
    key: message.role === 'assistant' ? `a${message.turn}` : `u${id}`,
    role: message.role,
    name: message.name,
    text: candidate.text,
    turn: message.turn,
    ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning }),
    ...(message.role === 'assistant'
      ? { swipes: { count: message.candidates.length, index: message.index } }
      : {}),
    // The selected reading's own bill, and never while it is streaming: the
    // host does not project a cost onto a row whose reply has not settled, so
    // a fake that did would teach the interface to render a state that cannot
    // occur against the real thing.
    ...(candidate.usage === undefined || streaming ? {} : { usage: candidate.usage }),
    // The same gate on the same boundary: a duration that grew while the reply
    // arrived would make a rate that starts absurd and settles, and the host
    // projects none onto a streaming row (`@iris/app-service`'s `PendingTurn`).
    ...(candidate.generation === undefined || streaming ? {} : { generation: candidate.generation }),
    ...(streaming ? { streaming: true } : {}),
  }
}

/**
 * The rate the fake pretends to decode at, tokens per second.
 *
 * A number in the band a real hosted model streams at rather than a round one,
 * so the formatter's two branches (one decimal at or above ten, two below) are
 * both exercised by a rate that came out of arithmetic instead of a constant
 * someone chose to hit them.
 */
const FAKE_DECODE_RATE = 37.5

/** What the fake's provider makes a reader wait before the first token, ms. */
const FAKE_FIRST_TOKEN_MS = 460

/**
 * Invent a plausible stopwatch for a settled generation.
 *
 * Arithmetically self-consistent, exactly like the costs beside it: the wait
 * before the first token is fixed, the decode takes as long as the tokens
 * warrant at {@link FAKE_DECODE_RATE}, and the reasoning — when there was any
 * — ends part-way through, so a surface has all three of "how long", "how long
 * to the first word" and "how long thinking" and they add up in the order they
 * happened.
 *
 * **Not measured.** The fake streams on timers a test can set to zero delay
 * (`#beginTurn` says why), so a real reading would be `0ms` under test and a
 * rate of infinity. What the interface needs from the fake is figures that
 * *move with the reply* and stay in a believable band; the host is where the
 * clock is.
 *
 * The three durations share their origin, which is the protocol's contract for
 * `TurnGeneration`: `reasoningMs` **contains** `firstTokenMs`, because upstream
 * starts its "Time to think" clock at the generation's start rather than at the
 * first reasoning token.
 * @param outputTokens - what the generation produced, reasoning included.
 * @param reasoningTokens - the reasoning share, or `undefined` for a model that
 *   emitted none.
 * @param finishedAt - the moment the reply landed, Unix epoch milliseconds.
 * @returns the timing, with `startedAt` a whole generation before `finishedAt`.
 */
export function generationTimingFor(
  outputTokens: number,
  reasoningTokens: number | undefined,
  finishedAt: number,
): TurnGeneration {
  const decodeMs = Math.max(1, Math.round(outputTokens * 1_000 / FAKE_DECODE_RATE))
  const durationMs = FAKE_FIRST_TOKEN_MS + decodeMs
  return {
    startedAt: finishedAt - durationMs,
    durationMs,
    firstTokenMs: FAKE_FIRST_TOKEN_MS,
    // Absent, never zero, on a model that did not reason — the protocol's rule,
    // and the difference between "no thinking block" and "thought instantly".
    ...reasoningTokens === undefined
      ? {}
      : { reasoningMs: FAKE_FIRST_TOKEN_MS + Math.round(reasoningTokens * 1_000 / FAKE_DECODE_RATE) },
  }
}

/** The optional buckets, in the order the protocol type lists them. */
const OPTIONAL_BUCKETS = ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/**
 * Add up what several generations cost, by the protocol's rule.
 *
 * A second implementation of `@iris/app-service`'s `sumUsage`, and deliberately
 * so: this package's only dependency is `@iris/protocol` — that is what lets
 * the interface be built and tested with no host at all — so the alternative
 * is not sharing the function, it is the fake depending on the host. What keeps
 * the two from drifting is that the rule is written down where both can read
 * it (`ChatView.usage`) and asserted on the same numbers in both halves' tests.
 *
 * The rule: the two required buckets sum plainly, an optional bucket is summed
 * only over the generations that reported it, and a bucket nobody reported
 * stays absent — because `0` cache reads and "this provider does not speak
 * about caching" are different facts and only one of them may feed a hit rate.
 *
 * This is the arithmetic only. What a **conversation** may show is
 * {@link conversationUsage}, which drops `totalTokens`.
 * @param usages - one entry per generation.
 * @returns the sum, or `undefined` when there was nothing to add.
 */
export function sumUsage(usages: Iterable<TurnUsage>): TurnUsage | undefined {
  let seen = false
  const total: TurnUsage = { inputTokens: 0, outputTokens: 0 }
  const optional = new Map<typeof OPTIONAL_BUCKETS[number], number>()

  for (const usage of usages) {
    seen = true
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    for (const bucket of OPTIONAL_BUCKETS) {
      const value = usage[bucket]
      if (value === undefined) continue
      optional.set(bucket, (optional.get(bucket) ?? 0) + value)
    }
  }

  if (!seen) return undefined
  for (const [bucket, value] of optional) total[bucket] = value
  return total
}

/**
 * What a whole conversation cost, in the four buckets it may show.
 *
 * {@link sumUsage} with **`totalTokens` dropped, always.** An aggregate total
 * is summed only over the generations that reported one, so on a conversation
 * that mixed providers it comes out smaller than the buckets beside it — on
 * this fake's own seed, 5712 against 6064 + 826 — while still reading as "the
 * total" to whoever renders it. A conversation therefore reports no total, and
 * a surface that wants one adds the buckets it is showing. One generation keeps
 * its own, where the provider's aggregate means what it says.
 * @param usages - one entry per generation the conversation paid for.
 * @returns the sum without `totalTokens`, or `undefined` when there was nothing
 *   to add.
 */
export function conversationUsage(usages: Iterable<TurnUsage>): TurnUsage | undefined {
  const total = sumUsage(usages)
  if (total === undefined) return undefined
  const { totalTokens: _neverAggregated, ...buckets } = total
  return buckets
}

/**
 * Project a whole conversation.
 * @param chat - the fake chat.
 * @param streamingTurn - the turn currently generating, if any.
 * @returns the view the client resolves and events carry.
 */
export function toChatView(chat: FakeChat, streamingTurn?: number): ChatView {
  // Every candidate of every message, not the selected ones: a reading the
  // reader swiped away from was generated and charged. Streaming candidates
  // have no usage yet, so nothing has to be excluded here.
  const side = chat.sideUsage ?? []
  // Both side populations are inside the conversation's total, because they
  // were billed to it on its own route — the protocol's `ChatView.usage` states
  // that ruling and the reason the splits are reported separately rather than
  // subtracted from the figure. Split by `source`, one filter each, from the
  // one array the host stores them in.
  //
  // The newest turn that has actually been assembled: the highest turn among
  // the messages a model wrote. A user line typed but not yet answered does not
  // count, which is the same rule the host's own projection follows.
  const generated = chat.messages.filter(message => message.role === 'assistant').map(message => message.turn)
  const newestTurn = generated.length === 0 ? undefined : Math.max(...generated)
  const usage = conversationUsage([
    ...chat.messages.flatMap(message =>
      message.candidates.map(candidate => candidate.usage).filter(
        (one): one is TurnUsage => one !== undefined,
      ),
    ),
    ...side,
  ])
  const scriptSide = side.filter(one => one.source === 'script')
  const compactionSide = side.filter(one => one.source === 'compaction')
  const scriptTotal = scriptSide.length === 0 ? undefined : conversationUsage(scriptSide)
  const compactionTotal = compactionSide.length === 0 ? undefined : conversationUsage(compactionSide)
  return {
    chatId: chat.chatId,
    title: chat.title,
    ...(chat.characterId === undefined ? {} : { characterId: chat.characterId }),
    messages: chat.messages.map((message, id) =>
      toMessageView(message, id, message.role === 'assistant' && message.turn === streamingTurn),
    ),
    budget: { ...FAKE_CHAT_BUDGET },
    /*
     * The host records an itemization for every turn it assembles and projects
     * the newest one, so the capacity capsule can draw a measured occupancy
     * with no round trip. Modelled here on the same condition: a conversation
     * that has generated at least once has a reading, and one that has not has
     * none — a fixture that always carried one would let a capsule that only
     * ever works on a measured chat pass this fake.
     */
    ...(newestTurn === undefined
      ? {}
      : { measured: { turn: newestTurn, tokens: FAKE_MEASURED_TOKENS } }),
    ...(chat.compaction === undefined ? {} : { compaction: chat.compaction }),
    variables: chat.variables,
    ...(usage === undefined ? {} : { usage }),
    ...(scriptTotal === undefined ? {} : { scriptUsage: { turns: scriptSide.length, usage: scriptTotal } }),
    ...(compactionTotal === undefined
      ? {}
      : { compactionUsage: { turns: compactionSide.length, usage: compactionTotal } }),
  }
}



/**
 * Project a conversation to its sidebar row.
 * @param chat - the fake chat.
 * @returns the summary.
 */
export function toChatSummary(chat: FakeChat): ChatSummary {
  return {
    chatId: chat.chatId,
    title: chat.title,
    ...(chat.characterId === undefined ? {} : { characterId: chat.characterId }),
    updatedAt: chat.updatedAt,
    messageCount: chat.messages.length,
  }
}

/**
 * The whole store's usage, cut by time and by model.
 *
 * **A second implementation of the host's summariser**, and deliberately so,
 * for exactly the reason {@link sumUsage} is one: this package's only
 * dependency is `@iris/protocol`, which is what lets the interface be built and
 * tested with no host at all. The alternative is not sharing the function, it
 * is the fake depending on the host.
 *
 * What keeps the two from drifting is that the rules are written down where
 * both can read them — `UsageTotals` on the wire type states the optional-bucket
 * rule, the two hit-rate populations and the `undatedTurns` reconstruction —
 * and the same properties are asserted on both halves. What is deliberately
 * *not* reproduced is the host's file scan: the fake has no files, so a
 * conversation is scanned exactly when it exists and nothing is ever skipped.
 * @param chats - the fake's conversations.
 * @param options - range and granularity, as the wire method takes them.
 * @returns the summary the wire method resolves with.
 */
export function summariseFakeUsage(
  chats: readonly FakeChat[],
  options: { since?: number, until?: number, granularity?: UsageGranularity } = {},
): UsageSummary {
  const granularity = options.granularity ?? 'day'
  const cells = new Map<string, UsageBucket>()
  const rows: UsageChat[] = []
  const models = new Set<string>()
  const totals = blankTotals()

  for (const chat of chats) {
    const perChat = blankTotals()
    /*
     * Both populations, in one walk, because the range filter and the cell
     * keying are the same for both and a second loop is where the two drift.
     *
     * Every candidate, not the visible one: a reading the reader swiped away
     * from was generated and charged. Then the card's own generations, which
     * hang off the conversation rather than any message. The same set
     * `toChatView` sums, so the page's per-chat subtotal and the composer's
     * line are readings of one population rather than two.
     */
    const records = [
      ...chat.messages.flatMap(message =>
        message.candidates.flatMap(candidate =>
          candidate.usage === undefined ? [] : [candidate.usage])),
      ...chat.sideUsage ?? [],
    ]
    for (const usage of records) {
      // The undated fallback, named where the host names it: a record with no
      // `at` is placed at its conversation's last activity, which clusters
      // every old record of a chat into one bucket. Counted as such below.
      const at = usage.at ?? chat.updatedAt
      if (options.since !== undefined && at < options.since) continue
      if (options.until !== undefined && at >= options.until) continue
      const bucket = bucketOf(at, granularity)
      // JSON, so no separator or sentinel character is needed: `null` and
      // `""` are distinct JSON values, which keeps a model named after the
      // empty string from merging with the records that name none. The host
      // keys its cells the same way.
      const key = JSON.stringify([bucket, usage.model ?? null])
      let cell = cells.get(key)
      if (cell === undefined) {
        cell = {
          bucket,
          ...usage.model === undefined ? {} : { model: usage.model },
          ...blankTotals(),
        }
        cells.set(key, cell)
      }
      if (usage.model !== undefined) models.add(usage.model)
      for (const into of [cell, perChat, totals]) foldUsage(into, usage, usage.at === undefined)
    }
    // A conversation with nothing in range is not a row of zeros: a zero row
    // reads as "this chat cost nothing", which is a different claim from
    // "this chat spent nothing in the week you are looking at".
    if (perChat.turns > 0) {
      rows.push({
        chatId: chat.chatId,
        title: chat.title,
        ...chat.characterId === undefined ? {} : { characterId: chat.characterId },
        updatedAt: chat.updatedAt,
        ...perChat,
      })
    }
  }

  return {
    buckets: [...cells.values()].sort((left, right) =>
      left.bucket - right.bucket
      || (left.model ?? '').localeCompare(right.model ?? '')
      || Number(left.model === undefined) - Number(right.model === undefined)),
    chats: rows.sort((left, right) => right.updatedAt - left.updatedAt),
    models: [...models].sort((left, right) => left.localeCompare(right)),
    totals,
    granularity,
    scannedChats: chats.length,
    skippedChats: 0,
  }
}

/** An empty accumulator; the optional buckets stay absent until one is reported. */
function blankTotals(): UsageTotals {
  return { cacheMiss: 0, output: 0, turns: 0, cacheTurns: 0, cachePrompt: 0, undatedTurns: 0 }
}

/**
 * The start of the bucket a moment falls in, on **local** boundaries.
 *
 * Local because the reader's own midnight is the boundary they mean; the host
 * cuts the same way and says so at greater length.
 * @param at - the moment.
 * @param granularity - day or hour.
 * @returns the bucket's start.
 */
function bucketOf(at: number, granularity: UsageGranularity): number {
  const when = new Date(at)
  if (granularity === 'hour') when.setMinutes(0, 0, 0)
  else when.setHours(0, 0, 0, 0)
  return when.getTime()
}

/**
 * Fold one generation into an accumulator, by the wire type's rule.
 *
 * Required buckets add plainly; an optional one is added only over the
 * generations that reported it and stays absent when none did. `cacheTurns` and
 * `cachePrompt` restrict the hit rate's numerator and denominator to the same
 * population, so a route that never mentions caching cannot dilute one that
 * does. Reasoning is added but never added *into* `output` — the provider
 * reports it as the reasoning share of the completion it is already inside.
 *
 * A `source: 'script'` or `source: 'compaction'` generation is folded
 * **twice**: into the whole, because it was billed on the same route to the
 * same account, and into its own share, so a surface can say how much of the
 * figure a card asked for and how much this host's compaction did. Each share
 * stays absent until one arrives — the same absence rule the optional buckets
 * follow. Keyed by the source, the way `@iris/app-service`'s `addUsage` is, so
 * the fake cannot drift into having one share the host does not.
 * @param into - the accumulator, mutated.
 * @param usage - one generation.
 * @param undated - whether this generation's moment was reconstructed.
 */
function foldUsage(into: UsageTotals, usage: TurnUsage, undated: boolean): void {
  foldBuckets(into, usage)
  if (undated) into.undatedTurns += 1
  const source = usage.source
  if (source !== 'script' && source !== 'compaction') return
  const share = into[source] ?? { cacheMiss: 0, output: 0, turns: 0, cacheTurns: 0, cachePrompt: 0 }
  into[source] = share
  foldBuckets(share, usage)
}

/**
 * Fold one generation's buckets into one bucket set.
 * @param into - the bucket set, mutated.
 * @param usage - one generation.
 */
function foldBuckets(into: UsageBuckets, usage: TurnUsage): void {
  into.turns += 1
  into.cacheMiss += usage.inputTokens
  into.output += usage.outputTokens
  if (usage.cacheWriteTokens !== undefined) {
    into.cacheWrite = (into.cacheWrite ?? 0) + usage.cacheWriteTokens
  }
  if (usage.reasoningTokens !== undefined) {
    into.reasoning = (into.reasoning ?? 0) + usage.reasoningTokens
  }
  if (usage.cacheReadTokens === undefined) return
  into.cacheRead = (into.cacheRead ?? 0) + usage.cacheReadTokens
  into.cacheTurns += 1
  into.cachePrompt += usage.inputTokens + usage.cacheReadTokens + (usage.cacheWriteTokens ?? 0)
}
