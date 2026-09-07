/**
 * What the browser is allowed to know.
 *
 * These are wire shapes, deliberately narrower than the domain types they are
 * projected from. The chat log carries every alternate generation, every raw
 * stream chunk and every variable write; a UI needs the current text, a swipe
 * counter and enough identity to act on a message. Sending the log itself would
 * couple the front end to the durable format and make every schema change a
 * client release.
 *
 * @module @iris/protocol/views
 */

/** Conversation roles the UI renders. */
export type ViewRole = 'system' | 'user' | 'assistant'

/** One message as the UI shows it. */
export interface MessageView {
  /** Stable index in the conversation, matching what a card script would see. */
  id: number
  /**
   * Identity for the lifetime of one open chat.
   *
   * `id` cannot serve: it is a position, so deleting a message shifts every
   * later one and a UI keyed on it reuses component instances across what are
   * now different messages — an open inline editor ends up attached to the
   * neighbouring turn. This need not survive a reload or match anything the
   * host stores; it only has to stay put while the chat is open.
   */
  key: string
  role: ViewRole
  /** Speaker name, for group chats and instruct-mode display. */
  name: string
  /** The selected candidate's text. */
  text: string
  /** Reasoning the model emitted, kept separate so the UI can collapse it. */
  reasoning?: string
  /**
   * Swipe state. Present on assistant messages only; `count` of 1 still means
   * the UI should offer regeneration, just not left/right navigation.
   */
  swipes?: { count: number, index: number }
  /**
   * The turn this message belongs to. The UI needs it because swipe and
   * regenerate address a turn, not a message index.
   */
  turn?: number
  /** True while this message is still streaming. */
  streaming?: boolean
  /**
   * What generating the **selected** candidate cost, when the provider reported
   * it. Assistant messages only; user lines and imported history carry none.
   */
  usage?: TurnUsage
}

/**
 * What one generation cost, in the harness convention: the three prompt-side
 * buckets are **disjoint** (`inputTokens` excludes what the cache served), so a
 * cache-hit share is `cacheReadTokens / (inputTokens + cacheReadTokens +
 * cacheWriteTokens)`. Mirrors `@deepseek-ai/dsh-llm` `TokenUsage`, which the
 * adapter already produces; kept as its own name here because a view type must
 * not import from the LLM layer. Absent fields were not reported by the
 * provider - never zero-filled, because "0 cache reads" and "the provider does
 * not report cache" are different facts and a hit rate must not be computed
 * from the second.
 */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Present only when the provider's aggregate counters were exact and agreed. */
  totalTokens?: number
}

/** One open conversation. */
export interface ChatView {
  chatId: string
  title: string
  characterId?: string
  messages: MessageView[]
  /** Variables of the newest turn, for a status-bar surface. */
  variables?: Record<string, unknown>
  /**
   * Every generation this conversation ever paid for, summed - all swipes, not
   * only the selected ones, because a regenerated reply was billed too. Absent
   * until one generation has reported usage. Optional buckets are summed only
   * over generations that reported them; a bucket no generation reported stays
   * absent, so the hit rate is never diluted by providers that say nothing.
   *
   * **{@link TurnUsage.totalTokens} is always absent here**, on purpose and by
   * ruling. Summed under the rule above it would cover only the generations
   * that carried an exact total, coming out *smaller* than the buckets printed
   * beside it whenever a conversation mixed providers — and a field named
   * `totalTokens` sitting next to four buckets it does not total is a number
   * every consumer reads wrong, silently. So a conversation reports the four
   * buckets and no total; a surface that wants one adds the buckets it is
   * showing. One generation keeps its own `totalTokens`, where the provider's
   * aggregate is exactly what it claims to be — see {@link MessageView.usage}.
   *
   * A generation the host could not attach to a reply is not counted: an
   * impersonation writes a *user* line, so it has no candidate to carry a cost
   * and its tokens are absent from this sum. The host records why (see
   * `@iris/app-service`'s `recordUsage`).
   */
  usage?: TurnUsage
}

/** A conversation in the sidebar list. */
export interface ChatSummary {
  chatId: string
  title: string
  characterId?: string
  /** Unix epoch milliseconds of the last activity. */
  updatedAt: number
  messageCount: number
  /**
   * The conversation this one was branched from, when it was.
   *
   * Present so a list can group a branch under its parent. Upstream records the
   * same relationship as a chat *name* in `chat_metadata.main_chat`; this is the
   * id, because a name changes when the user renames the parent and a broken
   * link is worse than no link.
   */
  parentChatId?: string
}

/**
 * One floor a search matched, and where it sits.
 *
 * `messageId` is the chat-file line index minus the header — the same number a
 * card script sees and `chat.open`'s views use — so a hit names a floor the
 * reader can act on, not a byte offset into a file.
 */
export interface ChatSearchMatch {
  /** The floor whose text matched. */
  messageId: number
  /** The floor's speaker, so a hit can say who said it. */
  name: string
  /** True when the floor is the user's own line. */
  isUser: boolean
  /** Text clipped around the first match, for a row that shows why it hit. */
  snippet: string
}

/**
 * One conversation a search found, with its floors.
 *
 * The identity fields mirror `ChatSummary` so a list can render a hit the same
 * way it renders a row; a hit without at least one match is never sent.
 */
export interface ChatSearchHit {
  chatId: string
  title: string
  characterId?: string
  /** Unix epoch milliseconds of the last activity, as `ChatSummary` carries it. */
  updatedAt: number
  messageCount: number
  parentChatId?: string
  /** The floors that matched, in file order, at most the requested limit. */
  matches: ChatSearchMatch[]
}

