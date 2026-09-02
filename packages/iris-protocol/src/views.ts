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
}

/** One open conversation. */
export interface ChatView {
  chatId: string
  title: string
  characterId?: string
  messages: MessageView[]
  /** Variables of the newest turn, for a status-bar surface. */
  variables?: Record<string, unknown>
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

/** A character in the library. */
export interface CharacterSummary {
  characterId: string
  name: string
  /** Endpoint serving the card's avatar, or absent when it has none. */
  avatarUrl?: string
  tags: string[]
  creator?: string
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
  /** The library, for a card that offers to switch or reference another. */
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
}

/** The model route and sampling a chat is running with. */
export interface GenerationSettings {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  topP?: number
  topK?: number
  minP?: number
  repetitionPenalty?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stop?: string[]
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
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
}

/**
 * One survived failure the host kept, as a debug page reads it.
 *
 * The wire shape of `@iris/app-service`'s diagnostic buffer. Declared here
 * rather than imported from the host so the page half compiles against the
 * protocol alone.
 */
export interface DebugReport {
  /** Monotonic, and the cursor a page pages with. */
  seq: number
  /** Unix epoch milliseconds. */
  at: number
  /** `mvu | template | prompt | script | variables | host`. */
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
