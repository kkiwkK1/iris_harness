/**
 * The actions a card may invoke, and the wire methods they reach.
 *
 * Two entry points, one surface. Upstream exposes the context's members both
 * through `getContext()` and directly on the `SillyTavern` global — measured:
 * `SillyTavern.saveMetadata` at six sites, `context.saveChat` at eight, and MVU's
 * own bundle calling `SillyTavern.saveChat` directly. The data members were
 * already reachable both ways here; these are the actions, which were reachable
 * neither way.
 *
 * **The list is used twice and enforced once.** The frame reads it to know which
 * members of its facade are callable; the shell reads it to decide whether to
 * make the call. Only the second is authority — the frame is the untrusted side,
 * so a card asking for a method not on this list is refused by the shell no
 * matter what the frame believes. Sharing one constant keeps the two from
 * drifting into different ideas of the same set.
 *
 * @module iris-web/sandbox/card-api
 */
import type { RpcMethod } from '@iris/protocol'

/**
 * Card-facing action name → the wire method that performs it.
 *
 * The values are `RpcMethod`, not `string`, and that is the whole point of the
 * annotation: the shell reaches `client.call` through a cast, so a misspelled
 * wire method here would compile, ship, and fail only when a card asked for it.
 * A type error at the table is the only place that mistake is cheap. (Type-only
 * import — it costs the frame bundle nothing.)
 */
