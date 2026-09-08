/**
 * The vocabulary of prompt assembly.
 *
 * @module @iris/pipeline/types
 */

/** Conversation roles as providers see them. */
export type Role = 'system' | 'user' | 'assistant'

/** One message in the assembled request. */
export interface PipelineMessage {
  role: Role
  text: string
  /**
   * Speaker name, when the surface distinguishes one. Group chats need it, and
   * instruct-mode templates render it into the wire text.
   */
  name?: string
  /**
   * Set when this message carries a contribution the caller marked
   * {@link Contribution.volatile} — text expected to differ next turn.
   *
   * Two consumers, and they are why the flag rides the message rather than
   * being recomputed downstream. {@link AssembleResult.stablePrefixTokens}
   * needs to know where the reusable run of the request stops, and a squash
   * pass needs to know not to merge a volatile message into a stable
   * neighbour — merging rewrites the stable one, which is the single thing the
   * reordering exists to prevent.
   */
  volatile?: boolean
}

/** One turn of existing conversation, oldest first. */
export interface HistoryEntry extends PipelineMessage {
  /**
   * Exempt from budget trimming. The first message of a chat is usually the
   * greeting, and dropping it costs the model the character's voice.
   */
  pinned?: boolean
}

/**
 * Where a contribution lands.
 *
 * `system` sections are concatenated in ascending `order` into the system
 * prompt. `depth` placements are spliced into the chat history instead, which
 * is the whole reason Iris assembles messages itself: author's notes, world-info
 * `atDepth` entries and `/inject` all have to sit a fixed number of turns from
 * the END of the conversation, and a system-prompt registry cannot express that.
 */
export type Placement =
  | { kind: 'system', order: number }
  | {
    kind: 'depth'
    /**
     * Distance from the end of the conversation, using SillyTavern's
     * convention: **0 is after the last message, 1 is before it**. A depth
     * deeper than the conversation clamps to the front.
     */
    depth: number
    role: Role
    /** Tie-break among contributions at the same depth; ascending. */
    order?: number
  }

/** One piece of text contributed to the prompt. */
export interface Contribution {
  /** Stable identity, for diagnostics and for the itemization view. */
  id: string
  /**
   * What to call this when showing it to a person.
   *
   * Carried separately because `id` is often unreadable: 29 of the 41 prompts in
   * a real preset identify themselves by UUID. The preset's own `name` is what
   * SillyTavern displays and what a user will recognise.
   */
  label?: string
  placement: Placement
  text: string
  /**
   * Whether this contribution's text is expected to differ next turn.
   *
   * **A verdict handed in, not a property the assembler can see.** The text
   * here is already macro-expanded, so `{{roll}}` has become a number and
   * nothing in this package can tell that number from a constant. Only a
   * caller that keeps the previous turn's content — or knows what the
   * pre-expansion text contained — can decide, which is why the field is
   * optional and absent means "the caller did not classify this".
   *
   * Two effects, and they are independent:
   *
   * - {@link AssembleResult.stablePrefixTokens} stops at the first volatile
   *   part wherever it sits, so the number tells the truth even with
   *   {@link AssembleInput.cacheFriendly} off.
   * - With `cacheFriendly` on, a volatile **system** contribution is moved out
   *   of the system prompt into the volatile segment after the conversation.
   *   Depth placements are never moved: they are already anchored past the
   *   newest floor, so moving them would change what the model reads for no
   *   prefix gained.
   */
  volatile?: boolean
  /**
   * Whether this contribution has been **observed unchanged** for long enough
   * that pulling it into the request's leading bytes is worth the one-time miss
   * that moving it costs.
   *
   * The other half of {@link volatile}, and a separate field rather than its
   * negation, because "not known to change" and "known not to change" are
   * different claims and only the second one justifies a move. A caller that
   * classifies nothing sets neither.
   *
   * With {@link AssembleInput.cacheFriendly} on, a settled **depth** placement
   * is moved *forward*: out of the conversation, into a segment between the
   * system prompt and the first floor. System placements are already in the
   * prefix, so the flag does nothing for them.
   *
   * **This is the largest measured lever, and it is not about volatility at
   * all.** Depth-anchored content is anchored to the *end* of the conversation,
   * so it slides forward one exchange every turn and is re-sent in full even
   * when it is byte-identical. The corpus census calls that "rent" and finds
   * **100% of it** depth-anchored across 11 real adjacent pairs — a mean of
   * 6 381 tokens a turn over those pairs (two conversations), and 7 140 tokens
   * a turn on one conversation's own six stable pairs, 23% of that turn's
   * request. Promoting it took a synthetic adjacent pair to **98.0%** and the
   * six stable real pairs to **95.0%–98.6%**. Sources: the app-service ledger,
   * §38.
   *
   * The same move on content that is *not* stable is catastrophic rather than
   * merely useless: the four corpus conversations whose depth bucket changes
   * every turn go from 7.6%–55.2% down to 0.0%–19.5%. Hence the flag is a
   * claim the caller has to have earned, and this module refuses to guess it.
   */
  settled?: boolean
}

/** Counts tokens for a piece of text. Supplied by the caller — no tokenizer is bundled. */
export type TokenCounter = (text: string) => number

