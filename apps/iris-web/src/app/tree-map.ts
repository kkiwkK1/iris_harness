/**
 * The tree map's decisions, as functions `node --test` can load.
 *
 * `chat.tree` answers with a lineage — one node per conversation, each with a
 * fork point in its parent's floor numbers. This module turns that into what
 * the margin draws: a **vertical git graph**, floor 0 at the top and one lane
 * per conversation, with every linear run that nothing forks from collapsed
 * into a single "N floors" segment. `TreeMap.tsx` only renders the result.
 *
 * Kept apart from the component for the reason `state-panel.ts` is: a `.tsx`
 * cannot be loaded by the test runner, so a decision left in the component is
 * a decision nothing asserts.
 *
 * @module iris-web/app/tree-map
 */

import type { ChatTreeNode, ChatTreeView } from '@iris/protocol'

/** One conversation's column. */
export interface TreeLane {
  chatId: string
  title: string
  /** Column index, 0 for the root. */
  lane: number
  /** The first floor drawn on this lane; earlier floors are on an ancestor's lane. */
  start: number
  /** The conversation's newest floor. */
  end: number
  /** The parent's column, absent on the root. */
  parentLane?: number
  /** The floor on the parent's lane the connector leaves from. */
  from?: number
  /** True for the conversation on screen. */
  current: boolean
  /** How far down this lane the on-screen conversation's history runs; absent when it does not use this lane. */
  pathEnd?: number
  /** Set when the file could not be read. */
  unreadable: boolean
}

/** One dot on the graph. */
export interface TreeNodeCell {
  lane: number
  chatId: string
  floor: number
  /** Readings on this floor, as the host counted them. */
  swipes: number
  /** Conversations leaving from this floor of this lane. */
  forks: number
  /** The lane's newest floor, which carries the conversation's title. */
  head: boolean
  /** The floor the reader is on. */
  focus: boolean
}

/** A row of the drawing: one floor, or a collapsed run of floors. */
export type TreeRow =
  | { kind: 'floor', floor: number, nodes: TreeNodeCell[] }
  | { kind: 'gap', from: number, to: number, count: number, lanes: { lane: number, chatId: string }[] }

/** The whole drawing. */
export interface TreeLayout {
  lanes: TreeLane[]
  rows: TreeRow[]
}

/**
 * The first floor a conversation's own lane shows.
 *
 * `fork.shared` in general. A branch that has not written anything of its own
 * yet (every floor it holds is shared) still gets a lane with one dot — its
 * newest floor — or it would have no place on the map to click.
 */
function laneStart(node: ChatTreeNode): number {
  if (node.fork === undefined) return 0
  return Math.max(0, Math.min(node.fork.shared, node.floorCount - 1))
}

/**
 * The lane that shows a given floor of a conversation's history.
 * @param lanes - lanes by chat id.
 * @param parents - parent chat id by chat id.
 * @param chatId - the conversation.
 * @param floor - a floor of it.
 * @returns the owning lane, or undefined when the floor is not drawn anywhere.
 */
function ownerOf(
  lanes: ReadonlyMap<string, TreeLane>,
  parents: ReadonlyMap<string, string | undefined>,
  chatId: string,
  floor: number,
): TreeLane | undefined {
  const seen = new Set<string>()
  for (let at: string | undefined = chatId; at !== undefined && !seen.has(at); at = parents.get(at)) {
    seen.add(at)
    const lane = lanes.get(at)
    if (lane !== undefined && floor >= lane.start) return lane.end >= floor ? lane : undefined
  }
  return undefined
}

/**
 * Lay a lineage out as rows and lanes.
 * @param tree - the host's answer.
 * @param focus - the conversation and floor the reader is on; defaults to the
 *   tree's own `current`.
 * @returns the drawing.
 */
