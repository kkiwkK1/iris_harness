/**
 * How much of a long conversation the reading view mounts.
 *
 * Layer ② of three, and the only one this module touches. `WINDOWING.md` names
 * all three, which is worth repeating here because finishing this one looks like
 * finishing the job:
 *
 * | layer | what it costs | state |
 * | --- | --- | --- |
 * | ① transport | a whole `ChatView` crosses the wire on every `stream.end` and every `chat.updated` | **untouched** |
 * | ② mounting | every message becomes DOM and rendered markdown | this module |
 * | ③ frames | a card interface costs bytes, by four orders of magnitude more than a message | `render-window.ts` |
 *
 * So on a 677-message chat, every completed reply still re-serialises 677
 * messages across the boundary after this lands. Render cost drops; wire cost
 * does not move at all. Layer ① needs new RPCs and incremental events and has no
 * consumer yet — writing it down is how the next reader avoids concluding that
 * windowing is done.
 *
 * @module iris-web/app/reading-window
 */

/**
 * How many messages the view mounts before the reader asks for more.
 *
 * **100, the same as upstream** (`power-user.js:133`, `chat_truncation: 100`),
 * and the user's own install has never changed it — so a reader arriving from
 * SillyTavern is already calibrated to this number.
 *
 * Following upstream here is a decision about *where* to differ. The cost unit
 * at this layer is roughly uniform: one message is one row of DOM and one
 * markdown render, give or take. The place where costs diverge wildly is layer
 * ③, where one floor can carry a 360 KiB interface and its neighbour carries a
 * sentence — so that is where Iris measures in bytes instead of counts. Where
 * the unit matches upstream's, matching upstream's number costs nothing and buys
 * a reader's existing intuition.
 *
 * On the measured corpus this is nearly an identity: 30 of 31 chats are under
 * 100 messages. It protects the worst case without touching the common one.
 */
export const DEFAULT_WINDOW = 100

/** What the view should mount, and what it is holding back. */
export interface ReadingWindow<T> {
  /** The messages to mount, oldest first, ending at the newest. */
  visible: T[]
  /** How many older messages exist above them. */
  hidden: number
}

/**
 * Take the newest `shown` messages.
 *
 * **`0` means all of them**, not none. That is upstream's convention —
 * `power_user.chat_truncation || Number.MAX_SAFE_INTEGER`
 * (`script.js:1477`), where dragging the slider to zero switches truncation off
 * — and it is already the convention in `render-window.ts` for the frame window.
 * The two must agree: one number meaning "everything" in one window and
 * "nothing" in the other, in the same product, is a defect waiting for whoever
 * reads only one of them.
 *
 * A negative value is treated the same way, because `slice(-n)` on a negative
 * `n` returns the whole array anyway and an explicit branch is better than
 * relying on that coincidence.
 *
 * The window is a **tail**, so a chat that grows while the reader watches keeps
 * showing the newest messages with no recalculation. That is also why nothing
 * here tracks scroll position: the anchor is the end of the conversation, which
 * is where a reader of a live chat already is.
 * @param messages - the whole conversation, oldest first.
 * @param shown - how many to mount; `0` or negative for all.
 * @returns the tail to mount, and the count above it.
 */
export function readingWindow<T>(messages: readonly T[], shown: number): ReadingWindow<T> {
  if (shown <= 0 || messages.length <= shown) {
    return { visible: [...messages], hidden: 0 }
  }
  return { visible: messages.slice(messages.length - shown), hidden: messages.length - shown }
}

/**
 * How many messages to show after the reader asks for more.
 *
 * Adds another `step`, matching upstream (`script.js:1447`, `:1462`), and stops
 * growing once everything is shown so the caller can drop the control rather
 * than leave a button that does nothing.
 *
 * Takes the current window rather than reading state, so the arithmetic is
 * testable and the caller keeps the state. A `shown` of `0` is already
 * everything and cannot grow.
 * @param shown - the current window size.
 * @param step - how much to add, normally the same as the initial window.
 * @param total - how many messages exist.
 * @returns the new window size, capped at `total`.
 */
export function grow(shown: number, step: number, total: number): number {
  if (shown <= 0) return shown
  return Math.min(shown + Math.max(step, 1), total)
}
