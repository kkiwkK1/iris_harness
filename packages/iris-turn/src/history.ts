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

/** Options for the projection. */
export interface HistoryOptions {
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
 * @param options - naming and pinning.
 * @returns conversation entries, oldest first.
 */
export function historyFromSession(session: Session, options: HistoryOptions = {}): HistoryEntry[] {
  const pinFirst = options.pinFirst ?? true

  return session.deriveMessages().map((message, index) => {
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const role = message.role === 'assistant' ? ('assistant' as const) : ('user' as const)
    const name = role === 'assistant' ? options.characterName : options.userName

    return {
      role,
      text,
      ...name === undefined ? {} : { name },
      ...pinFirst && index === 0 ? { pinned: true } : {},
    }
  })
}
