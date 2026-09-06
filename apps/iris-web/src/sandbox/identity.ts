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

/**
 * Members the frame provides directly, outside the Tavern Helper surface.
 *
 * They need the frame's own shared namespace and its channel to the shell, so
 * they cannot be built by `createFrameTavernHelper` — but they are card-facing
 * all the same, and the classification below has to cover them or the guard
 * would call them strays.
 */
export const FRAME_MEMBERS: readonly string[] = ['initializeGlobal', 'waitGlobalInitialized']

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
/**
 * Where a shared-surface wrapper keeps the member it wraps.
 *
 * The published copy of an `identity` member is wrapped so that calling it
 * through the shared surface says so (attribution is impossible there). That
 * wrapper is a different function object, which broke the check that every
 * published binding is the member the parent proxy answers for the same name —
 * the check that catches the two hand-written parallel lists drifting apart.
 *
 * Rather than excuse those names from the check, which would blind it exactly
 * where a shift is hardest to see, the wrapper carries the original here.
 */
export const SHARED_ORIGINAL = '__irisSharedOriginal'

export const MEMBER_KINDS: Readonly<Record<string, MemberKind>> = {
  // ── identity: partitions by the calling script ───────────────────────
  getScriptId: 'identity',
  /*
   * `shared`: world-info settings are one table for the chat, not per script.
   * Nothing about the answer changes with which script is asking, so a bound
   * copy per script would be sixteen identical fields duplicated per binding.
   */
  getLorebookSettings: 'shared',
  /*
   * `shared`: upstream's injection keys carry no script prefix, so the answer
   * does not depend on which script asks — two scripts choosing one id
   * overwrite each other upstream too. The per-call state that matters (the
   * keys, and whether the handle has been used) lives in the handle's closure,
   * not in a per-script binding.
   */
  injectPrompts: 'shared',
  /*
   * `shared` for the same reason: removal is by id, and an id belongs to the
   * card rather than to one of its scripts.
   */
  uninjectPrompts: 'shared',
  getVariables: 'identity',
  getAllVariables: 'identity',
  replaceVariables: 'identity',
  insertOrAssignVariables: 'identity',
  insertVariables: 'identity',
  deleteVariable: 'identity',
  updateVariablesWith: 'identity',

  /*
   * Identity only in that they report *who* is waiting. The namespace they read
   * and write is the card's, shared on purpose — that is the feature — but a
   * wait that did not name the waiting script would leave a hung script
   * indistinguishable from a healthy one whose siblings are fine.
   */
  initializeGlobal: 'identity',
  waitGlobalInitialized: 'identity',

  // ── identity: registration and teardown belong to the registrant ─────
  eventOn: 'identity',
  eventOnce: 'identity',
  eventMakeFirst: 'identity',
  eventMakeLast: 'identity',
  eventRemoveListener: 'identity',
  eventClearEvent: 'identity',
  eventClearListener: 'identity',
  eventClearAll: 'identity',

  /*
   * Script buttons belong to the script that published them.
   *
   * Upstream says so twice over: the declarations are marked **只能在脚本中使用**,
   * and `getAllEnabledScriptButtons` returns a map keyed by script id, which is
   * only meaningful if each script owns its own list.
   *
   * All five are real now. This note used to say they were stubs and that they
   * were classified by what they *are* rather than by what a stub happens to
   * need — "a stub that later becoming real must not silently change which
   * script it belongs to". That is exactly what happened, and the classification
   * did not have to move, which is the whole point of having written it that way.
   *
   * The three writers take the script id **explicitly**, as upstream does, so
   * they never read this frame's own id and would be correct under a shared
   * binding too. They stay `identity` because ownership is the fact being
   * recorded here, not the argument list: the day one of them gains a default,
   * the binding it needs is already the right one.
   */
  getScriptButtons: 'identity',
  getButtonEvent: 'identity',
  replaceScriptButtons: 'identity',
  appendInexistentScriptButtons: 'identity',
  updateScriptButtonsWith: 'identity',

  // ── shared: the same answer whoever asks ─────────────────────────────
  /**
   * A wrapper, not a capability: it takes the card's own function and hands back
   * a function. Nothing about which script is asking changes what it does.
   */
  errorCatched: 'shared',

  /** The blueprint's version: one number, the same for every caller. */
  getTavernHelperVersion: 'shared',
  /** Emission is card-wide on purpose: it is how scripts reach each other. */
  eventEmit: 'shared',
  getLastMessageId: 'shared',
  /**
   * The floor a message frame renders, answered from the shell's own word. It
   * is a fact about the frame, not about which script asks — and in a script
   * frame it refuses identically for every script, which is the same kind of
   * shared answer `getLastMessageId` gives.
   */
  getCurrentMessageId: 'shared',
  getChatMessages: 'shared',
  getSwipes: 'shared',
  swipeTo: 'shared',
  /*
   * Upstream's chat-patch member. It addresses floors by index — a fact of the
   * chat, not of whichever script asked — so it shares the surface, like the
   * read and the swipe beside it.
   */
  setChatMessages: 'shared',
  /*
   * Upstream's chat append and delete, over the same route as the patch above:
   * both address the chat file by index (rows to append, ids to remove), so the
   * answer belongs to the chat, not to whichever script asked.
   */
  createChatMessages: 'shared',
  deleteChatMessages: 'shared',
  // A world book belongs to the card, not to whichever script asked for it, so
  // two scripts reading the same book must see the same entries.
  getWorldbook: 'shared',
  // The host's whole name list: one answer for every script, and a clone per
  // call so one reader's sort cannot reach the next.
  getWorldbookNames: 'shared',
  // A binding belongs to the card; every script of it sees the same answer.
  getCharWorldbookNames: 'shared',
  /*
   * Writes, and shared for the same reason the read is: a world book is one file
   * belonging to the card. Unlike the variable members, these carry no scope and
   * no script id — two scripts replacing the same book are writing to the same
   * place, which is the intended behaviour rather than a leak.
   */
  replaceWorldbook: 'shared',
  updateWorldbookWith: 'shared',
  /*
   * The chat-book and creation family, shared for the same reason the reads and
   * writes above are: a book, a binding and the name list all belong to the
   * card's installation, and two scripts of one card asking must see — and
   * write — the same one. None carries a scope or a script id.
   */
  getGlobalWorldbookNames: 'shared',
  rebindGlobalWorldbooks: 'shared',
  getChatWorldbookName: 'shared',
  rebindChatWorldbook: 'shared',
  getOrCreateChatWorldbook: 'shared',
  createWorldbook: 'shared',
  createWorldbookEntries: 'shared',
  generate: 'shared',
  /**
   * The caller-ordered generate. `shared` for the same reason `generate` is:
   * every input is the caller's argument and the answer is the model's text —
   * nothing about which script asks changes what it does.
   */
  generateRaw: 'shared',
  triggerSlash: 'shared',
  substitudeMacros: 'shared',
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