/** A character in the library. */
export interface CharacterSummary {
  characterId: string
  name: string
  /** Endpoint serving the card's avatar, or absent when it has none. */
  avatarUrl?: string
  tags: string[]
  creator?: string
  /**
   * The card file's last modification, Unix epoch milliseconds.
   *
   * A rename or a tag edit touches the file, so this is "when the character
   * last changed" and not "when it arrived" — which is what a sort by
   * recency has to mean to match the user's expectation of it.
   */
  updatedAt?: number
  /** Whether the profile has starred this character. Absent means not starred. */
  favorite?: boolean
  /**
   * The opening of the card's `data.description`, at most 200 **code points**.
   *
   * Three facts a character page shows — this, {@link bookEntryCount} and
   * {@link scriptCount} — are counts and one short string, deliberately, and the
   * deliberation is the same one {@link data} argues below: a whole card costs a
   * median of 494 KiB and up to 2.8 MiB, so nothing here may be a whole
   * anything. A clipped description and two integers cost about as much as the
   * `tags` array beside them.
   *
   * **200 is a clip, and on this corpus it is the normal case, not the edge.**
   * Measured over the 19 local cards: 15 carry an *empty* description (the
   * modern Chinese cards put everything in the world book), and the four that
   * carry one run 730, 779, 1744 and 2851 code points — every one of them
   * clipped. So a reader must not treat this as the description; it is its
   * first paragraph-ish worth. No ellipsis is added: whether the clip is marked
   * is the interface's decision, and a host that added one would put a character
   * in the data that the card never had.
   *
   * Code points rather than UTF-16 units, so the clip never lands between the
   * halves of a surrogate pair and produces a lone surrogate — which survives
   * `structuredClone`, reaches the DOM, and renders as a replacement character
   * for exactly the emoji-bearing cards nobody tests with. Combining marks and
   * ZWJ sequences can still be cut; that costs one glyph, not a broken string.
   *
   * **Absent when the card's description is empty**, which as measured is most
   * of them — so a page must render "no description" as *nothing*, not as a
   * blank line under a heading.
   */
  description?: string
  /**
   * How many entries the card's **embedded** `character_book` holds.
   *
   * The count of the same book {@link data} carries in full for the character
   * being played, so the two cannot disagree — this one is carried for every
   * card because a count is 8 bytes and a book is up to 1.1 MiB. Measured over
   * the local corpus: 17 of 19 cards embed a book, holding 4 to 168 entries.
   *
   * **Absent means the card embeds no book at all; `0` means it embeds an empty
   * one.** Those are different facts about a card — an author who shipped a book
   * and emptied it did something an author who never shipped one did not — and
   * folding them together is a one-way loss. This is the one field here that
   * carries a zero; the others treat zero as absent, for the reason
   * {@link scriptCount} gives.
   *
   * It counts *only* the embedded book. A card's world-info bindings by name
   * (`data.extensions.world`, and what the host resolved them to) are a separate
   * question, deliberately not answered here — see `ScriptContext.charWorldbooks`.
   */
  bookEntryCount?: number
  /**
   * How many script units the card carries, in `extractScripts`' reckoning.
   *
   * The same number `script.list` would return rows for — every script the card
   * declares, including the ones its author shipped switched off, because that
   * is what a user is being told the card *contains*. Deriving it any other way
   * would let a page say "3 scripts" over a panel listing 5: the format stores
   * scripts under two extension keys and in three shapes (see
   * `@iris/script/extract`), and a hand-rolled walk of the obvious one missed 7
   * of 15 cards the first time it was tried. Measured over the local corpus: 14
   * of 19 cards carry at least one script, between 1 and 9 each.
   *
   * **Absent means none.** Zero and unknown are the same sentence to a reader —
   * a page says nothing about scripts either way — and every other optional
   * field on this summary already reads that way (`creator` absent when blank,
   * `favorite` absent when not starred, `avatarUrl` absent when there is no
   * picture). {@link bookEntryCount} is the deliberate exception, and says why.
   *
   * It reports what the card holds, never what the user allowed: consent is per
   * card and lives in `script.list`'s own answer, which a library listing has no
   * business anticipating.
   */
  scriptCount?: number
  /**
   * The card's own data, carried **only for the character being played**.
   *
   * Upstream's `characters[this_chid]` is a whole card, and a card script reads
   * it by index. Measured across the corpus, exactly **one** script reaches into
   * that array for real — the other three `characters[…]` hits are the cards'
   * *own* local objects that happen to share the name — and it reads exactly one
   * path, guarded at every level:
   *
   * ```js
   * charData.data && charData.data.character_book && charData.data.character_book.entries
   * ```
   *
   * So this carries `data.character_book` and nothing else. Whole cards would
   * cost a median of 494 KiB and up to **2.8 MiB** on every snapshot, to deliver
   * a book that is at most 1.1 MiB of that and is the only part anybody reads.
   * The nesting is kept exactly as written above, because the shape is what the
   * card tests — a flattened `character_book` at the top level would fail its
   * first guard and read as "this card has no world info".
   *
   * **Only the current character has it.** Every other entry is a summary, as
   * before. Handing out every card's embedded book would put the whole library's
   * world info in a frame that asked about one conversation.
   */
  data?: { character_book?: unknown }
}

/**
 * One of a card's scripts, as a script list shows it.
 *
 * Carries no `content`. A script body runs in the page, but it reaches the
 * frame through the runner, not through this view: putting 3 MB of webpack
 * output in a list response would make opening a settings pane the most
 * expensive call in the product, and the list exists so the user can see and
 * govern what a card contains.
 */
export interface ScriptView {
  id: string
  name: string
  /** Author's notes, when the card carries them. */
  info?: string
  /** What the card's author shipped it as. Not the user's decision. */
  enabledByCard: boolean
  /**
   * Whether it will actually run: the card's switch and the user's, combined.
   *
   * Both are reported because they answer different questions — "why is this
   * off" is answered by which of the two is off, and a UI showing only the
   * result leaves the user unable to tell a card's own choice from their own.
   */
  enabled: boolean
  /**
   * The buttons this script asks the panel to show.
   *
   * Upstream's shape, unchanged: `{ name, visible }`, identified **by position**
   * and by nothing else — a button carries no id, no icon and no callback name,
   * so `buttons[i]` is the only handle there is.
   *
   * **Address a button by `(scriptId, index)`, not by its name.** Measured over
   * the corpus: no script has two buttons with the same name, so
   * `(scriptId, name)` happens to be unique *today* — but one card
   * (`性斗学园超级重制版`) has two different scripts each offering a button
   * called `打开状态栏`, so a name alone is already ambiguous, and nothing
   * upstream prevents a single script from repeating one. Position is unique by
   * construction, because position is the only identity the format stores.
   *
   * **`visible: false` is the common case**: 58 of the corpus's 89 buttons.
   * Rendering the whole array shows a pile of controls their authors hid on
   * purpose. `buttonsEnabled` is the author's separate switch for the group.
   *
   * **The card's declaration, overridden by whatever the script has since
   * written** through `script.replaceScriptButtons` —
   * `ScriptContext.scriptButtons` merges identically. The panel's bar and the
   * card-facing snapshot are two views of one fact; building the bar from the
   * declaration alone would leave it showing buttons a script had already
   * replaced, with the card and the UI each correct on their own terms and
   * disagreeing with each other.
   */
  buttons?: { name: string, visible: boolean }[]
  /** Whether the card's author left this script's button group switched on. */
  buttonsEnabled?: boolean
  /**
   * Size of the body in **UTF-8 bytes**, so a list can say what it is about to
   * run.
   *
   * Bytes, not characters: a consent prompt built from a string's `.length`
   * understates a Chinese script body roughly threefold, and this number's whole
   * job is to tell a user how much code they are agreeing to.
   */
  bytes: number
}