export const CARD_METHODS: Readonly<Record<string, RpcMethod>> = {
  saveChat: 'script.saveChat',
  saveMetadata: 'script.saveMetadata',
  /*
   * Two generates, two meanings, and the pair is listed together so nobody adds
   * one without seeing the other.
   *
   * `generate` assembles the preset, the worldbook and the history and puts the
   * card's `user_input` last. `generateRaw` sends only what the caller ordered.
   * Serving one with the other **succeeds** — text comes back, nothing throws,
   * and the reply is missing its persona and its conversation — which is why
   * they are separate wire methods rather than one with a flag, and why this
   * table is the place the distinction has to be visible.
   */
  generate: 'script.generate',
  generateRaw: 'script.generateRaw',
  // Not the same thing as the card's bare `getVariables()`, which answers
  // synchronously from the pushed snapshot. This is the round trip that
  // `updateVariablesWith` needs before it can amend a scope the snapshot does
  // not carry.
  getVariables: 'script.getVariables',
  setVariables: 'script.setVariables',
  swipeTo: 'script.swipeTo',
  /*
   * The only worldbook member routed through here, and deliberately the only one.
   *
   * `getCharWorldbookNames` is **synchronous** upstream, so it cannot be a round
   * trip at all — it answers from the pushed snapshot's `charWorldbooks`, the
   * same way the bare `getVariables()` does. Listing it here would be a second,
   * wrong way to reach it.
   */
  /*
   * Reached only through the `SillyTavern` surface, which translates its
   * arguments first — upstream's `position` is a number and this contract's is a
   * string. The entry is here because the wire method is real; the translation is
   * in `frame.ts` because that is where the card's own call shape arrives.
   */
  setExtensionPrompt: 'script.setExtensionPrompt',
  /*
   * Reached as `window.parent.EjsTemplate.evalTemplate`, not as a member of the
   * SillyTavern context — it belongs to the ST-Prompt-Template extension, which
   * publishes its own global. Routable, and off the SillyTavern surface for the
   * same reason the chat-write arms are.
   */
  evalTemplate: 'script.evalTemplate',
  /*
   * The three chat-write arms, reached by the journal replay in
   * `chat-journal.ts` and — for now — by nothing else. They are routable but
   * **not** on the SillyTavern surface; see `OFF_ST_SURFACE` below.
   */
  setChatMessages: 'script.setChatMessages',
  createChatMessages: 'script.createChatMessages',
  deleteChatMessages: 'script.deleteChatMessages',
  /*
   * The button writers' one wire call.
   *
   * Absent until a real card hit it, and the absence was expensive to read:
   * `writeButtons` reports "the host refused to store the table" with the
   * rejection's own text, and the rejection came from `callAction` in this
   * frame — so a refusal issued three functions away, by this file, was
   * presented to the reader as the host's answer. Two sides were checked for a
   * protocol mismatch before the list was checked for a missing line.
   *
   * The lesson is in the message, not here: a refusal must name which side
   * refused. `LIMIT_NOT_YOUR_FAULT` does that for the card author; this one did
   * not do it for us.
   */
  /*
   * On the SillyTavern surface, unlike the other worldbook arms.
   *
   * `getWorldbook` and `replaceWorldbook` are Tavern Helper members and sit in
   * `OFF_ST_SURFACE`; this one is upstream's own context member, which cards
   * call as `SillyTavern.loadWorldInfo(name)`. The two live in the same file and
   * belong on opposite lists, which is the distinction that table exists for.
   */
  /*
   * The card-storage writes.
   *
   * Routed like any other card action rather than through a private channel,
   * because that is what they are: a card calls `localStorage.setItem` and the
   * façade translates. Going around this table would mean one set of card
   * effects the shell's gate does not see, and the gate is the only place that
   * knows which chat is open.
   */
  storageSet: 'storage.set',
  storageRemove: 'storage.remove',
  storageClear: 'storage.clear',
  loadWorldInfo: 'worldbook.load',
  replaceScriptButtons: 'script.replaceScriptButtons',
  getWorldbook: 'worldbook.get',
  /*
   * `updateWorldbookWith` is deliberately absent and is **not** a gap.
   *
   * It takes a function, which cannot cross the frame boundary, so it is built
   * in the frame out of this method plus `worldbook.get` — the same shape
   * `updateVariablesWith` uses. There is no wire method for it to map to.
   */
  replaceWorldbook: 'worldbook.replace',
  /*
   * The chat-book and creation family. The members the frame composes from
   * these (`getOrCreateChatWorldbook`, `createWorldbookEntries`) are Tavern
   * Helper's, so they sit in `OFF_ST_SURFACE` below with the other worldbook
   * arms; the wire methods themselves are plain host capabilities.
   */
  createWorldbook: 'worldbook.create',
  rebindChatWorldbook: 'worldbook.bindChat',
  rebindGlobalWorldbooks: 'worldbook.setGlobalSelect',

  // —— family②: regex ——
  /*
   * The regex family's three round trips.
   *
   * `getTavernRegexes` is **synchronous upstream** and is a round trip here all
   * the same, which is this family's one real departure. The alternative was to
   * put the tiers in the pushed snapshot the way `getCharWorldbookNames` and
   * `getLorebookSettings` ride it, and it was measured rather than guessed: the
   * card tier alone weighs a median of 131.7 KiB and up to 1.04 MiB across the
   * ST corpus's 15 cards that carry one, and the snapshot is inlined into every
   * frame's `srcdoc` uncached — at `FRAME_COUNT_LIMIT` 18 that is 2.4 MiB
   * typical and 19.6 MiB worst, paid by every card including the 100% of the
   * corpus that never calls this. Web ledger §88.
   *
   * `updateTavernRegexesWith` is deliberately absent and is **not** a gap: it
   * takes a function, so the frame builds it out of the two below, exactly as
   * `updateWorldbookWith` is built. `isCharacterTavernRegexesEnabled` is absent
   * because it really is synchronous here — one boolean rides the snapshot.
   */
  getTavernRegexes: 'regex.tavernList',
  replaceTavernRegexes: 'regex.tavernReplace',
  formatAsTavernRegexedString: 'regex.tavernFormat',
  // —— family④: lorebook / worldbook ——
  /*
   * Three new routes for twenty new members, and the ratio is the point: the
   * old `Lorebook` names are upstream's pre-4.x spelling of members already
   * here, so seventeen of them are composed in the frame out of routes this
   * table already carries. A route per member would have put the same write
   * behind two names the shell would then have to keep in step.
   *
   * `deleteWorldbook` is the one genuinely new host capability in the family.
   * `rebindCharWorldbooks` and `setLorebookSettings` reach arms the panel
   * already uses — and both are named after the **card-facing** member rather
   * than the host arm, which is this table's rule: a card asks for what it
   * calls, and the value is where that goes.
   */
  deleteWorldbook: 'worldbook.delete',
  /*
   * The character is **not** named by the card.
   *
   * `worldbook.setCharBooks` takes a `characterId`, and the frame is the
   * untrusted side: a card supplying one could rebind another character's
   * books. `'current'` is the only character these members accept, and the
   * shell is what knows which that is — so it fills the id in, the way it fills
   * in `runId` for an injection. See `client/store.ts`.
   */
  rebindCharWorldbooks: 'worldbook.setCharBooks',
  setLorebookSettings: 'worldbook.setSettings',
}

