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

import type { ChatSummary, ChatView } from './views.ts'

/** One frame pushed to the browser. */
export type IrisEvent =
  /** A turn opened and text is about to arrive. */
  | { type: 'stream.start', chatId: string, turn: number }
  /** Visible text. Deltas concatenate; the client must not assume whole words. */
  | { type: 'stream.text', chatId: string, turn: number, delta: string }
  /** Reasoning, kept on its own channel so a UI can collapse it. */
  | { type: 'stream.reasoning', chatId: string, turn: number, delta: string }
  /**
   * The turn finished. Carries the settled view so the client replaces its
   * optimistic streaming state with the host's truth in one step, rather than
   * trying to reconcile deltas it may have missed.
   */
  | { type: 'stream.end', chatId: string, turn: number, view: ChatView }
  /** The turn failed. The user's message survives, so a retry is meaningful. */
  | { type: 'stream.error', chatId: string, turn: number, code: string, message: string }
  /** Something other than streaming changed this chat — an edit, a swipe, a delete. */
  | { type: 'chat.updated', chatId: string, view: ChatView }
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