/**
 * One message in the shape a card script expects.
 *
 * SillyTavern's own storage shape, field names included, because that is what
 * the 194 `context.chat` accesses measured across the local corpus read: `mes`,
 * `is_user`, `swipes`. Renaming these to Iris's own vocabulary would move the
 * translation into the browser bridge, where it becomes a second table that can
 * drift from this one — and the bridge's whole job is to be a pass-through.
 *
 * Structurally identical to `@iris/persistence`'s `SillyTavernMessage`, and the
 * index signature makes the two assignable without a cast. Declared here rather
 * than imported so the contract package keeps its one dependency.
 */
export interface ScriptChatMessage {
  name: string
  is_user: boolean
  is_system?: boolean
  send_date?: string
  mes: string
  extra?: Record<string, unknown>
  swipes?: string[]
  swipe_id?: number
  /**
   * This floor's per-swipe variable tables, **as JSON text**.
   *
   * A string, not an array of objects, and the reason is transport rather than
   * taste: structured clone costs per object rather than per byte, so carrying
   * the tables as trees made them 45% of the snapshot's bytes and roughly 91%
   * of its clone time. As text the whole `chat` array clones in a fifth of the
   * time; a reader parses the one floor it wants, which measured at 0.83 ms for
   * the largest table in the longest corpus chat and 0.00 ms at the median.
   *
   * Parse it to read it: `JSON.parse(line.variables)[line.swipe_id ?? 0]`. The
   * value is the same array the chat file holds — only its encoding differs,
   * and only in transit.
   */
  variables?: string
  [key: string]: unknown
}

/**
 * What a card script sees when it reads `SillyTavern.getContext()`.
 *
 * Deliberately narrow. SillyTavern's own context object exposes 145 keys; the
 * 19 here are the ones the local corpus's 47 scripts actually touch, found by
 * intersecting what the scripts read against the real key list rather than by
 * transcribing documentation. Anything absent is absent on purpose: a surface
 * built to the documentation would be seven times larger, and every extra
 * member is something a card can come to depend on.
 *
 * Field names are SillyTavern's for the same reason as {@link ScriptChatMessage}.
 */
