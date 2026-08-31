/**
 * SillyTavern world books: the data contract and the activation engine.
 *
 * @module @iris/lorebook
 */

export {
  DEFAULT_DEPTH,
  DEFAULT_ORDER,
  DEFAULT_WEIGHT,
  MAX_SCAN_DEPTH,
  anchorPosition,
  promptRole,
  worldInfoLogic,
  worldInfoPosition,
  type AnchorPosition,
  type CharacterBook,
  type CharacterBookEntry,
  type CharacterFilter,
  type Lorebook,
  type LorebookEntry,
  type PromptRole,
  type WorldInfoLogic,
  type WorldInfoPosition,
} from './types.ts'

export {
  LorebookParseError,
  createEntry,
  entryDefaults,
  fromCharacterBook,
  normalizeEntry,
  parseDecorators,
  parseLorebook,
  serializeLorebook,
  toCharacterBook,
} from './parse.ts'

export {
  countMatchingKeys,
  escapeRegex,
  evaluateSelectiveLogic,
  findMatchingKey,
  matchKey,
  parseRegexFromString,
  type KeyMatchOptions,
} from './matching.ts'

export {
  activateEntries,
  computeBudget,
  defaultActivationSettings,
  mulberry32,
  scanState,
  stringHash,
  type ActivateOptions,
  type ActivationResult,
  type ActivationSettings,
  type CharacterContext,
  type DepthBucket,
  type GlobalScanData,
  type PositionBuckets,
  type PreparedEntry,
  type ScanEntry,
  type ScanState,
  type TimedEffect,
  type TimedEffectState,
} from './activate.ts'
