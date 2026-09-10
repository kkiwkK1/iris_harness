/**
 * The dependency-free heart of the Tavern Helper compat layer.
 *
 * Split out of `@iris/compat-tavernhelper` for one reason: the browser frame
 * needs THE SAME copy of the event vocabulary the host uses. A card subscribes
 * by literal string — `eventOn(tavern_events.MESSAGE_RECEIVED, …)` — so a
 * hand-copied table that drifts by one character produces a listener that
 * never fires, with no error anywhere. Sharing the module is the only version
 * of "the same" that survives maintenance.
 *
 * This package must stay dependency-free. It is on the browser's import
 * allowlist precisely because it can drag nothing in behind it, and a test
 * pins that property. The slash-command grammar deliberately does NOT live
 * here: it is equally pure, but publishing it to the browser would invite a
 * second parse site, and the escaping rules exist in exactly one place — the
 * host — by ruling.
 *
 * @module @iris/compat-tavernhelper-core
 */

export {
  EventBus,
  IFRAME_EVENTS,
  MVU_EVENTS,
  TAVERN_EVENTS,
  type Listener,
  type Subscription,
} from './events.ts'
export { parseRegexFromString } from './regex.ts'
export { stringHash } from './hash.ts'
// —— family③: preset ——
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
} from './preset.ts'
// —— family③ end ——