export interface ScriptContext {
  /** The conversation, in storage order. 194 accesses — the largest single one. */
  chat: ScriptChatMessage[]
  /**
   * Per-chat storage, read AND written: cards use it as their durable store
   * (`meta.someKey[k] = v`, then save). 28 accesses.
   */
  chatMetadata: Record<string, unknown>
  /** The user's name, as the chat file records it. */
  name1: string
  /** The character's name. */
  name2: string
  characterId?: string
  chatId?: string
  /**
   * The library, for a card that offers to switch or reference another.
   *
   * Whole summaries, so this carries the three content facts a summary
   * carries — a clipped `description` and the two counts. Measured on the
   * 19-card corpus, they add 2003 bytes of JSON to a 4026-byte list (1.96 KiB),
   * and they are strictly *less* than upstream hands a card here, which is the
   * whole `characters` array with every card's full description in it.
   */
  characters: CharacterSummary[]
  /**
   * This card's extension settings, partitioned per card.
   *
   * One card must not read another's: cross-card reads would defeat the
   * per-card grant model, since a card could learn — and store — through a
   * neighbour what it was not itself allowed.
   *
   * **This answers a narrower question than upstream's field of the same name,
   * and the difference is deliberate.** SillyTavern's `extension_settings` is
   * one installation-wide bag every extension and card shares. Measured across
   * 121 sources, cards mostly do not use it as storage at all: of 20 sites in 3
   * cards, 19 are **reads probing whether some other extension is present**
   * (`extension_settings['st-chatu8']`, `.EjsTemplate.enabled`) and one is a
   * card writing its own namespace. So the common use is detection.
   *
   * A partition serves detection *correctly*: a key belonging to an extension
   * this host does not have is absent, which is the true answer, and a
   * neighbouring card cannot make it look present. It also serves a card's own
   * namespace, which is the only write shape measured.
   *
   * What it does not serve: a card writing a **foreign** extension's key in
   * order to configure that extension installation-wide. Upstream would apply
   * that globally; here it stays in the card's own partition and affects
   * nobody. No corpus card does this, and the scope of that negative is 19
   * cards plus one sample — card 20 is under no obligation.
   *
   * The trap to avoid is aliasing this to any populated installation-wide
   * store. The field would keep its name, keep type-checking, and start
   * answering "is this extension installed" with unrelated data — wrong in a
   * way nothing reports. `tests/extension-settings-shapes.test.ts` pins all
   * three measured shapes.
   */
  extensionSettings: Record<string, unknown>
  /** Current variable state, for a card reading MVU's store. */
  variables: Record<string, unknown>
  /**
   * The world books this card is bound to, by name.
   *
   * Names, never contents — upstream's `getCharWorldbookNames` returns names and
   * makes the caller fetch a book separately, so listing them costs nothing.
   *
   * **`primary` is the binding, not the book in use.** It is
   * `data.extensions.world` as the card declares it, reported even when no file
   * of that name exists (2 of 18 corpus bindings are dangling). The host may
   * well be assembling prompts from the card's *embedded* book instead — see
   * `resolveCardWorldbook`'s fallback — but reporting what we chose rather than
   * what the card declares would answer a different question than the one
   * upstream's member asks.
   *
   * The card's own embedded `character_book` is a separate body of entries and
   * is deliberately not reported here; upstream's member does not report it
   * either.
   */
  charWorldbooks?: { primary: string | null, additional: string[] }
  /**
   * Every world book the host knows, by name.
   *
   * The synchronous source for TavernHelper's `getWorldbookNames()`, which
   * upstream answers with `klona(world_names)` — no promise. A book the host
   * seeded from a card's embedded copy is a real book upstream (it lives in
   * ST's `world_names` the moment it is written), so it has to be a real name
   * here: a card that names its own book in an existence assertion must find it.
   *
   * Names only, and refreshed with the snapshot like `charWorldbooks` beside
   * which it sits — the same freshness argument, and the same "names cost
   * nothing" shape. `getChatWorldbookName()` applies the same list as the
   * existence guard on `chat_metadata.world_info`, exactly as upstream's
   * `getChatLorebook` honours the key only while `world_names` holds it.
   */
  worldbookNames?: string[]
  /**
   * Each script's buttons, by script id — **unfiltered**.
   *
   * `getScriptButtons()` is synchronous upstream
   * (`JS-Slash-Runner/src/function/script.ts:58`), so it has to be answerable
   * from this snapshot rather than over the wire.
   *
   * **Every button, including the hidden ones.** `visible: false` means "do not
   * render", not "does not exist" — 58 of the corpus's 89 buttons are hidden,
   * and a script flipping one to `true` is how it makes a button appear. A
   * surface that filtered here would make that impossible and would look
   * correct: the panel shows the right buttons, and the script simply cannot
   * find the one it wants to reveal.
   *
   * **What it carries is the card's declaration overridden by whatever the
   * script has since written** — not the declaration alone. That distinction
   * used to be wrong in this very comment: the field merged from the moment
   * `replaceScriptButtons` existed, while the words still said "declared". A
   * contract's prose has to hold up the semantics, or the next reader builds
   * against the sentence.
   *
   * `ScriptView.buttons` merges the same way, so the panel's bar and this
   * snapshot are two views of one fact rather than two sources that can
   * disagree.
   *
   * The script-level `buttonsEnabled` switch and the panel's own rendering
   * rules are separate layers that live where the rendering happens; this is the
   * data layer.
   */
  scriptButtons?: Record<string, { name: string, visible: boolean }[]>
  /**
   * World-info settings, for TavernHelper's `getLorebookSettings()`.
   *
   * Carried in the snapshot rather than fetched, because that member is
   * **synchronous**: MVU calls it both with and without `await`, and both work
   * only while the value is already in hand. Backing it with a request would
   * break the call site that does not await.
   *
   * Sixteen fields, and two of the names mislead — `max_depth` is the ceiling
   * for *minimum activations*, not the scan depth, and `context_percentage` is
   * a percentage while `budget_cap` is the byte count. Copied as-is, because a
   * card reads them by name.
   */
  lorebookSettings?: LorebookSettings
  /**
   * The card storage shared across this profile, as key to value.
   *
   * Flat and string-valued, matching `localStorage`. Provenance — which card
   * wrote a key last — is kept by the host and deliberately not shipped here: a
   * frame has no use for it, and the snapshot is already the expensive part of
   * every turn.
   */
  storage?: Record<string, string>
  /**
   * The layers `getAllVariables` merges, each unmerged and labelled by source.
   *
   * Upstream's `_getAllVariables` (`JS-Slash-Runner/src/function/variables.ts`)
   * shallow-assigns in a fixed order, and for a **script** frame that order is
   * `global → character → script → chat`, later winning. Floor tables are folded
   * in only for a *message* frame — measured by d7 — which is why they are absent
   * here and why this carries no per-floor data at all.
   *
   * Sent unmerged on purpose. The merge is one `_.assign` chain that the façade
   * can do, while the reverse is impossible: a card calling
   * `getVariables({type: 'chat'})` needs that layer alone, and a pre-merged tree
   * cannot be taken apart again.
   */
  /**
   * The floor a message frame is rendered in, and that floor's own variables.
   *
   * Present only when `script.context` was asked for a `messageId`; a script
   * frame has no floor. `variables` here is **that floor's own layer** and does
   * not inherit from earlier floors — upstream reads
   * `chat_message.variables[swipe_id] ?? {}` with no walk backwards, so a floor
   * that wrote nothing reports an empty table rather than the newest state it
   * could reach. Inheriting would make the anchoring decorative.
   *
   * It follows the **selected** swipe, `variables` being an array parallel to
   * `swipes`.
   */
  floor?: {
    /** The chat-file line index — what `getCurrentMessageId()` should answer. */
    messageId: number
    /** That floor's own layer, empty when it has none. */
    variables: Record<string, unknown>
  }
  variableLayers: {
    /** Installation-wide. Upstream's `extension_settings.variables.global`. */
    global: Record<string, unknown>
    /** The card's own, from its `tavern_helper.variables`. */
    character: Record<string, unknown>
    /**
     * Per script, keyed by script id.
     *
     * All of the card's partitions rather than one, because this context is
     * fetched per card while the scope is per script — the façade knows which
     * script it is running and picks its own. One script must not read
     * another's, so the façade selecting is the enforcement point.
     */
    script: Record<string, Record<string, unknown>>
    /** This conversation's, from `chat_metadata.variables`. */
    chat: Record<string, unknown>
  }
}

/** Where a script's injected prompt goes. Mirrors upstream's positions. */
/**
 * Where a script's injection goes.
 *
 * `'none'` is upstream's `NONE: -1` — **registered but never assembled**. No
 * call site of `getExtensionPrompt` ever queries that position, so such an
 * injection holds its key (to be overwritten or removed) and contributes no
 * text. That is a third state, distinct from both "assembled" and "absent".
 */
export type ScriptPromptPosition = 'before' | 'after' | 'at-depth' | 'none'

