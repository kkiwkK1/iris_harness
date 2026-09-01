/**
 * Which card-API members depend on *which script* is calling.
 *
 * Today every script gets its own frame, so "who is asking" is answered by the
 * frame itself and nothing here has to think about it. Putting a card's scripts
 * in one realm — which is what makes `waitGlobalInitialized` implementable at
 * all, since a live interface cannot cross an opaque origin — takes that answer
 * away. A member that silently starts answering for the wrong script is the
 * failure mode, and it is quiet: the wrong variable partition reads as empty,
 * and a teardown that reaches too far reads as an event that never fired.
 *
 * Two sources decide the classification, not intuition:
 *
 * - **Variable scope.** `{type:'script'}` partitions by `getScriptId()`, so
 *   every member that accepts a `VariableOption` is identity-bearing. MVU calls
 *   `getScriptId` 17 times for exactly this.
 * - **Event teardown.** Upstream keys its listener registry by iframe name
 *   (`_getIframeName.call(this)`) and `eventClearAll` deletes only that frame's
 *   entry — fired from `predefine.js` on `pagehide`, so a script's listeners die
 *   with the script. Sharing one bus across a card would let one script's
 *   teardown remove its siblings' listeners, which upstream can never do.
 *
 * `eventEmit` is deliberately shared: emission reaching every script of a card
 * is the whole point of a card-wide bus, and it is how one script's work becomes
 * another's input.
 *
 * @module iris-web/sandbox/identity
 */

/** Whether a member's answer depends on which script asked. */
export type MemberKind =
  /** Must be bound per script; a shared implementation answers for the wrong one. */
  | 'identity'
  /** Same answer for every script of a card. */
  | 'shared'

/**
 * Every member of the card API, classified.
 *
 * Exhaustive by test rather than by care: a member added to the surface without
 * an entry here fails `identity.test.ts`, because a hand-kept list of this kind
 * rots silently and the rot is invisible until a card reads someone else's
 * variables.
 */
export const MEMBER_KINDS: Readonly<Record<string, MemberKind>> = {
  // ── identity: partitions by the calling script ───────────────────────
  getScriptId: 'identity',
  getVariables: 'identity',
  getAllVariables: 'identity',
  replaceVariables: 'identity',
  insertOrAssignVariables: 'identity',
  insertVariables: 'identity',
  deleteVariable: 'identity',
  updateVariablesWith: 'identity',

  // ── identity: registration and teardown belong to the registrant ─────
  eventOn: 'identity',
  eventOnce: 'identity',
  eventMakeFirst: 'identity',
  eventMakeLast: 'identity',
  eventRemoveListener: 'identity',
  eventClearEvent: 'identity',
  eventClearListener: 'identity',
  eventClearAll: 'identity',

  // ── shared: the same answer whoever asks ─────────────────────────────
  /** Emission is card-wide on purpose: it is how scripts reach each other. */
  eventEmit: 'shared',
  getLastMessageId: 'shared',
  getCurrentMessageId: 'shared',
  getChatMessages: 'shared',
  getSwipes: 'shared',
  swipeTo: 'shared',
  generate: 'shared',
  triggerSlash: 'shared',
  substidudeMacros: 'shared',
  iframe_events: 'shared',
  tavern_events: 'shared',
  mvu_events: 'shared',
  /** The nested surface; it carries the same members and inherits their kinds. */
  TavernHelper: 'shared',
}

/**
 * The members that must be rebound for each script under co-location.
 * @returns member names needing a per-script binding.
 */
export function identityMembers(): string[] {
  return Object.entries(MEMBER_KINDS)
    .filter(([, kind]) => kind === 'identity')
    .map(([name]) => name)
    .sort()
}
