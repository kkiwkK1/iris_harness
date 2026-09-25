/**
 * Derive the conversation the model should see from the durable log.
 *
 * The surface already resolves swipes — selecting a candidate materializes it
 * as the visible node — so this is a projection, not a decision.
 *
 * @module @iris/turn/history
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { HistoryEntry, Role } from '@iris/pipeline'

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
  /**
   * The role a floor is sent as, when it is not the one the log gives it.
   *
   * The log models two speakers, and upstream sends a third: a row whose
   * `extra.type` is `'narrator'` (`/sys`, and a Tavern Helper
   * `createChatMessages` row with `role: 'system'`) reaches the model as
   * `role: 'system'` — 「100% legal way to send a message as system」,
   * `public/scripts/openai.js:580-582`. That marker is not in the log's shape
   * (it rides in `iris/st-meta`, which this package cannot read), so the
   * caller that can read it answers here. A floor with a `'system'` role
   * carries no speaker name, as upstream's narrator line carries none.
   *
   * **Indexed by floor**, the position in `session.deriveMessages()` before
   * {@link HistoryProjection.dropTrailingReply} — the same number the caller
   * reads its line index in. Undefined keeps the log's own role.
   */
  roleOf?: (floor: number) => Role | undefined
  /**
   * Floors the model is not shown at all.
   *
   * Upstream's `is_system` rows — what `/hide` writes, and a card row created
   * with `is_hidden: true` — are filtered out of the conversation before it is
   * built (`coreChat = chat.filter(x => !x.is_system …)`,
   * `public/script.js:4437`). Indexed like {@link roleOf}. The floors that
   * remain keep their own floor number as their id, so hiding one floor does
   * not renumber every floor after it in a cache trace.
   */
  omit?: (floor: number) => boolean
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

  const entries: HistoryEntry[] = []
  messages.forEach((message, floor) => {
    // Left out after the trailing drop, not before it: the reply a reroll
    // replaces is the log's last line whatever its flags, and upstream's
    // regenerate removes it from `chat` before `coreChat` is filtered.
    if (options.omit?.(floor) === true) return
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const role: Role = options.roleOf?.(floor) ?? (message.role === 'assistant' ? 'assistant' : 'user')
    const name = role === 'assistant' ? options.characterName : role === 'user' ? options.userName : undefined

    entries.push({
      role,
      text,
      // The floor number, so a cache trace can name *which* floor changed
      // rather than saying "the conversation did". It is the floor's position
      // in the log, not in this projection: the projection drops from the tail
      // (`dropTrailingReply`) and leaves out hidden floors (`omit`), and
      // numbering after either would give every later floor a new id the turn
      // a floor was hidden — while comparing two turns' records item by item
      // is the whole reason the id exists. Provenance, never content:
      // `PipelineMessage.id` says why it cannot reach a provider.
      id: `history.${String(floor)}`,
      ...name === undefined ? {} : { name },
      // The log's opening floor, whatever role it is sent as. The pin exists
      // because the opening sets the conversation up, and a narrator opening
      // (the corpus's two, in 缄默之秋2.5 MVU, are a character sheet at floor 0)
      // sets it up no less than a greeting does. A hidden opening is not sent,
      // and nothing else is pinned in its place: the pin names a floor, not
      // whichever floor happens to come first.
      ...pinFirst && floor === 0 ? { pinned: true } : {},
    })
  })
  return entries
}