/** One part of an assembled prompt, and what it cost. */
export interface PromptItemEntry {
  /**
   * The contribution's stable id.
   *
   * Machine-facing, and frequently a UUID: measured over a real preset, 29 of
   * its 41 prompts identify themselves that way. Which is exactly why this is
   * not the thing to render.
   */
  id: string
  /**
   * What to show a person.
   *
   * The preset's own `name` (`"写作模式（二选一）"`), or the identifier for a
   * built-in. The same string SillyTavern's own UI displays, so a user who
   * imported the preset recognises the row.
   *
   * Both this and {@link id} are carried because neither alone is enough: ids
   * are unreadable, and real presets reuse names across different prompts.
   */
  label: string
  kind: 'system' | 'depth' | 'history'
  tokens: number
  /** For a depth injection, how many messages from the end it sits. */
  depth?: number
  role?: ViewRole
}

/**
 * Where an assembled prompt's tokens went.
 *
 * The feature exists because the answer is routinely surprising. Measured on a
 * real preset and card: of 2929 prompt tokens, **1920 — 66% — were a single
 * world-info depth injection**. Nothing else in the product can show that.
 */
export interface PromptItemization {
  turn: number
  entries: PromptItemEntry[]
  /** Sum of the entries. */
  tokens: number
  /**
   * What the provider reported this prompt actually cost, when it has.
   *
   * Shown beside {@link tokens} so a user can see whether the estimate is
   * trustworthy. Absent in preview, and absent for a turn whose provider
   * reported no usage.
   */
  actualTokens?: number
  budget: { context: number, reserve: number }
  /** History entries dropped to make the request fit. */
  droppedHistory: number
  overBudget: boolean
  /**
   * True when this is how the NEXT request would assemble, rather than a record
   * of one already sent.
   *
   * A record lives only as long as the host holds the chat open, so a UI asking
   * for an old turn can get a preview instead. Say so rather than showing
   * nothing: "the record for this turn was lost when the chat closed; here is
   * how it would assemble now" is useful, and a blank panel is not.
   */
  preview: boolean
}

/**
 * One saved connection: an endpoint, a model and a preset, switched together.
 *
 * Upstream stores a display name generated once at creation, from the values as
 * they were then. Measured on the user's own install, the profile they have
 * selected is called `deepseek deepseek-chat - Default` and points at a Gemini
 * model, a different endpoint and a different preset — the name was true when it
 * was written and has been wrong ever since.
 *
 * So there is no stored name here. {@link label} is the user's own words, which
 * cannot go stale, and {@link summary} is derived on every read. Disagreement
 * between a profile's name and its contents is not prevented by discipline; it
 * is unrepresentable.
 */
export interface ConnectionProfile {
  id: string
  /** What the user called it. Absent means they never named it. */
  label?: string
  /** Derived from the current values on every read, never stored. */
  summary: string
  /** Which registered adapter route to generate through. */
  provider: string
  model: string
  /** Preset file to assemble with, by name. */
  preset?: string
  /** Sampling overrides applied when this profile is activated. */
  sampling?: Partial<GenerationSettings>
  /**
   * The endpoint this profile generates through, when it carries one of its
   * own. Absent means the profile rides the host's configured route as it was
   * before profiles carried endpoints — those still work exactly as they did.
   */
  baseURL?: string
  /**
   * Whether a key is stored for this profile. **The key itself is never on
   * the wire** — a read answers with this flag and, when the key is long
   * enough not to be given away by it, its last four characters, so the user
   * can tell which key of theirs this is without the interface ever holding
   * one to show.
   */
  hasKey?: boolean
  /** The stored key's last four characters, when there is a key and it is long enough to show them. */
  keyTail?: string
  /** The header the key is sent in, when not the OpenAI-compatible default. */
  apiKeyHeader?: string
}

/**
 * Why a `connection.test` probe said no, named.
 *
 * Each code is a different next step for the person in front of the form, so
 * they are kept apart rather than folded into one "failed": a missing key is
 * fixed in this form, a 401 means the key typed is wrong or expired, a
 * timeout points at the network or the endpoint's own serve, and the rest
 * mean the thing reached is not speaking the OpenAI-compatible dialect the
 * probe assumes.
 */
export type ConnectionTestErrorCode =
  /** The endpoint is known to need a key and none was available to send. */
  | 'missing-key'
  /** The endpoint answered 401/403 — the key sent does not open it. */
  | 'unauthorized'
  /** The endpoint did not answer within the probe's budget. */
  | 'timeout'
  /** The request never reached an endpoint — DNS, refused, reset. */
  | 'network'
  /** The endpoint answered, with a status that is not one of the named kinds. */
  | 'http-error'
  /** The endpoint answered 200, but not with a model list the probe can read. */
  | 'bad-response'
  /** A saved profile was probed that carries no endpoint of its own. */
  | 'no-endpoint'

/** The named failure half of a `connection.test` result. */
export interface ConnectionTestError {
  code: ConnectionTestErrorCode
  /** Human-readable detail. Safe to show; must not carry a credential. */
  message: string
}

/**
 * One user persona, as the persona panel lists it.
 *
 * `position` uses upstream's own words (`parsePersonaPosition`,
 * `personas.js:1963`): the description either rides the `personaDescription`
 * prompt slot (`inprompt`), sits a fixed number of turns from the end of the
 * conversation (`atdepth`), or is held out of the prompt entirely (`none`) —
 * where it still reaches the world-info scan, exactly as upstream's scan data
 * carries it regardless of position.
 */
export interface PersonaView {
  id: string
  /** The persona's name — upstream keeps it beside the avatar file it is keyed by. */
  name: string
  description: string
  position: 'inprompt' | 'atdepth' | 'none'
  /** Turns from the end of the conversation, when `position` is `atdepth`. */
  depth?: number
  /** The injection's role, when `position` is `atdepth`. */
  role?: 'system' | 'user' | 'assistant'
}

/**
 * How much reasoning a reasoning model should spend on a reply.
 *
 * Upstream's own value set (`reasoning_effort_types`, openai.js:237), sent as
 * the request body's `reasoning_effort`. `'auto'` is the upstream default and
 * means "let the provider decide", which this host expresses by **sending no
 * field at all** — see `@iris/llm-openai-compat`.
 */
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'min' | 'max'

/**
 * What separates a continued reply from the text it writes on from, in the
 * four spellings upstream's own radio group offers (`continue_postfix_types`,
 * openai.js:211). `'space'` is upstream's default; the words name the literal
 * separators (`''`, `' '`, `'\n'`, `'\n\n'`), which the host maps at the
 * consumer.
 */
