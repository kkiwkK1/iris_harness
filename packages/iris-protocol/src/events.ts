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
   *
   * `seed` is the text the buffer opens with, when the generation writes on
   * from something already showing (a continue): the arriving deltas are only
   * the new words, and the row they paint over must not collapse to them.
   *
   * `role` and `name` say who the arriving text is for. Absent means the
   * character's reply, which is what a turn ordinarily produces; `'user'` with
   * a name is an impersonation — text the model writes that will settle as the
   * user's own line, so the row it streams into must read as theirs from the
   * first delta, not flip roles the moment it settles.
   */
  | {
    type: 'stream.start'
    chatId: string
    turn: number
    key: string
    seed?: string
    role?: 'user'
    name?: string
  }
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
  /**
   * The turn failed. The user's message survives, so a retry is meaningful.
   *
   * `code` is a string rather than a union because a host may name a layer this
   * protocol has not heard of, and a client that meets an unknown code prints
   * `message`. The five the host sends today:
   *
   * - `aborted` — the user pressed stop.
   * - `timeout` — a phase budget expired; the adapter's message names which.
   * - `provider-error` — the endpoint refused or broke. The detail is the
   *   provider's own words and is the information.
   * - `no-provider` — raised before the request left, because no saved provider
   *   is in use (`iris-app-service` §61). The browser prints its own sentence
   *   for this one.
   * - `storage-error` — the reply was **generated** and could not be written to
   *   disk (`iris-app-service` §72). The one code that does not mean "nothing
   *   was produced": the text is on the host's in-memory log and the next save
   *   that succeeds writes it, which is what the message says, and the
   *   `chat.updated` frame sent just before it carries the view it is in.
   */
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
  /**
   * This chat has never been cleaned, and upstream would offer to clean it.
   *
   * Raised at the gates in `looksNeverCleaned`, and **the host does nothing
   * else with it**. The sweep upstream performs here is far wider than the
   * periodic window — `[1, len - 1 - keep]` — and upstream only performs it
   * after asking, with a backup offered first. Doing it without the question
   * would turn a deletion its author requires consent for into a silent one.
   *
   * The shell answers through `chat.answerCleanup`. Upstream renders three
   * buttons and puts **"back up and clean" before "clean only"**
   * (`popup.js:312-315` prepends custom buttons), and treats a dismissal as
   * "do not remind me" rather than as a deferral.
   */
  | {
    type: 'cleanup.offer'
    chatId: string
    /** Lines in the chat file, which is what upstream gates on. */
    lines: number
    /** The range a sweep would cover, inclusive, in message indices. */
    from: number
    to: number
    /** How many layers inside that range still hold something to remove. */
    layers: number
  }
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
