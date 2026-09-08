/**
 * Derive the conversation the model should see from the durable log.
 *
 * The surface already resolves swipes — selecting a candidate materializes it
 * as the visible node — so this is a projection, not a decision.
 *
 * @module @iris/turn/history
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { HistoryEntry } from '@iris/pipeline'

/**
 * What one generation needs left OUT of the conversation it is given.
 *
 * Separate from the naming options because it is decided by the driver rather
 * than by the caller: a projection is a projection of the log, but *which*
 * generation is being run is the turn driver's business. {@link TurnDriver}
 * passes this to its `history` callback, and a callback that ignores it is
 * repaired by the driver — see `TurnDriverOptions.history`.
 */
export interface HistoryProjection {
  /**
   * Leave out the reply this generation is replacing.
   *
   * A reroll must not show the model the answer it is being asked to write
   * again. Upstream drops it on both of its paths — `Generate` deletes the last
   * message before the prompt is built on a **regenerate**
   * (`chat.length = chat.length - 1`, `public/script.js:4347`) and pops it from
   * the prompt copy only on a **swipe** (`coreChat.pop()`,
   * `public/script.js:4438-4440`) — so the conversation the model reads ends at
   * the user's line either way.
   *
   * The rule is upstream's, guard included: **only a trailing assistant message
   * is dropped**. Upstream's own branch does nothing when the newest message is
   * a user line (`if (chat.length && lastMessage.is_user)`), which is exactly
   * the retry case here — a turn whose first attempt failed has a user line and
   * no candidate, and there is nothing to leave out.
   */
  dropTrailingReply?: boolean
}

/** Options for the projection. */
export interface HistoryOptions extends HistoryProjection {
  /**
   * Exempt the opening message from budget trimming. It is normally the
   * character's greeting, and dropping it costs the model the voice it is
   * supposed to be imitating.
   */
  pinFirst?: boolean
  /** Speaker name for assistant turns, when the surface shows one. */
  characterName?: string
  /** Speaker name for user turns. */
  userName?: string
}

/**
 * Project the log onto pipeline history.
 * @param session - the chat log.
 * @param options - naming, pinning, and what this generation must not see.
 * @returns conversation entries, oldest first.
 */
export function historyFromSession(session: Session, options: HistoryOptions = {}): HistoryEntry[] {
  const pinFirst = options.pinFirst ?? true
  const derived = session.deriveMessages()
  // Dropped here, before the mapping, so anything a caller computes per entry
  // — a regex script's `depth`, above all — is computed over the conversation
  // that is actually being sent. Upstream's own depths are post-pop
  // (`coreChat.length - index - 1`, `public/script.js:4444`), so a script
  // scoped to the newest message must land on the user's line during a reroll,
  // not on the reply that is being thrown away.
  const messages = options.dropTrailingReply === true && derived[derived.length - 1]?.role === 'assistant'
    ? derived.slice(0, -1)
    : derived

  return messages.map((message, index) => {
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const role = message.role === 'assistant' ? ('assistant' as const) : ('user' as const)
    const name = role === 'assistant' ? options.characterName : options.userName

    return {
      role,
      text,
      // The floor number, so a cache trace can name *which* floor changed
      // rather than saying "the conversation did". The index is over the
      // projection, and the projection only ever drops from the tail
      // (`dropTrailingReply`), so a floor keeps this id from one turn to the
      // next — which is the whole reason two turns' records can be compared
      // item by item. Provenance, never content: `PipelineMessage.id` says why
      // it cannot reach a provider.
      id: `history.${String(index)}`,
      ...name === undefined ? {} : { name },
      ...pinFirst && index === 0 ? { pinned: true } : {},
    }
  })
}
