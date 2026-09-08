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
}

/** The assembled request. */
export interface AssembleResult {
  system: string
  messages: PipelineMessage[]
  /** Tokens the assembled request is estimated to occupy. */
  tokens: number
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