export type ContinuePostfix = 'none' | 'space' | 'newline' | 'double'

/** The model route, budget, sampling and reply shaping a chat is running with. */
export interface GenerationSettings {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  /**
   * The context window in tokens — upstream's `openai_max_context`.
   *
   * Preset-scoped like everything here: a real preset is tuned for one window
   * (measured on this machine's install: 4095, 655 350, 1 000 000, 2 000 000),
   * and assembling against a different one silently trims a different part of
   * the conversation. Absent falls back to the host composition's value.
   */
  contextWindow?: number
  /** How hard a reasoning model thinks, upstream's `reasoning_effort`. */
  reasoningEffort?: ReasoningEffort
  topP?: number
  topK?: number
  minP?: number
  repetitionPenalty?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stop?: string[]
  /**
   * Cut a finished reply back to its last complete sentence — upstream's
   * `power_user.trim_sentences` ("trim incomplete sentences"), applied to the
   * text the model produced. Absent means off, which is upstream's default:
   * most models end their replies cleanly and the cut only ever removes text.
   */
  trimSentences?: boolean
  /**
   * The separator between a reply and its continuation — upstream's
   * `continue_postfix`, applied when a continue assembles its request.
   * Absent means `'space'`, upstream's default; on every OpenAI-compatible
   * route upstream applies this and so does this host, which has no other
   * route.
   */
  continuePostfix?: ContinuePostfix
  /**
   * Merge consecutive system-role messages into one — upstream's
   * `squash_system_messages`. Some providers take a system message in the
   * middle of a conversation badly; depth injections and card scripts make
   * adjacent system messages possible here, and this is the one control over
   * whether they ride as they were assembled. Absent means off, upstream's
   * default.
   */
  squashSystemMessages?: boolean
}

/**
 * One prompt of the active preset, as the prompt manager shows it.
 *
 * Field names are camelCased projections of the file's own (`injection_depth`
 * → `injectionDepth`): the manager edits live state, not the file shape, and
 * the file shape rides verbatim in `@iris/preset` for whoever needs it.
 */
export interface PresetPromptView {
  id: string
  /** Display name; absent for the built-in markers upstream leaves unnamed. */
  name?: string
  role?: string
  /** Whether this prompt contributes to the assembled request. */
  enabled: boolean
  /** A slot the host fills with live data; carries no editable text. */
  marker?: boolean
  /** A built-in prompt upstream refuses to delete. */
  systemPrompt?: boolean
  /** `'relative'` follows the list order; `'absolute'` pins a chat depth. */
  injectionPosition?: 'relative' | 'absolute'
  injectionDepth?: number
  injectionOrder?: number
  /** A card may not replace this prompt's content with its own. */
  forbidOverrides?: boolean
  /** Whether the manager allows toggling this prompt at all. */
  toggleable: boolean
}

/** The prompt manager's state: the active preset and its ordered prompts. */
export interface PresetManagerView {
  /** The active preset's name, when it is one from the library. */
  name?: string
  prompts: PresetPromptView[]
}

/** One preset file in the profile's library, by name. */
export interface PresetSummary {
  name: string
}

/**
 * One global regex script, in the shape SillyTavern stores under
 * `extension_settings.regex` and exports as a `regex-*.json` file.
 *
 * The known fields are spelled out so the shell can render a row without
 * guessing; the index signature is the actual contract. Upstream's script
 * objects are open — extensions and shared decks add keys this host has never
 * heard of — and a list → set → disk round trip must hand them back untouched,
 * or an import from an install would arrive complete and quietly degrade. The
 * engine's reading of these fields is `@iris/regex`'s `RegexScript`.
 */
export interface RegexScriptView {
  id?: string
  /** Required, the same gate upstream's importer applies ("No script name provided."). */
  scriptName: string
  /** Pattern, either bare or in `/pattern/flags` form. */
  findRegex: string
  replaceString: string
  trimStrings?: string[]
  placement?: number[]
  disabled?: boolean
  markdownOnly?: boolean
  promptOnly?: boolean
  runOnEdit?: boolean
  substituteRegex?: number
  minDepth?: number | null
  maxDepth?: number | null
  [key: string]: unknown
}

/** Where a world book entry is inserted, by TavernHelper's name for it. */
export type WorldbookPosition =
  | 'before_character_definition'
  | 'after_character_definition'
  | 'before_example_messages'
  | 'after_example_messages'
  | 'before_author_note'
  | 'after_author_note'
  | 'at_depth'
  | 'outlet'

/** How a world book entry's secondary keys combine. */
export type SecondaryLogic = 'and_any' | 'not_all' | 'not_any' | 'and_all'

/**
 * One world book entry, in the shape a card script reads.
 *
 * TavernHelper's `WorldbookEntry`, which is **not** the shape on disk, and the
 * two disagree in ways a card would notice: `name` is the file's `comment`,
 * `enabled` is the negation of its `disable`, and three independent booleans
 * (`constant`, `vectorized`, `selective`) collapse into one `strategy.type`.
 * Putting the file's own shape on the wire would be a quieter kind of wrong —
 * every field present, several of them inverted.
 */
