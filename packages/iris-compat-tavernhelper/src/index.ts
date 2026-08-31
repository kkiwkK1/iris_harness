/**
 * Tavern Helper (酒馆助手) compatibility.
 *
 * @module @iris/compat-tavernhelper
 */

export {
  createTavernHelper,
  flattenForCard,
  UnsupportedApiError,
  type GenerateConfig,
  type TavernHelperApi,
  type TavernHelperHost,
} from './api.ts'

export {
  chatMessages,
  resolveRange,
  selectMessages,
  type ChatMessage,
  type ChatMessageSwiped,
  type GetChatMessagesOptions,
  type MessageRole,
  type SpeakerNames,
} from './chat-messages.ts'

export {
  parseSlashCommands,
  splitPipeline,
  unescapeArgument,
  UnsupportedSlashCommandError,
  type SlashCommand,
} from './slash.ts'

export {
  EventBus,
  IFRAME_EVENTS,
  MVU_EVENTS,
  TAVERN_EVENTS,
  type Listener,
  type Subscription,
} from './events.ts'
