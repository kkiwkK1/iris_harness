/**
 * Prompt assembly for Iris.
 *
 * @module @iris/pipeline
 */

export { assemble, injectAtDepth, itemize, renderSystem, trimHistory } from './assemble.ts'

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
  TokenCounter,
} from './types.ts'
