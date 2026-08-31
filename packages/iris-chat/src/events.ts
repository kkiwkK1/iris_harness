/**
 * Iris's additions to the durable session vocabulary.
 *
 * `SessionEventMap` is merge-extensible, and `Session.append` validates only
 * that the payload is lossless JSON — so a package outside the harness
 * repository can own event types. (The guard that refuses unknown types lives
 * in `dsh-session-persistence`, which Iris replaces with its own
 * SillyTavern-compatible backend.)
 *
 * @module @iris/chat/events
 */

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Records which alternate generation of a turn the reader should see.
     *
     * Two seqs, because a selection is both a decision and an act: the user
     * chose `candidateSeq`, and putting it back in front of the model required
     * appending `materializedSeq` (surface nodes can only be shadowed by newer
     * events, never revived). Candidate enumeration subtracts materializations
     * so re-selecting an old swipe does not look like a new one.
     */
    'iris/swipe-select': {
      turn: number
      /** Seq of the `assistant/message` event that first produced the chosen text. */
      candidateSeq: number
      /** Seq of the `assistant/message` event appended to put it back on the surface. */
      materializedSeq: number
    }
  }
}

export {}
