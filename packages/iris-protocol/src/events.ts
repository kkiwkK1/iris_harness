/**
 * The push surface, host → browser.
 *
 * Streaming is an event stream rather than a long-lived response because a
 * reply has to be interruptible and because more than one page may be watching
 * the same chat. Every frame names its chat, so a client with several open
 * conversations routes without guessing.
 *
 * @module @iris/protocol/events
 */

import type { ChatSummary, ChatView, DebugReport } from './views.ts'

/** One frame pushed to the browser. */
export type IrisEvent =
  /** A turn opened and text is about to arrive. */
  /**
   * A turn opened.
   *
   * `key` is the identity the reply will carry, and it is here because the
   * client cannot derive it: identities are minted by the host and deliberately
   * encode nothing. A client shows arriving text against a row it synthesizes
   * — no view it holds mentions this turn yet — and unless that row is born
   * with the identity the settled row will have, the reply is torn down and
   * rebuilt at the instant it finishes, which is the single failure
   * {@link import('./views.ts').MessageView.key} exists to prevent.
   */
  | { type: 'stream.start', chatId: string, turn: number, key: string }
  /** Visible text. Deltas concatenate; the client must not assume whole words. */
  | { type: 'stream.text', chatId: string, turn: number, delta: string }
  /** Reasoning, kept on its own channel so a UI can collapse it. */
  | { type: 'stream.reasoning', chatId: string, turn: number, delta: string }
  /**
   * The turn finished. Carries the settled view so the client replaces its
   * optimistic streaming state with the host's truth in one step, rather than
   * trying to reconcile deltas it may have missed.
   */
  /**
   * The turn finished, and **how** it finished.
   *
   * `reason` exists because both paths used to emit this event identically:
   * a generation that ran to completion and one the user aborted were
   * indistinguishable to any subscriber. Upstream has two separate events —
   * `generation_ended` and `generation_stopped` — so a card written against
   * them could never hear the second, and no amount of frame-side work could
   * synthesise it from a signal that does not carry the difference.
   */
  | {
    type: 'stream.end'
    chatId: string
    turn: number
    view: ChatView
    reason: 'completed' | 'aborted'
  }
  /** The turn failed. The user's message survives, so a retry is meaningful. */
  | { type: 'stream.error', chatId: string, turn: number, code: string, message: string }
  /** Something other than streaming changed this chat — an edit, a swipe, a delete. */
  | { type: 'chat.updated', chatId: string, view: ChatView }
  /**
   * A report about something that cannot be undone.
   *
   * **Only the irreversible ones are pushed.** Every report is retained and
   * readable through `debug.reports`; a page that wants the rest asks for them.
   * What cannot wait for someone to open a panel is a deletion — the variable
   * cleanup trimming old floors is the case this exists for — because by the
   * time anyone thinks to look, the thing the report describes is already gone
   * and nothing here replays it back.
   *
   * **The whole record travels, rather than fields copied out of it.** The
   * buffer mints it and this carries the same object, so adding a field to a
   * report cannot leave the pushed copy behind — the failure where a producer
   * and a consumer are both tested and the hand-written assembly between them
   * is not.
   */
  | { type: 'report', report: DebugReport, irreversible: true }
  /** The conversation list changed. */
  | { type: 'chats.updated', chats: ChatSummary[] }

/** Discriminant of an event frame. */
export type IrisEventType = IrisEvent['type']

/**
 * Narrow an event by type.
 * @param event - the frame.
 * @param type - the type to test for.
 * @returns whether the frame is that type.
 */
export function isEvent<T extends IrisEventType>(
  event: IrisEvent,
  type: T,
): event is Extract<IrisEvent, { type: T }> {
  return event.type === type
}
