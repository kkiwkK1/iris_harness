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
} from '@iris/compat-tavernhelper-core'

export {
  MACRO_SCOPES,
  expandHelperMacros,
  hasHelperMacros,
  isHelperMacroName,
  omitDollarKeys,
  readMacroPath,
  unescapePath,
  type MacroScope,
  type MacroSources,
} from './macros.ts'

// —— family③: preset ——
/*
 * Re-exported from the core package rather than reimplemented, exactly as the
 * event tables above are and for the same reason: the frame publishes
 * `default_preset` and the three `isPreset*Prompt` guards to card scripts as
 * runtime values, the host classifies every prompt with the *same* guards when
 * it writes a card's edited preset back into a file, and two copies that
 * disagree by one identifier give a card a prompt the guard calls normal and
 * the file records as a marker — consistent on both sides, wrong as a pair,
 * silent.
 *
 * The host reaches them through this package because this is the host-side
 * compat layer it already depends on; the frame reaches them through the core
 * package directly, which is the only one on the browser's import allowlist.
 */
export {
  TH_DEFAULT_PRESET,
  DuplicatePresetPromptError,
  FRAME_OMITTED_EXTENSIONS,
  OMITTED_EXTENSIONS_KEY,
  PLACEHOLDER_PROMPT_DEFAULT_ORDER,
  PLACEHOLDER_PROMPT_IDS,
  SYSTEM_PROMPT_IDS,
  TH_ORDER_CHARACTER_ID,
  fromTavernHelperPreset,
  isPresetNormalPrompt,
  isPresetPlaceholderPrompt,
  isPresetSystemPrompt,
  mergePresetDefaults,
  restoreOmittedExtensions,
  toTavernHelperPreset,
  trimPresetForFrame,
  type PresetFile,
  type PresetFileOrder,
  type PresetFilePrompt,
  type TavernHelperPreset,
  type TavernHelperPresetPrompt,
  type TavernHelperPresetSettings,
} from '@iris/compat-tavernhelper-core'
// —— family③ end ——
