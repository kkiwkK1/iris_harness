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
