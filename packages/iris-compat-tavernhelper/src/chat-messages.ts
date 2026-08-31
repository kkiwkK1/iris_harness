/**
 * The chat-message view card scripts read.
 *
 * `data` on an assistant message is the load-bearing field: MVU status bars
 * reach straight for `getChatMessages(id)[0].data.stat_data`, so it must carry
 * that message's own variables — the ones attached to the selected candidate,
 * not the chat's.
 *
 * @module @iris/compat-tavernhelper/chat-messages
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { listCandidates, selectedCandidate } from '@iris/chat'
import type { VariableStore } from '@iris/variables'

/** Roles as Tavern Helper reports them. */
export type MessageRole = 'system' | 'assistant' | 'user'

/** One message, with the selected swipe's text and variables. */
export interface ChatMessage {
  message_id: number
  name: string
  role: MessageRole
  is_hidden: boolean
  message: string
  /** The message's own variables — where MVU keeps `stat_data`. */
  data: Record<string, unknown>
  extra: Record<string, unknown>
}

/** One message with every alternate generation exposed. */
export interface ChatMessageSwiped extends ChatMessage {
  swipe_id: number
  swipes: string[]
  swipes_data: Record<string, unknown>[]
}

/** Filters `getChatMessages` accepts. */
export interface GetChatMessagesOptions {
  role?: 'all' | MessageRole
  hide_state?: 'all' | 'hidden' | 'unhidden'
  include_swipes?: boolean
}

/** Speaker names for the two sides of a chat. */
export interface SpeakerNames {
  user: string
  character: string
}

/** Plain text of a message's content blocks. */
function textOf(message: { content: readonly { type: string, text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * Build the full message list a card would see.
 *
 * Message ids index the conversation as the model sees it — user turns
 * included — because that is what SillyTavern numbers and what a card's
 * `getCurrentMessageId()` will be compared against.
 * @param session - the chat log.
 * @param store - variable store, for the per-message `data`.
 * @param names - speaker names.
 * @returns messages in conversation order.
 */
export function chatMessages(
  session: Session,
  store: VariableStore,
  names: SpeakerNames,
): ChatMessageSwiped[] {
  const bySeq = new Map(session.events.map(event => [event.seq, event]))
  const messages: ChatMessageSwiped[] = []

  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue

    if (event.type === 'user/message') {
      messages.push({
        message_id: messages.length,
        name: names.user,
        role: 'user',
        is_hidden: false,
        message: textOf(event.data),
        data: {},
        extra: {},
        swipe_id: 0,
        swipes: [textOf(event.data)],
        swipes_data: [{}],
      })
      continue
    }

    if (event.type !== 'assistant/message') continue

    const turn = event.data.turn
    const candidates = listCandidates(session, turn)
    const current = selectedCandidate(session, turn)
    const swipeId = current?.index ?? 0

    // Each candidate's own variables: a card comparing swipes must see the
    // state each one actually produced.
    const swipesData = candidates.map(candidate =>
      readCandidateVariables(session, store, turn, candidate.index))

    messages.push({
      message_id: messages.length,
      name: names.character,
      role: 'assistant',
      is_hidden: false,
      message: textOf(event.data.message),
      data: swipesData[swipeId] ?? {},
      extra: {},
      swipe_id: swipeId,
      swipes: candidates.map(candidate => textOf(candidate.message)),
      swipes_data: swipesData,
    })
  }

  return messages
}

/**
 * Read one candidate's variables without disturbing the selection.
 *
 * The message scope addresses whichever candidate is currently selected, so
 * reading a *different* one means asking the log directly rather than going
 * through the store's selector.
 */
function readCandidateVariables(
  session: Session,
  _store: VariableStore,
  turn: number,
  index: number,
): Record<string, unknown> {
  const candidate = listCandidates(session, turn)[index]
  if (candidate === undefined) return {}
  for (let at = session.events.length - 1; at >= 0; at -= 1) {
    const event = session.events[at]
    if (event?.type === 'iris/variables' && event.data.candidateSeq === candidate.seq) return event.data.variables
  }
  return {}
}

/**
 * Resolve the range selector `getChatMessages` accepts.
 *
 * Accepts a single id, `'all'`, an inclusive `'a-b'` span, and negative indices
 * counting from the end — `-1` being the newest message, which is what a card
 * asking for "the message I am rendering in" almost always means.
 * @param range - the selector.
 * @param length - how many messages exist.
 * @returns the message ids it names, ascending.
 */
export function resolveRange(range: string | number, length: number): number[] {
  const clamp = (value: number): number => Math.min(Math.max(value < 0 ? length + value : value, 0), length - 1)

  if (typeof range === 'number') return length === 0 ? [] : [clamp(range)]
  if (range === 'all') return Array.from({ length }, (_unused, index) => index)

  const span = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(range.trim())
  if (span !== null) {
    if (length === 0) return []
    const start = clamp(Number(span[1]))
    const end = clamp(Number(span[2]))
    const [low, high] = start <= end ? [start, end] : [end, start]
    return Array.from({ length: high - low + 1 }, (_unused, index) => low + index)
  }

  const single = Number(range)
  if (!Number.isFinite(single)) throw new Error(`getChatMessages: unrecognized range "${range}"`)
  return length === 0 ? [] : [clamp(single)]
}

/**
 * Select and filter messages the way `getChatMessages` does.
 * @param all - the full message list.
 * @param range - which messages.
 * @param options - role, visibility and swipe filters.
 * @returns the selected messages; swipe fields are stripped unless asked for.
 */
export function selectMessages(
  all: readonly ChatMessageSwiped[],
  range: string | number,
  options: GetChatMessagesOptions = {},
): (ChatMessage | ChatMessageSwiped)[] {
  const role = options.role ?? 'all'
  const hideState = options.hide_state ?? 'all'

  return resolveRange(range, all.length)
    .map(id => all[id])
    .filter((message): message is ChatMessageSwiped => message !== undefined)
    .filter(message => role === 'all' || message.role === role)
    .filter(message => hideState === 'all'
      || (hideState === 'hidden' ? message.is_hidden : !message.is_hidden))
    .map((message) => {
      if (options.include_swipes === true) return message
      const { swipe_id: _id, swipes: _swipes, swipes_data: _data, ...plain } = message
      return plain
    })
}
