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
  /** Size of the body, so a list can say what it is about to run. */
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
   */
  extensionSettings: Record<string, unknown>
  /** Current variable state, for a card reading MVU's store. */
  variables: Record<string, unknown>
}

/** Where a script's injected prompt goes. Mirrors upstream's positions. */
export type ScriptPromptPosition = 'before' | 'after' | 'at-depth'

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
