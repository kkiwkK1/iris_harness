/**
 * The store's segment-summary slice: what the tree map's hover cards show, and
 * the two ways of asking for more.
 *
 * **Summaries cost money, so nothing here asks on its own.** A hover only reads
 * (`chat.segmentSummaries`); a summary is made by `summarizeSegment`, which
 * only the card's 「总结这一段」 / 「重新总结」 call, or by
 * `summarizeAllSegments`, which only the header's 「总结所有分支段」 calls after
 * its confirm. The run is sequential — one request at a time, so a reader who
 * changes their mind stops the next one rather than ten in flight — and
 * cancellable.
 *
 * A slice file for the reason `branch-tree.ts` is one: `store.ts` spreads it in
 * and otherwise does not know it exists.
 *
 * @module iris-web/client/segment-summaries
 */

import type { ChatSegment, IrisClient, SegmentSummaryView } from '@iris/protocol'

import { getLanguage } from '../app/i18n/language.ts'
import { describeError } from './errors.ts'

/** The key a segment is tracked under while busy or failed: its lane and its bounds. */
export function segmentKey(segment: ChatSegment): string {
  return `${segment.chatId}:${String(segment.from)}-${String(segment.to)}`
}

/** A 「总结所有分支段」 run in progress. */
export interface SegmentRun {
  /** The conversation the run was started from; its Stop reaches the request in flight. */
  chatId: string
  done: number
  total: number
}

/** What the slice keeps. */
export interface SegmentSummaryState {
  /**
   * The family's summaries as `chat.segmentSummaries` last answered, and the
   * conversation it was asked from — dropped by the map when another
   * conversation's lineage is on screen.
   */
  segmentSummaries: { chatId: string, summaries: SegmentSummaryView[] } | undefined
  /** Segments with a request in flight, by `segmentKey`. */
  segmentBusy: readonly string[]
  /** The last failure per segment, by `segmentKey`, in the reader's language. */
  segmentErrors: Readonly<Record<string, string>>
  /** The 「总结所有分支段」 run, while it runs. */
  segmentRun: SegmentRun | undefined
}

/** What the slice does. */
export interface SegmentSummaryActions {
  /** Re-read the family's summaries. Free: nothing is generated. */
  loadSegmentSummaries(chatId: string): Promise<void>
  /** Summarize one segment with the model (billed), asked from `chatId`. */
  summarizeSegment(chatId: string, segment: ChatSegment): Promise<void>
  /** Summarize each of `segments` in turn, stopping early when cancelled. */
  summarizeAllSegments(chatId: string, segments: readonly ChatSegment[]): Promise<void>
  /** Stop a run: no further request starts, and the one in flight is stopped when no turn is. */
  cancelSegmentRun(): Promise<void>
}

/** The slice's starting state. */
export function segmentSummaryState(): SegmentSummaryState {
  return { segmentSummaries: undefined, segmentBusy: [], segmentErrors: {}, segmentRun: undefined }
}

/** What the slice needs from the store it lives in (structural, like `BranchTreeDeps`). */
export interface SegmentSummaryDeps {
  client: IrisClient
  get: () => SegmentSummaryState & { chatId: string | undefined, stream: unknown }
  set: (patch: Partial<SegmentSummaryState>) => void
}

/**
 * Build the slice's actions.
 * @param deps - the store's client and accessors.
 * @returns the actions.
 */
export function segmentSummaryActions({ client, get, set }: SegmentSummaryDeps): SegmentSummaryActions {
  /** Bumped by a cancel; a run compares its own generation before each request. */
  let generation = 0

  const merge = (chatId: string, view: SegmentSummaryView): void => {
    const current = get().segmentSummaries
    const kept = current?.chatId === chatId ? current.summaries : []
    const key = segmentKey(view)
    set({ segmentSummaries: { chatId, summaries: [...kept.filter(one => segmentKey(one) !== key), view] } })
  }

  const one = async (chatId: string, segment: ChatSegment): Promise<boolean> => {
    const key = segmentKey(segment)
    const { [key]: _dropped, ...errors } = get().segmentErrors
    set({ segmentBusy: [...get().segmentBusy, key], segmentErrors: errors })
    try {
      const { summary } = await client.call('chat.summarizeSegment', {
        chatId,
        fromFloor: segment.from,
        toFloor: segment.to,
        lane: segment.chatId,
      })
      merge(chatId, summary)
      return true
    } catch (error: unknown) {
      set({ segmentErrors: { ...get().segmentErrors, [key]: describeError(error, getLanguage()) } })
      return false
    } finally {
      set({ segmentBusy: get().segmentBusy.filter(busy => busy !== key) })
    }
  }

  return {
    async loadSegmentSummaries(chatId) {
      try {
        const { summaries } = await client.call('chat.segmentSummaries', { chatId })
        // Last write wins by chat, as `loadTree` does.
        if (get().chatId === chatId) set({ segmentSummaries: { chatId, summaries } })
      } catch {
        // A read that failed leaves the cards saying "not summarized yet",
        // which is what they would say anyway; the tree's own read reports.
      }
    },

    async summarizeSegment(chatId, segment) {
      await one(chatId, segment)
    },

    async summarizeAllSegments(chatId, segments) {
      if (get().segmentRun !== undefined) return
      const mine = ++generation
      set({ segmentRun: { chatId, done: 0, total: segments.length } })
      try {
        for (const [at, segment] of segments.entries()) {
          if (generation !== mine) break
          // A failed segment keeps its error on its card and the run goes on:
          // one refusal (a segment of hidden floors only) is not a reason to
          // leave the rest unsummarized. A cancel ends it.
          await one(chatId, segment)
          if (generation !== mine) break
          set({ segmentRun: { chatId, done: at + 1, total: segments.length } })
        }
      } finally {
        if (generation === mine) set({ segmentRun: undefined })
      }
    },

    async cancelSegmentRun() {
      const run = get().segmentRun
      generation += 1
      set({ segmentRun: undefined })
      // Stop the request in flight too — through `chat.abort`, the per-entry
      // side-call registry's own switch — but only when no turn is streaming,
      // because the same switch stops the reader's reply.
      if (run !== undefined && get().stream === undefined) {
        try {
          await client.call('chat.abort', { chatId: run.chatId })
        } catch {
          // Nothing to stop is the outcome asked for either way.
        }
      }
    },
  }
}
