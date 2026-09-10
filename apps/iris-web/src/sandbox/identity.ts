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
   * The deprecated singular set, composed over the same two arms as the patch
   * above: it addresses the chat by floor index — a fact of the chat, not of
   * whichever script asked.
   */
  setChatMessage: 'shared',
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

  // —— family②: regex ——
  /*
   * All five `shared`, on the world-book family's reasoning: a regex tier is a
   * document — the profile's list, the preset file, the card — and two scripts
   * of one card asking must see, and write, the same one. None of the five
   * carries a scope or a script id; upstream's option is `{type, name}`, and
   * `name` is not even accepted here (the tier is resolved from the chat).
   *
   * `formatAsTavernRegexedString` is a pure question about text and this chat's
   * own chain, and `isCharacterTavernRegexesEnabled` is a fact about the
   * character being played. Neither changes with who asks.
   */
  getTavernRegexes: 'shared',
  replaceTavernRegexes: 'shared',
  updateTavernRegexesWith: 'shared',
  isCharacterTavernRegexesEnabled: 'shared',
  formatAsTavernRegexedString: 'shared',
  // —— family④: lorebook / worldbook ——
  /*
   * `shared`, all twenty, and one sentence covers the group: a world book is a
   * **file** belonging to the installation, and none of these members carries a
   * scope or a script id. Two scripts of one card reading a book see the same
   * entries because it is the same file; two writing one book write to the same
   * place, which is the intended behaviour rather than a leak — the ruling the
   * `Worldbook` members above already carry, inherited by the `Lorebook` names
   * they were renamed from.
   *
   * Sixteen are upstream's pre-4.x spelling of members already here, so
   * classifying one differently from the name it aliases would be the mistake
   * this table exists to make impossible: `getChatLorebook` and
   * `getChatWorldbookName` are one behaviour, and a card cannot be told which
   * spelling it is allowed to trust.
   */
  createOrReplaceWorldbook: 'shared',
  deleteWorldbook: 'shared',
  deleteWorldbookEntries: 'shared',
  rebindCharWorldbooks: 'shared',
  getLorebooks: 'shared',
  createLorebook: 'shared',
  deleteLorebook: 'shared',
  getCharLorebooks: 'shared',
  getCurrentCharPrimaryLorebook: 'shared',
  setCurrentCharLorebooks: 'shared',
  getChatLorebook: 'shared',
  setChatLorebook: 'shared',
  getOrCreateChatLorebook: 'shared',
  setLorebookSettings: 'shared',
  getLorebookEntries: 'shared',
  replaceLorebookEntries: 'shared',
  updateLorebookEntriesWith: 'shared',
  setLorebookEntries: 'shared',
  createLorebookEntries: 'shared',
  deleteLorebookEntries: 'shared',

  // —— family①: identity & messages ——
  /*
   * `shared`: the library, the played card and the selected persona are facts
   * about the conversation, not about which script asked. Every one of these
   * answers from the pushed snapshot or from a host arm that takes the chat,
   * and none of them carries a scope or a script id.
   *
   * They are written one per line, in full, rather than folded into a compact
   * `Object.fromEntries(...)` spread that would cost the inlined bootstrap
   * about seven bytes less per name: `card-surface-census.mjs` reads this
   * object out of the **source text** with a per-line pattern
   * (`/^\s*'?(name)'?\s*:\s*'(identity|shared)'/gm`), so a folded block would
   * make every member in it invisible to the caliper — which would then report
   * them as declared-but-unbuilt, the exact reading the census exists to get
   * right. The bytes are recorded in DEVIATIONS §87 instead.
   */
  getCharacterNames: 'shared',
  getCharacterIds: 'shared',
  getCurrentCharacterName: 'shared',
  getCurrentCharacterId: 'shared',
  getCharAvatarPath: 'shared',
  getCharData: 'shared',
  getCharacter: 'shared',
  getPersonaNames: 'shared',
  getPersonaIds: 'shared',
  getCurrentPersonaName: 'shared',
  getCurrentPersonaId: 'shared',
  getPersonaAvatarPath: 'shared',
  getPersona: 'shared',
  /*
   * `identity`: the four that answer about **the calling script**.
   *
   * `getScriptName` and `getScriptInfo` read the snapshot's row for
   * `getScriptId()`'s value, and `replaceScriptInfo` writes a note keyed by it,
   * so a shared binding would answer for whichever script the frame happens to
   * think it is — the failure this file exists to prevent, and a quiet one: a
   * script would print its neighbour's name.
   *
   * `getIframeName` is identity-bearing for the same reason in a script frame,
   * where its answer embeds that script's name and id. In a message frame it is
   * the same for every caller, exactly as `getCurrentMessageId` is; the
   * classification follows the fact it reports rather than the frame it happens
   * to be read in.
   */
  getScriptName: 'identity',
  getScriptInfo: 'identity',
  replaceScriptInfo: 'identity',
  getIframeName: 'identity',
  /* `shared`: a pure function of its argument — upstream's own pattern. */
  getMessageId: 'shared',
  /*
   * `shared`: all six address the conversation, by floor or by chat file. The
   * two history members are narrowed to the open conversation's character by
   * the **host**, which is where a scope decision has to live when the frame is
   * the untrusted side.
   */
  getChatHistoryBrief: 'shared',
  getChatHistoryDetail: 'shared',
  formatAsDisplayedMessage: 'shared',
  retrieveDisplayedMessage: 'shared',
  refreshOneMessage: 'shared',
  rotateChatMessages: 'shared',

  // —— family③: preset ——
  /*
   * Every preset member is `shared`, for one reason that covers all of them: a
   * preset belongs to the **host**, not to a script and not even to a card.
   * There is one preset in use and one library, and two scripts of one card
   * asking what it is must get the same answer — as must two scripts of two
   * different cards. None of these members carries a scope or a script id, and
   * upstream binds none of them per iframe: `predefine.js` merges the whole
   * `TavernHelper` object's keys into a frame's globals unbound, while the
   * members it *does* bind (its `_bind` group) are the identity-bearing ones,
   * and no preset member is among them.
   *
   * The writes are shared for the same reason the world-book writes are: two
   * scripts replacing the same preset are writing to the same place, which is
   * the intended behaviour rather than a leak.
   */
  getPreset: 'shared',
  getPresetNames: 'shared',
  getLoadedPresetName: 'shared',
  loadPreset: 'shared',
  createPreset: 'shared',
  createOrReplacePreset: 'shared',
  replacePreset: 'shared',
  updatePresetWith: 'shared',
  setPreset: 'shared',
  deletePreset: 'shared',
  renamePreset: 'shared',
  /*
   * Pure functions and constants: nothing about which script asks changes what
   * a type guard answers or what an array holds. `default_preset` and the two
   * spellings of the built-in order are properties rather than functions, and
   * they are listed because this table has to cover the whole surface — a
   * member added without an entry fails `identity.test.ts`, which is the only
   * thing that stops the list rotting.
   */
  isPresetNormalPrompt: 'shared',
  isPresetSystemPrompt: 'shared',
  isPresetPlaceholderPrompt: 'shared',
  default_preset: 'shared',
  builtin_prompt_default_order: 'shared',
  placeholder_prompt_default_order: 'shared',
  /** An empty list, the same for everyone; see the member for why it is empty. */
  getProxyPresetNames: 'shared',
  // —— family③ end ——
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
