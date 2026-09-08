/**
 * Prompt assembly for Iris.
 *
 * @module @iris/pipeline
 */

export {
  assemble,
  DEFAULT_TRIM_BLOCK_FLOORS,
  injectAtDepth,
  itemize,
  renderSystem,
  SYSTEM_JOIN,
  systemSegments,
  trimHistory,
} from './assemble.ts'

export type {
  AssembledItem,
  AssembleInput,
  AssembleResult,
  Budget,
  Contribution,
  HistoryEntry,
  Overflow,
  PipelineMessage,
  Placement,
  Role,
  SystemSegment,
  TokenCounter,
} from './types.ts'