export function layoutTree(tree: ChatTreeView, focus: { chatId: string, floor: number } = tree.current): TreeLayout {
  const lanes = new Map<string, TreeLane>()
  const parents = new Map<string, string | undefined>()
  tree.chats.forEach((node, lane) => {
    parents.set(node.chatId, node.parentChatId)
    const start = laneStart(node)
    // The connector leaves at the last floor the two hold in common, and at the
    // lane's own first floor when the branch has no floor of its own — from
    // whichever lane **draws** that floor, which is the parent's only when the
    // parent wrote it: a branch cut at a floor its parent had itself copied
    // leaves from the ancestor lane that floor is on.
    const shared = node.fork?.shared ?? 0
    const wanted = node.parentChatId === undefined ? undefined : start === shared ? Math.max(0, shared - 1) : start
    const parent = node.parentChatId === undefined || wanted === undefined
      ? undefined
      : ownerOf(lanes, parents, node.parentChatId, wanted) ?? lanes.get(node.parentChatId)
    const from = parent === undefined ? undefined : wanted
    lanes.set(node.chatId, {
      chatId: node.chatId,
      title: node.title,
      lane,
      start,
      end: Math.max(start, node.floorCount - 1),
      ...parent === undefined ? {} : { parentLane: parent.lane },
      ...from === undefined ? {} : { from: Math.min(from, parent?.end ?? from) },
      current: node.chatId === focus.chatId,
      unreadable: node.unreadable === true,
    })
  })

  // The on-screen conversation's history, lane by lane up to the root. Each
  // floor of it is drawn on exactly one lane — the nearest one whose own run
  // reaches it — so walking up, a lane holds the history only below the
  // first floor a lane beneath it already drew.
  const seen = new Set<string>()
  let limit = Number.POSITIVE_INFINITY
  for (let at: string | undefined = focus.chatId; at !== undefined && !seen.has(at); at = parents.get(at)) {
    seen.add(at)
    const lane = lanes.get(at)
    if (lane === undefined) break
    if (lane.start > limit) continue
    lane.pathEnd = Math.min(lane.end, limit)
    limit = Math.min(limit, lane.start - 1)
  }

  // Which floors must be drawn as their own row, per lane.
  const keys = new Map<number, Set<number>>()
  const key = (lane: number, floor: number): void => {
    const set = keys.get(lane) ?? new Set<number>()
    set.add(floor)
    keys.set(lane, set)
  }
  const forks = new Map<string, number>()
  for (const lane of lanes.values()) {
    key(lane.lane, lane.start)
    key(lane.lane, lane.end)
  }
  for (const node of tree.chats) {
    const lane = lanes.get(node.chatId)
    if (lane?.parentLane === undefined || lane.from === undefined || node.fork === undefined) continue
    key(lane.parentLane, lane.from)
    // The badge floor too: for a branch cut from another reading it is one
    // below the connector, and it is the floor a reader looks for. On the lane
    // that draws it, for the reason the connector above gives.
    const declared = lanes.get(node.parentChatId ?? '')
    const badge = Math.min(node.fork.floor, declared?.end ?? node.fork.floor)
    const parent = ownerOf(lanes, parents, node.parentChatId ?? '', badge)
    if (parent !== undefined) {
      key(parent.lane, badge)
      const at = `${String(parent.lane)}:${String(badge)}`
      forks.set(at, (forks.get(at) ?? 0) + 1)
    }
  }
  const focusLane = ownerOf(lanes, parents, focus.chatId, focus.floor)
  if (focusLane !== undefined) key(focusLane.lane, focus.floor)

  const byLane = [...lanes.values()]
  const swipesOf = new Map(tree.chats.map(node => [node.chatId, node.swipes]))
  const floors = [...new Set([...keys.values()].flatMap(set => [...set]))].sort((a, b) => a - b)

  const rows: TreeRow[] = []
  let previous: number | undefined
  for (const floor of floors) {
    if (previous !== undefined && floor - previous > 1) {
      const from = previous + 1
      const to = floor - 1
      rows.push({
        kind: 'gap',
        from,
        to,
        count: to - from + 1,
        lanes: byLane.filter(lane => lane.start <= from && lane.end >= to).map(lane => ({ lane: lane.lane, chatId: lane.chatId })),
      })
    }
    const nodes: TreeNodeCell[] = []
    for (const lane of byLane) {
      if (!(keys.get(lane.lane)?.has(floor) ?? false) || floor < lane.start || floor > lane.end) continue
      nodes.push({
        lane: lane.lane,
        chatId: lane.chatId,
        floor,
        swipes: swipesOf.get(lane.chatId)?.[floor] ?? 1,
        forks: forks.get(`${String(lane.lane)}:${String(floor)}`) ?? 0,
        head: floor === lane.end,
        focus: focusLane?.lane === lane.lane && floor === focus.floor,
      })
    }
    rows.push({ kind: 'floor', floor, nodes })
    previous = floor
  }

  return { lanes: byLane, rows }
}

/** Another conversation that passes through a floor and goes its own way there. */
export interface BranchLink {
  chatId: string
  title: string
  /** How it relates to the conversation on screen. */
  relation: 'child' | 'parent' | 'sibling'
}

/**
 * The conversations that leave from one floor of the conversation on screen —
 * what the floor's "⑂N" badge counts and lists.
 *
 * A floor is shared by every conversation that copied it, so the answer is not
 * only this conversation's own children: from a branch's fork floor the
 * parent is one more way to go on, and so is every sibling cut at that floor.
 * @param tree - the lineage.
 * @param chatId - the conversation on screen.
 * @param floor - a floor of it.
 * @returns the other conversations: the parent first, when it is one, then the branches.
 */
export function branchesAt(tree: ChatTreeView | undefined, chatId: string, floor: number): BranchLink[] {
  if (tree === undefined) return []
  const byId = new Map(tree.chats.map(node => [node.chatId, node]))
  const self = byId.get(chatId)
  if (self === undefined) return []

  // The conversation whose floor this is, in the lineage: walk up while the
  // floor is at or above the fork this chat was cut at — the fork floor itself
  // belongs to the parent, whose floor the branch was made from.
  let owner = self
  const path = new Set<string>([self.chatId])
  while (owner.fork !== undefined && owner.parentChatId !== undefined && floor <= owner.fork.floor) {
    const up = byId.get(owner.parentChatId)
    if (up === undefined || path.has(up.chatId)) break
    path.add(up.chatId)
    owner = up
  }

  const links: BranchLink[] = []
  // Everything cut from the owner at this floor, except the reader's own line.
  for (const node of tree.chats) {
    if (node.parentChatId !== owner.chatId || node.fork?.floor !== floor || path.has(node.chatId)) continue
    links.push({ chatId: node.chatId, title: node.title, relation: owner.chatId === chatId ? 'child' : 'sibling' })
  }
  // And the owner itself, when the reader's line leaves it right here: going
  // on in the parent is one more road from this floor.
  if (owner.chatId !== chatId) {
    const onPath = tree.chats.find(node => node.parentChatId === owner.chatId && path.has(node.chatId))
    if (onPath?.fork?.floor === floor) links.unshift({ chatId: owner.chatId, title: owner.title, relation: 'parent' })
  }
  return links
}