export interface WorldbookEntry {
  uid: number
  /** The file's `comment`. Cards treat it as the entry's title. */
  name: string
  enabled: boolean
  strategy: {
    type: 'constant' | 'vectorized' | 'selective'
    /**
     * Primary keys, as written.
     *
     * Upstream revives regex-shaped strings (`/foo/i`) into live `RegExp`
     * objects before a card sees them. A `RegExp` cannot cross this boundary —
     * it would arrive as `{}` — so the host sends the strings it read and the
     * revival belongs to whoever hands these to a card.
     */
    keys: string[]
    /**
     * Secondary keys, and the logic combining them.
     *
     * `keys` here needs the **same** revival as the primary ones above — this
     * was measured, not assumed: upstream maps both lists through
     * `parseRegexFromString` with the identical expression
     * (`worldbook.ts:214` and `:218`), and this host's activation engine runs
     * both through `matchKey`, which does the same. Reviving only the primary
     * list would give a card plain strings for keys the engine is matching as
     * patterns — each half self-consistent, the pair wrong, nothing raised.
     *
     * The earlier version of this comment mentioned only `keys`, and a reader
     * building the façade correctly inferred the narrower rule from it. Field
     * documentation that is silent about a sibling reads as a statement about
     * that sibling.
     */
    keys_secondary: { logic: SecondaryLogic, keys: string[] }
    /** `'same_as_global'` when the entry sets no depth of its own. */
    scan_depth: number | 'same_as_global'
  }
  position: {
    type: WorldbookPosition
    role: 'system' | 'user' | 'assistant'
    depth: number
    order: number
  }
  content: string
  /** Already resolved: 100 when the entry does not use probability. */
  probability: number
  recursion: {
    prevent_incoming: boolean
    prevent_outgoing: boolean
    /** Null rather than 0 or false when there is no delay. */
    delay_until: number | null
  }
  effect: {
    /** Null rather than 0 when unset — the two are one state on disk. */
    sticky: number | null
    cooldown: number | null
    delay: number | null
  }
  addMemo: boolean
  group: string
  groupOverride: boolean
  groupWeight: number
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  /**
   * The entry's world-info outlet, when it has one: an `outlet`-positioned
   * entry is parked under this name by the scan and rendered only where a
   * template asks for `{{outlet::name}}`. Empty when the entry has none.
   */
  outletName: string
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  /**
   * Identifier an automation (quick reply, STscript) can key off. Empty when
   * the entry carries none.
   *
   * Added with the shell's entry editor: a field the stored shape carries and
   * the editor has to show was missing from this view, and a book round-tripped
   * through a save silently blanked every automation binding it had. The four
   * fields below it are the same story — each is on disk, each was unreadable
   * here, and each was dropped by a write that could not carry it.
   */
  automationId: string
  /** Per-entry group-scoring override; `null` defers to the global setting. */
  useGroupScoring: boolean | null
  /** Bypass the token budget for this entry. */
  ignoreBudget: boolean
  /** Whether `probability` is rolled at all; `false` means the entry always fires. */
  useProbability: boolean
  /** Generation types this entry may fire on; empty means all of them. */
  triggers: string[]
  /** Restrict the entry to (or, with `isExclude`, away from) characters and tags. */
  characterFilter: { isExclude: boolean, names: string[], tags: string[] }
}

/**
 * One survived failure the host kept, as a debug page reads it.
 *
 * The wire shape of `@iris/app-service`'s diagnostic buffer. Declared here
 * rather than imported from the host so the page half compiles against the
 * protocol alone.
 */
/**
 * What a report is claiming.
 *
 * **`fault` means a call was not served**: something asked for did not happen,
 * and whoever asked is now working from an answer they did not get. **`note`
 * means it was served and there is still something to say** — a deletion that
 * succeeded, a value that survived in a different shape, a state worth knowing.
 *
 * The two levels match the frame’s own `reportFault` / `reportGap`, so a reader
 * moving between the two halves is not re-learning a vocabulary. It is separate
 * from {@link DebugReport.kind}: the kind says what the report is about, the
 * grade says whether anything is broken.
 */
export type ReportGrade = 'fault' | 'note'

export interface DebugReport {
  /** Whether a call went unserved, or was served with something to say. */
  grade: ReportGrade
  /** Monotonic, and the cursor a page pages with. */
  seq: number
  /** Unix epoch milliseconds. */
  at: number
  /** `mvu | template | prompt | script | variables | storage | host`. */
  kind: string
  chatId?: string
  characterId?: string
  scriptId?: string
  message: string
  /**
   * The original failure's stack, **present only when one was caught**.
   *
   * Most report sites write their own sentence rather than catching an error.
   * Giving those a stack would be worse than giving them none: it names the
   * place that reported, while reading as the place that failed.
   */
  stack?: string
}

/** How a character's books and the globally selected ones are interleaved. */
export type InsertionStrategy = 'evenly' | 'character_first' | 'global_first'

/**
 * World-info settings as TavernHelper's `getLorebookSettings()` reports them.
 *
 * Declared here so the page half compiles against the protocol alone. The
 * host's `@iris/app-service/lorebook-settings` is the authority on the values.
 */
export interface LorebookSettings {
  selected_global_lorebooks: string[]
  scan_depth: number
  /** A percentage of context, not a byte count. */
  context_percentage: number
  /** Bytes; `0` disables the cap. */
  budget_cap: number
  min_activations: number
  /** Ceiling for minimum activations; `0` means none. Not the scan depth. */
  max_depth: number
  max_recursion_steps: number
  insertion_strategy: InsertionStrategy
  include_names: boolean
  recursive: boolean
  case_sensitive: boolean
  match_whole_words: boolean
  use_group_scoring: boolean
  overflow_alert: boolean
}

/**
 * The world-info settings as this host stores and runs them, on the wire.
 *
 * This is the host's own vocabulary — the stored field names, camelCase, one
 * meaning each — rather than TavernHelper's snake_case table above, and the
 * deliberate difference is the point: {@link LorebookSettings} exists to be
 * byte-compatible with what a card reads by name, while this exists to be
 * settable by the host's own panel without dragging the compatibility table's
 * misleading names (`max_depth`, `context_percentage`) into a UI that would
 * have to explain them.
 *
 * Every field is effective, never absent: the host merges stored values over
 * SillyTavern's shipped defaults before answering, so a client reading this
 * sees exactly what the next scan will run with.
 */
export interface WorldbookSettingsView {
  /** `world_info_depth` — how many messages back a scan reads. */
  scanDepth: number
  /** `world_info_budget` — a percentage of the context window. */
  budgetPercent: number
  /** `world_info_budget_cap` — an absolute token ceiling; `0` disables. */
  budgetCap: number
  /** `world_info_min_activations` — keep widening the scan until this many fire. */
  minActivations: number
  /** `world_info_min_activations_depth_max` — how far that widening may reach. */
  minActivationsDepthMax: number
  /** `world_info_max_recursion_steps` — hard cap on scan loop iterations. */
  maxRecursionSteps: number
  /** How the global and character books interleave. */
  insertionStrategy: InsertionStrategy
  /** Whether activated content is scanned for further matches. */
  recursive: boolean
  /** Default case sensitivity for entries that defer. */
  caseSensitive: boolean
  /** Default whole-word matching for entries that defer. */
  matchWholeWords: boolean
  /**
   * Whether the world-info scan buffer carries speaker names.
   *
   * Affects what the scan matches on, never what the model receives — the
   * buffer is built for matching and discarded. ST default true.
   */
  includeNames: boolean
  /** Default inclusion-group resolution by key-match score. */
  useGroupScoring: boolean
}

