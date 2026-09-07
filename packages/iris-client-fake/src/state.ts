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
  ChatSummary,
  ChatView,
  GenerationSettings,
  MessageView,
  TurnUsage,
  ViewRole,
} from '@iris/protocol'

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
    ...(streaming ? { streaming: true } : {}),
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
  const usage = conversationUsage(
    chat.messages.flatMap(message =>
      message.candidates.map(candidate => candidate.usage).filter(
        (one): one is TurnUsage => one !== undefined,
      ),
    ),
  )
  return {
    chatId: chat.chatId,
    title: chat.title,
    ...(chat.characterId === undefined ? {} : { characterId: chat.characterId }),
    messages: chat.messages.map((message, id) =>
      toMessageView(message, id, message.role === 'assistant' && message.turn === streamingTurn),
    ),
    variables: chat.variables,
    ...(usage === undefined ? {} : { usage }),
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
