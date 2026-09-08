/**
 * The Iris turn driver.
 *
 * @module @iris/turn
 */

export {
  slotsOf,
  squashSystemRuns,
  TurnDriver,
  TurnError,
  type AssembledSlot,
  type GenerateEvents,
  type StreamFn,
  type TurnDriverOptions,
} from './driver.ts'

export {
  historyFromSession,
  type HistoryOptions,
  type HistoryProjection,
} from './history.ts'

// Re-exported so that importing `@iris/turn` brings the `GenerateOptions.layout`
// augmentation into the program: the host reads that field, and a consumer that
// only imported the driver would find it typed away.
export type { LayoutPart, LayoutSlot, PromptLayout } from './layout.ts'