/** What the assembler is allowed to spend. */
export interface Budget {
  /** Total context window in tokens. */
  context: number
  /** Tokens held back for the model's reply. */
  reserve: number
  count: TokenCounter
  /**
   * Quantise the trim: drop the oldest floors in multiples of this many.
   *
   * A trim that drops exactly what does not fit has to trim again on the very
   * next turn, because the next turn is longer — so the conversation's oldest
   * sent floor moves every turn, and a provider that caches on the request
   * prefix re-pays for the whole conversation on every turn for the rest of the
   * chat. Rounding the number of dropped floors up to a multiple of this holds
   * the oldest sent floor still until the *count* has to cross the next
   * multiple, which takes about half this many turns.
   *
   * **In floors, not tokens, and that is the load-bearing part.** A block
   * expressed as a share of the token budget was written first and measured to
   * buy nothing: subtracting tokens moves the boundary further back, but the
   * slack left behind is still only "whatever did not fit" — the selection
   * keeps adding floors until the next one overflows, whatever the target is —
   * so the boundary advances on the next turn exactly as before. The boundary
   * is an index, so the quantum has to be an index too.
   *
   * `0` restores upstream's arithmetic exactly — drop only what does not fit.
   * Absent takes the assembler's default.
   */
  trimBlockFloors?: number
}

/** Everything one assembly needs. */
export interface AssembleInput {
  contributions: readonly Contribution[]
  history: readonly HistoryEntry[]
  budget: Budget
  /**
   * Maximise the stable prefix, in **both** directions:
   *
   * - a **volatile system** contribution leaves the system prompt for a segment
   *   placed after the whole conversation, ahead of the depth-0 injections;
   * - a **volatile depth ≥ 1** injection joins it, because it sat *inside* the
   *   run two turns would otherwise agree on;
   * - a **settled depth** injection goes the other way, into a segment between
   *   the system prompt and the first floor.
   *
   * A prefix cache hits on the request's leading bytes and stops at the first
   * byte that differs, so the two rules are one rule: everything that does not
   * change belongs in front of everything that does. The second direction is
   * the bigger lever of the two — depth-anchored content is anchored to the end
   * of the conversation, so it is re-sent in full every turn even when it never
   * changes.
   *
   * **This changes the order the model reads**, and that is the whole cost. An
   * instruction that sat at the top of the system prompt now arrives after the
   * transcript; an instruction written to sit two floors from the end now
   * arrives before the transcript. Order *within* each moved segment is
   * preserved, so a group keeps its own reading sequence.
   *
   * Absent or false assembles exactly as it always did, byte for byte.
   */
  cacheFriendly?: boolean
}

/** Why an assembly could not fit everything. */
export interface Overflow {
  /** History entries dropped from the oldest end. */
  droppedHistory: number
  /**
   * True when the non-negotiable part — system sections, depth injections and
   * pinned history — already exceeds the budget. The request is still returned
   * so the caller can decide; refusing to build it would just move the failure.
   */
  overBudget: boolean
}

/** One part of an assembled request, with what it cost. */
export interface AssembledItem {
  id: string
  label?: string
  kind: 'system' | 'depth' | 'history'
  tokens: number
  depth?: number
  role?: Role
  /**
   * True when {@link AssembleInput.cacheFriendly} moved this system section
   * out of the system prompt and into the volatile segment.
   *
   * Reported because the itemization is the only place a person can see it.
   * The row keeps its position in this list — the list is contribution order,
   * which is the order the preset and the card asked for — and a surface that
   * shows *assembly* order sorts the flagged rows to the end itself. Both
   * readings are wanted: "where did I put it" and "where did it go".
   */
  deferred?: boolean
  /**
   * True when {@link AssembleInput.cacheFriendly} moved this depth injection
   * *forward*, out of the conversation and into the stable prefix.
   *
   * The mirror of {@link deferred} and reported for the same reason: the row is
   * the only place a person can see that an instruction written for "two floors
   * from the end" is arriving before the transcript instead.
   */
  promoted?: boolean
}

/** The assembled request. */
export interface AssembleResult {
  system: string
  messages: PipelineMessage[]
  /** Tokens the assembled request is estimated to occupy. */
  tokens: number
  /**
   * Tokens of the request's leading run that carries no volatile part — the
   * most a prefix cache could serve next turn.
   *
   * Walked, not subtracted: the system prompt's sections in render order, then
   * the messages, stopping at the first one marked
   * {@link Contribution.volatile}. That is why the number falls when a
   * volatile section sits at the *front* even though the tail is tidy, which
   * is the shape a `{{roll}}` in a world-info entry actually has (measured:
   * one such entry held a whole conversation's ceiling at 21.9%).
   *
   * An estimate of a ceiling, and it assumes two things: that the
   * conversation's existing floors are not rewritten, and that the budget does
   * not start trimming from the front. Both are visible next door —
   * {@link Overflow.droppedHistory} is the second one.
   *
   * Zero contributions and no history give 0, which is the honest answer for a
   * request with no prefix rather than a division to guard against.
   */
  stablePrefixTokens: number
  overflow: Overflow
  /**
   * Where those tokens went, part by part.
   *
   * The conversation is one aggregate row rather than one row per message,
   * matching upstream's single `ActualChatHistoryTokens`: splitting it would
   * put a UI's hypothetical need into the assembler.
   */
  items: AssembledItem[]
}
