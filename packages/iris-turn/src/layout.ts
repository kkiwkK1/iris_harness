/**
 * Which part of the assembly each slot of the outgoing request came from.
 *
 * A provider's prefix cache is decided in **bytes**: DeepSeek matches the
 * request prefix in 64-token blocks, so a request that differs from the last one
 * at byte 5 239 pays full price for everything after byte 5 239 no matter how
 * much of that text it sent verbatim last turn. Answering "why did this turn
 * miss" therefore needs one thing nothing in this host had: a map from a byte
 * offset in the body back to the *item* that put the byte there.
 *
 * The map cannot be recovered later. By the time a body exists it is one JSON
 * string; the assembler's own itemization counts tokens per contribution but
 * says nothing about position, and reconstructing position by searching the body
 * for a contribution's text is a guess whenever two contributions share a line —
 * which world-info entries copied between books routinely do. So the driver
 * records the slots as it builds them, here, and hands the record along with the
 * request.
 *
 * **This is provenance and it never reaches a provider.** The layout rides on
 * `GenerateOptions` as a field the serialisers do not read: both
 * `serializeRequest` (`@iris/llm-openai-compat`) and `serialiseRequest`
 * (`@iris/app-service`'s fingerprint) name every field they emit as a literal,
 * so a field added here cannot leak into a body by omission.
 *
 * @module @iris/turn/layout
 */

import type { Role, SystemSegment } from '@iris/pipeline'

/**
 * One item inside one message slot.
 *
 * Usually a slot holds exactly one — a floor is its own message, and so is a
 * promoted world-info entry. Two joins put several in one slot, and both would
 * otherwise be opaque to a reader:
 *
 * - `squash_system_messages` merging a run of adjacent system messages;
 * - a **world-info depth bucket**, which is upstream's newline join of every
 *   entry that landed on one depth and role, and which the cache-friendly
 *   split may leave holding several of them (`Contribution.members`).
 *
 * Both join with one newline, so a reader lays either kind of slot back down
 * with one rule. The parts are recorded separately because that is the
 * granularity a reader needs: "the merged system run changed" names three
 * injections at once and identifies none of them, and "the depth injection
 * changed" names the largest part of the request and no entry in it.
 */
export interface LayoutPart {
  /**
   * The contributing part's id: a contribution's, a floor's `history.N`, or —
   * inside a split depth bucket — one member's `<bucket>#<world>.<uid>`.
   */
  id: string
  /** Its display name, when it has one that differs from the id. */
  label?: string
  /**
   * What the part contributed to this slot, as rendered.
   *
   * Kept so a reader can subdivide a merged slot without re-deriving the merge,
   * and so a mismatch between the parts and the slot is *detectable* rather
   * than silently mis-attributed — a template that rewrote the text after this
   * was recorded makes the join stop matching, and the trace says so instead of
   * reporting confident wrong offsets.
   */
  text: string
}

/** One message slot of the outgoing request, in wire order. */
export interface LayoutSlot {
  /**
   * The parts inside it, in order.
   *
   * Empty for a slot the assembler did not place — a continue's nudge or an
   * impersonation's instruction, which the driver pins after the whole
   * conversation. An empty list is "unattributed", not an error.
   */
  parts: LayoutPart[]
  /**
   * The role the assembly gave this slot.
   *
   * The *assembly's* role, which is not always the wire's: a system-placed
   * depth injection rides to the provider as user-role content, because the
   * system slot is already spoken for and providers disagree about
   * mid-conversation system turns (`toMessage`). Recorded as assembled because
   * that is the role a reader is looking for when they ask which injection
   * moved.
   */
  role: Role
  /**
   * True for the tail the driver pins after the conversation.
   *
   * Recorded rather than inferred from "the last slot has no parts", because a
   * slot can be partless for the other reason too — a caller that assembled its
   * own messages — and a trace must not report a nudge where there is none.
   */
  tail?: boolean
}

/**
 * Which item produced each text slot of one request.
 *
 * `messages` is positional and exactly as long as `GenerateOptions.messages`:
 * slot *i* describes message *i*. That is the invariant the whole map rests on,
 * and it is asserted rather than assumed by every reader.
 */
export interface PromptLayout {
  /**
   * The system prompt's seams, in rendered order.
   *
   * Laid end to end and joined with `SYSTEM_JOIN` they reproduce
   * `GenerateOptions.system`; a reader checks that before trusting the offsets,
   * because a template that rewrote the system slot invalidates them.
   */
  system: SystemSegment[]
  messages: LayoutSlot[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface GenerateOptions {
    /**
     * Which item produced each text slot, for cache attribution.
     *
     * Set by {@link TurnDriver} on every request it composes and read by the
     * host's cache trace. Optional because a request composed anywhere else —
     * a side generation, a test — has no assembly behind it and must still be
     * a valid request.
     */
    layout?: PromptLayout
  }
}
