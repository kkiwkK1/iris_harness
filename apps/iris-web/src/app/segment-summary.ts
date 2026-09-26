/**
 * The tree map's segment-summary decisions, as functions `node --test` can load.
 *
 * The segments themselves come from `@iris/protocol`'s `segmentsOf`, the same
 * function the host cuts, keys and summarizes by — so a hover card and the
 * request it sends name the same floors. This module only maps them onto what
 * the map draws: which rows a segment spans, which segments a folded row
 * stands for, and which segments 「总结所有分支段」 would spend a request on.
 *
 * @module iris-web/app/segment-summary
 */

import { ownerOfFloor, segmentAt, type ChatSegment, type ChatTreeView, type SegmentSummaryView } from '@iris/protocol'

import { segmentKey } from '../client/segment-summaries.ts'
import type { TreeLayout, TreeRow } from './tree-map.ts'

/**
 * A segment's stored summary, if the family has one.
 * @param summaries - `chat.segmentSummaries`' answer.
 * @param segment - the segment.
 * @returns the summary, fresh or stale, or undefined.
 */
export function summaryOf(summaries: readonly SegmentSummaryView[], segment: ChatSegment): SegmentSummaryView | undefined {
  const key = segmentKey(segment)
  return summaries.find(one => segmentKey(one) === key)
}

/**
 * What 「总结所有分支段」 would summarize: every segment with no summary or a
 * stale one, in the tree's order. A current summary is never paid for twice.
 * @param segments - the family's segments.
 * @param summaries - the family's summaries.
 * @returns the segments to send, and how many of them are re-summaries.
 */
export function pendingSegments(
  segments: readonly ChatSegment[],
  summaries: readonly SegmentSummaryView[],
): { segments: ChatSegment[], stale: number } {
  let stale = 0
  const out = segments.filter(segment => {
    const found = summaryOf(summaries, segment)
    if (found?.stale === true) stale += 1
    return found === undefined || found.stale
  })
  return { segments: out, stale }
}

/**
 * The row that draws one floor: its own row, or the folded run that holds it.
 * @param rows - the layout's rows.
 * @param floor - a floor.
 * @returns the row index, or -1.
 */
export function rowOfFloor(rows: readonly TreeRow[], floor: number): number {
  return rows.findIndex(row => (row.kind === 'floor' ? row.floor === floor : row.from <= floor && floor <= row.to))
}

/** One segment's place on the drawing: its lane and the rows it runs between. */
export interface SegmentHit {
  segment: ChatSegment
  lane: number
  /** Row index of its first floor. */
  top: number
  /** Row index of its last floor. */
  bottom: number
}

/**
 * Where each segment is drawn, for the hover targets along the lanes.
 * @param layout - the drawing.
 * @param segments - the family's segments.
 * @returns one entry per segment whose lane and rows are on the drawing.
 */
export function segmentHits(layout: TreeLayout, segments: readonly ChatSegment[]): SegmentHit[] {
  const lanes = new Map(layout.lanes.map(lane => [lane.chatId, lane.lane]))
  const hits: SegmentHit[] = []
  for (const segment of segments) {
    const lane = lanes.get(segment.chatId)
    const top = rowOfFloor(layout.rows, segment.from)
    const bottom = rowOfFloor(layout.rows, segment.to)
    if (lane === undefined || top < 0 || bottom < 0) continue
    hits.push({ segment, lane, top, bottom })
  }
  return hits
}

/**
 * The segments a folded row stands for: one per lane the run is drawn on.
 * @param row - a folded run.
 * @param segments - the family's segments.
 * @returns each lane's segment holding the run, in the row's lane order.
 */
export function gapSegments(row: Extract<TreeRow, { kind: 'gap' }>, segments: readonly ChatSegment[]): ChatSegment[] {
  return row.lanes.flatMap(lane => {
    const found = segmentAt(segments, lane.chatId, row.from)
    return found === undefined ? [] : [found]
  })
}

/**
 * The segment one floor of one conversation belongs to, on whichever lane owns it.
 * @param tree - the lineage.
 * @param segments - its segments.
 * @param chatId - the conversation a label or dot stands for.
 * @param floor - the floor.
 * @returns the segment, or undefined when no lane owns that floor.
 */
export function segmentOfFloor(
  tree: Pick<ChatTreeView, 'chats'>,
  segments: readonly ChatSegment[],
  chatId: string,
  floor: number,
): ChatSegment | undefined {
  const owner = ownerOfFloor(tree, chatId, floor)
  return owner === undefined ? undefined : segmentAt(segments, owner, floor)
}