/**
 * One named world book, with the two facts a chooser needs beside its name.
 *
 * **Deliberately not part of `worldbook.names`' default answer.** That method
 * documents itself as names-and-not-contents because listing books must not
 * read every entry off the disk, and an entry count cannot be had without
 * opening the file. So the counts are asked for — `worldbook.names`'
 * `withCounts` — and a caller that only wants names pays exactly what it paid
 * before.
 */
export interface WorldbookSummary {
  /** The book's name, exactly as `worldbook.names` spells it. */
  name: string
  /**
   * How many entries the file holds, enabled or not.
   *
   * Every entry, because that is what the file *contains* and what an editor
   * would list. How many of them a scan would admit depends on the chat, the
   * budget and the keys, and is not a property of the book.
   */
  entryCount: number
  /**
   * The card this book was materialised from, when this host materialised it.
   *
   * Read off the materialisation table (`materialise.ts`'s
   * `WorldbookBindingStore`), which is **the** link between a card and its
   * book — the filename is not, precisely so that a name can be given up when
   * it collides. So this answers "which card's embedded book became this file",
   * which is the question a reader looking at nine similarly-named books is
   * actually asking.
   *
   * An id, not a name: resolving the name means decoding the card, and a
   * listing of 18 books must not decode 19 cards. The client already holds the
   * library and can look it up.
   *
   * **Absent does not mean "no card's".** A book the user made in SillyTavern
   * and bound to a card by hand was never materialised here, so this host has
   * no record of the link; a client that also knows a card's `extensions.world`
   * can match on the name as a second, weaker rule.
   */
  fromCharacterId?: string
}

/**
 * Which book one card's own world info comes from, and how.
 *
 * A **report of the host's choice, not a second choice.** The name is the same
 * one `resolveCardWorldbook` resolves with — the materialised binding when
 * there is one, otherwise the card's `extensions.world` — so a panel showing
 * this and a prompt built by that host cannot disagree about which book is
 * playing.
 */
export interface CardWorldbookView {
  /**
   * The book the card's world info comes from, or `null` when it has none.
   *
   * Not always the card's own `extensions.world`: see {@link materialised}.
   */
  name: string | null
  /**
   * Where {@link entryCount} was counted.
   *
   * - `named` — a book file, the case every played card is in once its chat has
   *   been opened.
   * - `embedded` — the card's own `character_book`, which has **not** been
   *   materialised into a file yet. A real and transient state: materialisation
   *   runs on the import and open paths, so a card that has never been opened
   *   on this host sits here.
   * - `none` — neither. The card ships no book and binds nothing that resolves.
   */
  source: 'named' | 'embedded' | 'none'
  /** Entries in that book; `0` when {@link source} is `none`. */
  entryCount: number
  /**
   * Whether {@link name} is the name this host minted rather than the card's own.
   *
   * True exactly when the materialisation table holds a name for this card and
   * it differs from `extensions.world` — a collision made the host give the
   * wanted name up. It is the reason a user reads a book name in this panel
   * that is not the one written on their card, so it has to be sayable.
   */
  materialised: boolean
}

/**
 * Why a snapshot of a conversation exists.
 *
 * The host records the reason **in the snapshot's file name**, so a folder
 * listing is self-describing and a sidecar index has nothing to drift from.
 * Each value names the dangerous operation the copy was taken in front of.
 */
export type BackupReason =
  /** The cleanup sweep's explicit "back up and clean" answer. */
  | 'cleanup'
  /** One floor was about to be removed (`chat.deleteMessage`). */
  | 'delete-message'
  /** Several floors were about to be removed by a card's replay batch. */
  | 'delete-messages'
  /** An import was about to write over an existing conversation file. */
  | 'import-overwrite'
  /** A restore was about to write a snapshot back over the live conversation. */
  | 'pre-restore'
  /** A card was about to rewrite floors in place (`script.setChatMessages`). */
  | 'rewrite-messages'

/**
 * One stored snapshot of a conversation.
 *
 * `backupId` is the path **relative to the profile's backups root** — the
 * handle every other backup method takes. It is built from validated ids, so
 * it is safe to echo back, and it never leaks an absolute host path.
 */
export interface BackupSummary {
  backupId: string
  /** The conversation the snapshot was taken of. */
  chatId: string
  /** The card the conversation was played with, when it had one. */
  characterId?: string
  /**
   * When the snapshot was taken, parsed from the file name's stamp.
   *
   * Unix epoch milliseconds. `0` when the name carries no readable stamp — a
   * file dropped in by hand is still listable, it just sorts as oldest.
   */
  createdAt: number
  /** Floors carried, header line excluded — recorded in the name at snapshot time. */
  messageCount: number
  /** File size in bytes. */
  bytes: number
  /** What the host was about to do, when the name says. */
  reason?: BackupReason
}

/** One floor of a snapshot, as the read-only preview shows it. */
export interface BackupPreviewFloor {
  /** The floor's index in the snapshot, the same number a card script would see. */
  messageId: number
  /** The floor's speaker. */
  name: string
  /** True when the floor is the user's own line. */
  isUser: boolean
  /** The floor's text, clipped — a preview, not a re-render. */
  text: string
}

/**
 * A read-only look into one snapshot: the header's facts and the first floors.
 *
 * Everything here comes off the snapshot's own bytes, so what a reader sees is
 * what a restore would write back — not a summary the host computed at
 * snapshot time and could have gone stale.
 */
export interface BackupPreview {
  /** The snapshot itself, as the list carries it. */
  backup: BackupSummary
  /** The conversation's title, as the snapshot's header records it. */
  title: string
  /** Who the user was in that conversation, when the header says. */
  userName?: string
  /** Who the character was, when the header says. */
  characterName?: string
  /** The header's own `create_date`, verbatim, when it carries one. */
  createDate?: string
  /** The first floors, in file order. */
  floors: BackupPreviewFloor[]
  /** How many floors the snapshot holds in full. */
  totalFloors: number
}