/**
 * Routable actions that must **not** appear on the `SillyTavern` object.
 *
 * This table answers two questions that were the same one until now: *may the
 * shell route this* and *does a card find it on `SillyTavern`*. They came apart
 * the moment the journal replay needed to reach an arm that upstream does not
 * put on its context object — `createChatMessages` and friends are Tavern Helper
 * members, and inventing `SillyTavern.createChatMessages` would be Iris adding a
 * member to a surface it is supposed to be mirroring.
 *
 * A deny list rather than an allow list is the weaker choice and is used
 * knowingly: an allow list would have to re-declare every existing member, and
 * getting that wrong changes behaviour that works today. The rot it invites —
 * a future entry defaulting to *exposed* — is caught instead by
 * `sandbox-frame.test.ts`, which pins the SillyTavern surface by name.
 */
export const OFF_ST_SURFACE: readonly string[] = [
  'setChatMessages',
  'createChatMessages',
  'deleteChatMessages',
  'evalTemplate',
  /*
   * Tavern Helper members that were reachable on the SillyTavern object because
   * this table used to answer one question instead of two. Measured against
   * `st-context.js`'s 145 keys: none of the three is among them.
   *
   * A card reading `SillyTavern.getVariables` now gets `undefined` and a report,
   * which is the correct answer — the same card on real SillyTavern gets
   * `undefined` and silence. **The reports are expected new noise, not a
   * regression**; see `notes/apps/iris-web/DEVIATIONS.md`, which says so in writing precisely because
   * predicted noise and an unpredicted regression look identical in a log.
   *
   * Deliberately *not* moved, though the names invite it: `generate`,
   * `generateRaw` and `macros` exist on **both** upstream surfaces meaning
   * different things, and `generateRaw` is a legitimate one of the 145. Removing
   * them would be a compatibility break dressed as tidying.
   */
  'getVariables',
  'getWorldbook',
  'replaceWorldbook',
  /*
   * The rest of Tavern Helper's worldbook family, same ruling as the two above:
   * none of these names appears among `st-context.js`'s 145 keys, so serving
   * them on the SillyTavern object would be inventing members on a surface
   * being mirrored. They answer through `TavernHelper.*`, as upstream does.
   */
  'getWorldbookNames',
  'getGlobalWorldbookNames',
  'rebindGlobalWorldbooks',
  'getChatWorldbookName',
  'rebindChatWorldbook',
  'getOrCreateChatWorldbook',
  'createWorldbook',
  'createWorldbookEntries',
  // A Tavern Helper member, like the worldbook family above it: not among
  // `st-context.js`'s 145 keys, so `SillyTavern.replaceScriptButtons` would be
  // Iris adding a member to the surface it is mirroring.
  'replaceScriptButtons',
  /*
   * The storage writes are Iris's own names for Iris's own translation of
   * `localStorage`, which upstream has no context member for at all — a card
   * reaches storage through the global, never through `SillyTavern`. Putting
   * them on that surface would invent three members on a surface being
   * mirrored, and invite a card to depend on names no other host has.
   */
  'storageSet',
  'storageRemove',
  'storageClear',
  /*
   * The composer actions. Upstream has no context member for these at all — a
   * card drives the composer through the DOM, never through `SillyTavern` — so
   * putting them on that surface would invent two members on a surface being
   * mirrored.
   */
  'composerDraft',
  'composerSend',
  /*
   * The regex family. Tavern Helper members, all five, and none of them is
   * among `st-context.js`'s 145 keys — asserted against
   * `UPSTREAM_CONTEXT_MEMBERS` in `tavern-regex-facade.test.ts`, not by eye. Serving
   * `SillyTavern.getTavernRegexes` would be Iris inventing a member on the
   * surface it is mirroring, the ruling this table exists for.
   *
   * All five, not the three that are routable: this list also gates the two the
   * frame answers on its own (`updateTavernRegexesWith`,
   * `isCharacterTavernRegexesEnabled`), and a name absent from here would be
   * published on `SillyTavern` by default — the rot the deny-list note above
   * admits to inviting.
   */
  // —— family②: regex ——
  'getTavernRegexes',
  'replaceTavernRegexes',
  'updateTavernRegexesWith',
  'isCharacterTavernRegexesEnabled',
  'formatAsTavernRegexedString',

  // —— family④: lorebook / worldbook ——
  /*
   * The three new routes, off the SillyTavern object for the same measured
   * reason the rest of the worldbook family is: none of the three names is
   * among `st-context.js`'s 145 keys — they are Tavern Helper members — so
   * serving them there would invent members on the surface being mirrored.
   * A card reaches them as `TavernHelper.deleteWorldbook`, as it does upstream.
   */
  'deleteWorldbook',
  'rebindCharWorldbooks',
  'setLorebookSettings',
]

