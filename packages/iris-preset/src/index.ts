/**
 * SillyTavern preset compatibility.
 *
 * @module @iris/preset
 */

export {
  BUILTIN_IDENTIFIERS,
  GLOBAL_ORDER_ID,
  LEGACY_ORDER_ID,
  HISTORY_IDENTIFIER,
  normalizeGenerationType,
  resolveOrder,
  resolvePreset,
  shouldTrigger,
  type BuiltinIdentifier,
  type ChatCompletionPreset,
  type MarkerSources,
  type PromptItem,
  type PromptOrder,
  type ResolveOptions,
} from './chat-completion.ts'

export {
  alignBlocks,
  blocksOf,
  compareBodies,
  compareFields,
  firstDivergence,
  mergeSystemRuns,
  messagesOf,
  renderReport,
  type BlockAlignment,
  type Divergence,
  type FieldRow,
  type Framing,
  type ParityMessage,
  type ParityOptions,
  type ParityReport,
  type RequestBody,
} from './parity.ts'
