/**
 * Character cards: the V1/V2/V3 data model and the PNG `tEXt` codec.
 *
 * @module @iris/character
 */

export {
  CharacterCardError,
  normalizeCard,
  toV2,
  toV3,
} from './card.ts'

export {
  PngError,
  crc32,
  decodeCardPng,
  decodeTextChunk,
  encodeCardPng,
  encodeTextChunk,
  parsePngChunks,
  readCardChunks,
  serializePngChunks,
  type CardChunks,
  type PngChunk,
} from './png.ts'

export type {
  CardAsset,
  CardData,
  CardExtensions,
  CardFile,
  CardSpec,
  CharacterBook,
  CharacterBookEntry,
  CharacterCard,
  DepthPrompt,
  PromptRole,
  RegexScriptData,
} from './types.ts'