/**
 * Actions a card may ask for that never reach the host.
 *
 * `CARD_METHODS` maps a card-facing name to a **wire** method, because every
 * other action is a request for something the host owns. These two are requests
 * for something the **shell** owns: the composer. A card writes
 * `#send_textarea.value` and clicks `#send_but`, and what has to happen is that
 * Iris's own composer takes the text and submits it — there is no host arm for
 * "type this for the user", and inventing one would put the shell's UI state on
 * the wire.
 *
 * Kept as a separate list rather than given a plausible-looking wire method,
 * because a table whose values are sometimes real and sometimes decorative is
 * one nobody can read. `wireMethodFor` returns `undefined` for these, and
 * `client/store.ts` answers them before it consults it.
 */
export const SHELL_ACTIONS: readonly string[] = ['composerDraft', 'composerSend']

/**
 * Whether a card may invoke this action.
 *
 * Both lists, because both are things a card is allowed to ask for — the split
 * is about *who answers*, not about who may ask. The frame's own guard
 * (`tests/card-methods.test.ts`) checks against this, so a shell action still
 * has to be declared here to be callable at all.
 */
export function isCardMethod(name: string): boolean {
  return Object.hasOwn(CARD_METHODS, name) || SHELL_ACTIONS.includes(name)
}

/** Whether this action is the shell's to answer rather than the host's. */
export function isShellAction(name: string): boolean {
  return SHELL_ACTIONS.includes(name)
}

/**
 * Whether this action is reachable as a property of `SillyTavern`.
 * @param name - the card-facing action name.
 * @returns true when the surface should carry it.
 */
export function isOnSillyTavernSurface(name: string): boolean {
  return isCardMethod(name) && !OFF_ST_SURFACE.includes(name)
}

/**
 * The wire method behind a card action.
 * @param name - the card-facing name.
 * @returns the wire method, or undefined when the card may not invoke it.
 */
export function wireMethodFor(name: string): RpcMethod | undefined {
  return isCardMethod(name) ? CARD_METHODS[name] : undefined
}
