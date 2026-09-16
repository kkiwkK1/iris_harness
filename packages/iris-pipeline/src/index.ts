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
  project,
  renderSystem,
  SYSTEM_JOIN,
  systemSegments,
  trimHistory,
} from './assemble.ts'

export type {
  AssembledItem,
  AssembledMember,
  AssembledMessageSlot,
  AssembledPlacement,
  AssembleInput,
  AssembleResult,
  Budget,
  Contribution,
  ContributionMember,
  ContributionSource,
  ContributionZeroReason,
  HistoryEntry,
  Overflow,
  PipelineMessage,
  Placement,
  Role,
  SystemSegment,
  TokenCounter,
} from './types.ts'
