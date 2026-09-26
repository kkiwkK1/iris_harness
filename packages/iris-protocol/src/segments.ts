/**
 * A lineage's **branch segments**: the runs of floors between fork points.
 *
 * Read off a `chat.tree` graph and nothing else, so the tree map (which hovers
 * a segment) and the host (which keys, hashes and summarizes one) cut the same
 * floors: in 黑兽, a root of floors 0–32 with a branch made from floor 30 is
 * three segments — the root's 0–30 that both conversations share, the root's
 * own 31–32, and the branch's own 31–32.
 *
 * The rule, in the graph's own terms:
 *
 * - A conversation **owns** the floors of its own lane: `fork.shared` up to its
 *   newest floor (all of them, for the root). Floors before that are its
 *   parent's copy, drawn and summarized on the lane that owns them.
 * - Every branch **cuts** the lane that owns the floor it leaves from: a branch
 *   whose own floors start at `shared` ends a segment at `shared - 1` on
 *   whichever ancestor owns that floor, and a new one starts at `shared`. For an
 *   ordinary branch that is its fork floor (`floor + 1 = shared`); for a swipe
 *   turned into a branch (`shared = floor`) the parent's other reading of that
 *   floor begins a segment of its own, because the two lanes part *at* it.
 * - A branch that has written nothing of its own still cuts its parent — it is
 *   a fork point on the map, with a 「⑂」 badge — and owns no segment.
 *
 * Pure, over the protocol's own types, so both halves can load it.
 *
 * @module @iris/protocol/segments
 */

import type { ChatSegment, ChatTreeNode, ChatTreeView } from './views.ts'

/** The floors a conversation owns, or undefined when it owns none. */
function ownRange(node: Pick<ChatTreeNode, 'fork' | 'floorCount'>): { from: number, to: number } | undefined {
  const from = node.fork === undefined ? 0 : Math.max(0, node.fork.shared)
  const to = node.floorCount - 1
  return from > to ? undefined : { from, to }
}

/**
 * Which conversation's lane owns one floor of a conversation's history.
 * @param tree - the lineage.
 * @param chatId - a conversation of it.
 * @param floor - a floor of that conversation's history.
 * @returns the owning conversation, or undefined when no lane on the way to the root draws that floor.
 */
export function ownerOfFloor(tree: Pick<ChatTreeView, 'chats'>, chatId: string, floor: number): string | undefined {
  const byId = new Map(tree.chats.map(node => [node.chatId, node]))
  const seen = new Set<string>()
  for (let at = byId.get(chatId); at !== undefined && !seen.has(at.chatId); at = byId.get(at.parentChatId ?? '')) {
    seen.add(at.chatId)
    const own = ownRange(at)
    if (own !== undefined && floor >= own.from) return floor <= own.to ? at.chatId : undefined
    if (at.parentChatId === undefined) break
  }
  return undefined
}

/**
 * Every branch segment of a lineage.
 * @param tree - the lineage, as `chat.tree` answers it.
 * @returns the segments, in the tree's lane order and top down within a lane.
 */
export function segmentsOf(tree: Pick<ChatTreeView, 'chats'>): ChatSegment[] {
  const cuts = new Map<string, Set<number>>()
  for (const node of tree.chats) {
    if (node.fork === undefined || node.parentChatId === undefined) continue
    const start = node.fork.shared
    if (start <= 0) continue
    const owner = ownerOfFloor(tree, node.parentChatId, start - 1)
    if (owner === undefined) continue
    const set = cuts.get(owner) ?? new Set<number>()
    set.add(start)
    cuts.set(owner, set)
  }

  const segments: ChatSegment[] = []
  for (const node of tree.chats) {
    const own = ownRange(node)
    if (own === undefined) continue
    const starts = [...cuts.get(node.chatId) ?? []].filter(at => at > own.from && at <= own.to).sort((a, b) => a - b)
    let from = own.from
    for (const at of starts) {
      segments.push({ chatId: node.chatId, from, to: at - 1 })
      from = at
    }
    segments.push({ chatId: node.chatId, from, to: own.to })
  }
  return segments
}

/**
 * The segment of one lane that holds a floor.
 * @param segments - `segmentsOf`'s answer.
 * @param chatId - the lane's conversation.
 * @param floor - a floor on that lane.
 * @returns the segment, or undefined when the lane does not own that floor.
 */
export function segmentAt(segments: readonly ChatSegment[], chatId: string, floor: number): ChatSegment | undefined {
  return segments.find(segment => segment.chatId === chatId && segment.from <= floor && floor <= segment.to)
}
