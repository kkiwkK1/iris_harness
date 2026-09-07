/**
 * The popups cards have raised, waiting for the reader.
 *
 * A module-level register rather than store state, and the reason is the shape
 * of what is held: a popup is a **frame's pending question**, keyed by that
 * frame's own id, and the answer goes back through a callback the frame handed
 * over. None of that is conversation state — it does not survive a chat switch,
 * it never reaches the host, and nothing in `client/store.ts` would consult it.
 * The body-tag choice (`app/body-tag.ts`) is held the same way for the same
 * reason, and `useSyncExternalStore` is what makes either readable from React.
 *
 * **Why a queue and not a stack of dialogs.** Upstream stacks `<dialog>`
 * elements, so a second popup opens over the first. Here one is drawn at a time
 * and the rest wait in order. That changes no result — every popup still gets
 * its own answer — and it keeps the shell from having to reason about a modal
 * on top of a modal it also owns. Recorded in `notes/apps/iris-web/DEVIATIONS.md`.
 *
 * @module iris-web/app/card-popups
 */

import type { PopupAnswer, PopupPlan } from '../sandbox/popup.ts'
import type { PopupRequest } from '../sandbox/runner.ts'

/** One popup on the queue. */
export interface CardPopup {
  /**
   * The queue-wide key: the frame's popup id is only unique per frame, and two
   * frames of two cards can both be on `p1`.
   */
  key: string
  /** Which card run raised it, for the report line and for cleanup. */
  source: string
  /** What to draw. */
  plan: PopupPlan
  /** Report what the reader did. */
  answer: (answer: PopupAnswer) => void
}

let queue: readonly CardPopup[] = []
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Watch the queue.
 * @param listener - called after every change.
 * @returns a disposer, because every registration in Iris is reversible.
 */
export function subscribeCardPopups(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The queue, as one stable array.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders forever
 * if the getter builds a new value each call, so the array is only replaced when
 * it actually changes.
 * @returns every waiting popup, oldest first.
 */
export function getCardPopups(): readonly CardPopup[] {
  return queue
}

/**
 * Put a card's popup on the queue.
 * @param popup - the request, with the way back to the frame.
 */
export function pushCardPopup(popup: CardPopup): void {
  queue = [...queue, popup]
  announce()
}

/**
 * Take one off, without answering it.
 *
 * Two callers, and they are different situations: the card withdrew its own
 * popup (`popup.complete()`, which has already resolved the card's promise), or
 * the frame is gone. Neither may answer — a frame that has been disposed has
 * nobody to hear it.
 * @param key - the queue key.
 */
export function dropCardPopup(key: string): void {
  const next = queue.filter(popup => popup.key !== key)
  if (next.length === queue.length) return
  queue = next
  announce()
}

/**
 * Drop every popup belonging to one card run.
 *
 * Called when a run ends. Without it a popup outlives the frame that asked, and
 * the reader is answering a question nothing is listening to — worse than not
 * asking, because the dialog looks live.
 * @param source - the run identity given at push time.
 */
export function dropCardPopupsFrom(source: string): void {
  const next = queue.filter(popup => popup.source !== source)
  if (next.length === queue.length) return
  queue = next
  announce()
}

/**
 * Answer the popup on screen and take it off the queue.
 *
 * **A non-closing answer stays on the queue.** Upstream's custom button
 * declared with no `result` fires its action and leaves the dialog up
 * ([ST] `popup.js:69`), so the press is reported and the popup is not removed.
 * @param key - the queue key.
 * @param answer - what the reader did.
 */
export function answerCardPopup(key: string, answer: PopupAnswer): void {
  const popup = queue.find(entry => entry.key === key)
  if (popup === undefined) return
  popup.answer(answer)
  if (!answer.closed) return
  queue = queue.filter(entry => entry.key !== key)
  announce()
}

/** One source label per frame, so two frames' `p1` cannot collide. */
let nextSource = 0

/**
 * Wire one card frame's popups to the queue.
 *
 * A bridge rather than three copies of the same four lines: the shell hosts
 * frames in three places (the script host, a message's interfaces, the dev
 * probe), and every one of them has to answer `onPopup`, `onPopupWithdrawn`
 * **and** release what is left when its frame goes. The third is the one a
 * per-call-site wiring forgets, and forgetting it leaves a modal on screen that
 * nothing is listening to.
 * @param label - what kind of frame this is, for the queue key.
 * @returns the two runner callbacks and a release for teardown.
 */
export function cardPopupBridge(label: string): {
  onPopup: (request: PopupRequest) => void
  onPopupWithdrawn: (id: string) => void
  release: () => void
} {
  const source = `${label}#${(nextSource += 1)}`
  const keyFor = (id: string): string => `${source}:${id}`
  return {
    onPopup: request => {
      pushCardPopup({
        key: keyFor(request.id),
        source,
        plan: request.plan,
        answer: request.answer,
      })
    },
    onPopupWithdrawn: id => {
      dropCardPopup(keyFor(id))
    },
    release: () => {
      dropCardPopupsFrom(source)
    },
  }
}

/**
 * Empty the queue.
 *
 * For tests and for the render check, which mount the tree more than once in one
 * process. Deliberately does **not** answer what it drops: a test that wanted an
 * answer asserts on one.
 */
export function resetCardPopups(): void {
  queue = []
  announce()
}
