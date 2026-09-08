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
  MEMBER_JOIN,
  renderSystem,
  SYSTEM_JOIN,
  systemSegments,
  trimHistory,
} from './assemble.ts'

export type {
  AssembledItem,
  AssembledMember,
  AssembleInput,
  AssembleResult,
  Budget,
  Contribution,
  ContributionMember,
  HistoryEntry,
  Overflow,
  PipelineMessage,
  Placement,
  Role,
  SystemSegment,
  TokenCounter,
} from './types.ts'
