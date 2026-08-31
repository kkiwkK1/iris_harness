/**
 * Prompt assembly for Iris.
 *
 * @module @iris/pipeline
 */

export { assemble, injectAtDepth, renderSystem, trimHistory } from './assemble.ts'

export type {
  AssembleInput,
  AssembleResult,
  Budget,
  Contribution,
  HistoryEntry,
  Overflow,
  PipelineMessage,
  Placement,
  Role,
  TokenCounter,
} from './types.ts'
