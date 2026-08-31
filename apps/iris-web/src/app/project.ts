/**
 * Folding the optimistic stream buffer into the settled view.
 *
 * The protocol's rule is that a client must not try to reconcile deltas into
 * host state — it holds them separately and drops them when `stream.end`
 * arrives with the truth. This module is the one place the two are combined,
 * and only for rendering, so the store never holds a half-settled view.
 *
 * @module iris-web/app/project
 */

import type { ChatView, MessageView } from '@iris/protocol'

import type { StreamBuffer } from '../client/store.ts'

/** A run of messages belonging to one turn. */
export interface TurnGroup {
  /** The turn number, or undefined for messages the host did not attribute to one. */
  turn: number | undefined
  messages: MessageView[]
}

/**
 * Produce the messages to render.
 *
 * Two cases, and the second is the one that matters: the host opens a turn with
 * `stream.start` before any message for it exists in a view the client holds, so
 * the arriving text has to be shown against a message the client synthesizes.
 * Without this, a reply appears only when it finishes.
 * @param view - the settled view, or undefined before one has loaded.
 * @param stream - text arriving for an unsettled turn.
 * @returns the messages, in reading order.
 */
export function withStream(view: ChatView | undefined, stream: StreamBuffer | undefined): MessageView[] {
  if (view === undefined) return []
  if (stream === undefined) return view.messages

  const at = view.messages.findIndex(row => row.role === 'assistant' && row.turn === stream.turn)
  // The key must be the one the settled row will carry, so React updates that
  // row in place when the reply lands rather than unmounting a half-written one
  // and mounting a finished one beside it. Both sources are the host's own
  // word — the existing row's key, or the one `stream.start` announced. This
  // file used to reconstruct it from the turn, which matched the fake client's
  // scheme and never the host's: every real reply remounted at the instant it
  // finished, and every test against the fake passed.
  const live = (base: Pick<MessageView, 'id' | 'name' | 'key'>): MessageView => ({
    id: base.id,
    key: base.key,
    role: 'assistant',
    name: base.name,
    text: stream.text,
    turn: stream.turn,
    streaming: true,
    ...(stream.reasoning === '' ? {} : { reasoning: stream.reasoning }),
    // The rail is deliberately absent while generating. The host's swipe count
    // for this turn is one behind during a regenerate — it has pushed a reading
    // the client has not been told about — and there is nothing to switch to
    // mid-generation anyway. `stream.end` restores it, correct.
  })

  if (at === -1) {
    const name = [...view.messages].reverse().find(row => row.role === 'assistant')?.name ?? view.title
    // The fallback is reachable only while a reconnect's reopen is still in
    // flight: without the opening frame there is no identity to be had, and one
    // remount when the view lands beats showing nothing while text arrives.
    const key = stream.key ?? 'stream-unannounced'
    return [...view.messages, live({ id: view.messages.length, name, key })]
  }

  const existing = view.messages[at] as MessageView
  const next = [...view.messages]
  next[at] = live(existing)
  return next
}

/**
 * Group messages by turn.
 *
 * The rule between turns is the only horizontal rule on the page, so the
 * grouping is load-bearing rather than cosmetic: it shows the reader what a
 * swipe or a regenerate is going to act on.
 * @param messages - the messages in reading order.
 * @returns consecutive runs sharing a turn.
 */
export function groupByTurn(messages: readonly MessageView[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (last !== undefined && last.turn === message.turn && message.turn !== undefined) {
      last.messages.push(message)
    } else {
      groups.push({ turn: message.turn, messages: [message] })
    }
  }
  return groups
}

/**
 * Find the reply a retry would replace.
 *
 * The last assistant message, and only it: regenerating anything earlier would
 * mean discarding everything after it, which is a different operation and one
 * the protocol does not offer.
 * @param messages - the messages in reading order.
 * @returns its id, or undefined when there is nothing to retry.
 */
export function lastReplyId(messages: readonly MessageView[]): number | undefined {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]
    if (message?.role === 'assistant') return message.id
  }
  return undefined
}

/**
 * Find the turn whose readings a keyboard swipe should move through.
 * @param messages - the messages in reading order.
 * @returns the turn and its swipe state, or undefined when nothing has alternates.
 */
export function swipeTarget(
  messages: readonly MessageView[],
): { turn: number, count: number, index: number } | undefined {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]
    if (message?.role !== 'assistant' || message.swipes === undefined || message.turn === undefined) continue
    return { turn: message.turn, count: message.swipes.count, index: message.swipes.index }
  }
  return undefined
}
