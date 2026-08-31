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
  ViewRole,
} from '@iris/protocol'

/** One alternate reading of a message. */
export interface Candidate {
  text: string
  reasoning?: string
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
    role: message.role,
    name: message.name,
    text: candidate.text,
    turn: message.turn,
    ...(candidate.reasoning === undefined ? {} : { reasoning: candidate.reasoning }),
    ...(message.role === 'assistant'
      ? { swipes: { count: message.candidates.length, index: message.index } }
      : {}),
    ...(streaming ? { streaming: true } : {}),
  }
}

/**
 * Project a whole conversation.
 * @param chat - the fake chat.
 * @param streamingTurn - the turn currently generating, if any.
 * @returns the view the client resolves and events carry.
 */
export function toChatView(chat: FakeChat, streamingTurn?: number): ChatView {
  return {
    chatId: chat.chatId,
    title: chat.title,
    ...(chat.characterId === undefined ? {} : { characterId: chat.characterId }),
    messages: chat.messages.map((message, id) =>
      toMessageView(message, id, message.role === 'assistant' && message.turn === streamingTurn),
    ),
    variables: chat.variables,
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
