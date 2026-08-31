/**
 * Which host events reach a card, and under which upstream names.
 *
 * Forwarding is selective on purpose. Everything the shell knows could be
 * broadcast into the frame, but a card that receives an event upstream never
 * sends is harder to debug than one that receives nothing: it acts, and the
 * action looks like a card bug. So this maps only the events whose meaning is
 * the same on both sides, and says nothing about the rest.
 *
 * The mapping is deliberately smaller than the table. Four events MVU listens
 * for have no host equivalent yet — `MESSAGE_SENT` and `MESSAGE_DELETED` are
 * shell actions rather than stream events, and `WORLDINFO_UPDATED` and
 * `CHAT_COMPLETION_SETTINGS_READY` are not even in the shared table — and
 * inventing a source for any of them would be guessing at when a card should
 * wake up.
 *
 * @module iris-web/sandbox/host-events
 */
import { TAVERN_EVENTS } from '@iris/compat-tavernhelper-core'
import type { IrisEvent } from '@iris/protocol'

/** One upstream event, ready to emit inside a frame. */
export interface ForwardedEvent {
  event: string
  args: unknown[]
}

/**
 * Translate one host event into the upstream events a card would expect.
 *
 * @param event - what the host reported.
 * @returns zero or more upstream events, in the order a card should see them.
 */
export function forwardedEvents(event: IrisEvent): ForwardedEvent[] {
  switch (event.type) {
    case 'stream.start':
      return [{ event: TAVERN_EVENTS.GENERATION_STARTED, args: [] }]
    case 'stream.text':
      return [{ event: TAVERN_EVENTS.STREAM_TOKEN_RECEIVED, args: [event.delta] }]
    case 'stream.end':
      /*
       * Two events, in this order. Upstream settles the message before it
       * declares generation over, and cards written against that order use
       * `MESSAGE_RECEIVED` to read the text and `GENERATION_ENDED` to clean up.
       * Reversing them would have a card tidying away state it is about to need.
       */
      return [
        { event: TAVERN_EVENTS.MESSAGE_RECEIVED, args: [event.turn] },
        { event: TAVERN_EVENTS.GENERATION_ENDED, args: [event.turn] },
      ]
    case 'stream.error':
      // Upstream's name for "generation is over and produced nothing".
      return [{ event: TAVERN_EVENTS.GENERATION_STOPPED, args: [] }]
    default:
      /*
       * `chat.updated` and `chats.updated` are deliberately silent. Neither means
       * `CHAT_CHANGED`, which upstream fires when the user opens a *different*
       * chat — a card that re-reads its whole state on every content update
       * would do it on every streamed token.
       */
      return []
  }
}

/**
 * Whether switching to this chat should be announced to a running card.
 *
 * Separate from `forwardedEvents` because the source is different: the shell
 * knows which chat is open, and no host event reports the switch.
 * @param before - the chat that was open, if any.
 * @param after - the chat that is open now, if any.
 * @returns the event to emit, or undefined when the chat did not change.
 */
export function chatChangedEvent(
  before: string | undefined,
  after: string | undefined,
): ForwardedEvent | undefined {
  if (before === after) return undefined
  if (after === undefined) return undefined
  return { event: TAVERN_EVENTS.CHAT_CHANGED, args: [after] }
}
