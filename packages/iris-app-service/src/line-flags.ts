/**
 * The two SillyTavern row attributes that change what the model is sent.
 *
 * Neither is a field this host models — an imported row becomes an ordinary
 * candidate and both ride through `iris/st-meta` verbatim — so every reader
 * that needs one recovers it from the carried fields. This module is the one
 * place that says how, so the readers cannot drift apart on what a hidden or a
 * narrator row *is*:
 *
 * - **hidden** — `is_system: true`. What `/hide` writes (`chats.js:157`), and
 *   what a card's `createChatMessages` row with `is_hidden: true` becomes
 *   (JS-Slash-Runner `chat_message.ts:361-365`). Upstream leaves it out of the
 *   prompt (`script.js:4437`), out of the display regex's depth and out of the
 *   display regex itself (`script.js:1785-1806`), and out of chat search.
 * - **narrator** — `extra.type === 'narrator'`. What `/sys` writes, and what
 *   every `role: 'system'` card row carries. Upstream sends it as
 *   `role: 'system'` (`openai.js:580-582`). It is independent of `is_system`: a
 *   card's visible system instruction is a narrator row that is *not* hidden,
 *   and it reaches the model.
 *
 * Kept out of `entry.ts` because `views.ts` needs it and `entry.ts` imports
 * `views.ts`.
 *
 * @module @iris/app-service/line-flags
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** What one chat line's carried fields say about how the model sees it. */
export interface LineFlags {
  /** `is_system: true`: not sent, not counted, not searched. */
  hidden: boolean
  /** `extra.type === 'narrator'`: sent as a system message. */
  narrator: boolean
}

/** A line with neither attribute — every line Iris writes for a turn. */
export const PLAIN_LINE: LineFlags = Object.freeze({ hidden: false, narrator: false })

/**
 * Read the two attributes off a line's fields.
 *
 * Takes the fields in whichever shape the caller has them — the carried
 * `iris/st-meta` fields, or a raw chat-file line parsed from disk (search) —
 * because both are the same keys under the same names.
 * @param fields - the line's unmodelled fields, or the whole line.
 * @returns the line's flags.
 */
export function lineFlagsOf(fields: { readonly [key: string]: unknown }): LineFlags {
  const extra = fields['extra']
  const narrator = typeof extra === 'object' && extra !== null
    && (extra as { type?: unknown }).type === 'narrator'
  const hidden = fields['is_system'] === true
  return hidden || narrator ? { hidden, narrator } : PLAIN_LINE
}

/**
 * Every carried line's flags, keyed by the message event the line starts at.
 *
 * **The newest record wins**, as `rowFields` reads it: a field changed after
 * import is recorded by appending a fresh `iris/st-meta`, not by editing the
 * old one. A line with no record is {@link PLAIN_LINE}.
 * @param session - the chat log.
 * @returns flags by the line's first message-event seq.
 */
export function lineFlagsBySeq(session: Session): Map<number, LineFlags> {
  const bySeq = new Map<number, LineFlags>()
  for (const event of session.events) {
    if (event.type !== 'iris/st-meta') continue
    bySeq.set(event.data.seq, lineFlagsOf(event.data.fields))
  }
  return bySeq
}
