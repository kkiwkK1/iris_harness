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
  /** The lane's colour: a palette slot (`laneHues`), or {@link TRUNK} for a root. */
  hue: number
  /** How active the conversation is, and the stroke width that follows (`laneActivity`). */
  activity: LaneActivity
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
  const hues = laneHues(tree.chats)
  const newest = familyNewest(tree)
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
      hue: hues.get(node.chatId) ?? TRUNK,
      activity: laneActivity(node, newest),
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

// ——— lane colour ———————————————————————————————————————————————

/**
 * How many branch colours there are: `--iris-lane-0` … `--iris-lane-5` in
 * `tree-map.css`, each derived from the theme's own tokens, so 雪, 墨 and 宣
 * each paint them on their own paper.
 */
export const LANE_HUES = 6
/** The slot a root takes: the trunk, drawn in the neutral rule colour, like a git graph's main line. */
export const TRUNK = -1

/**
 * FNV-1a over the id's UTF-16 code units: a small, stable, well-spread hash.
 * @param text - a chat id.
 * @returns an unsigned 32-bit hash.
 */
export function hashId(text: string): number {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Each conversation's lane colour, from nothing but the family's ids and
 * parent links — so the tree map (from `chat.tree`) and the sidebar (from
 * `chat.list`) compute the same colour for the same chat without either
 * asking the other.
 *
 * A root is the trunk. A branch takes the slot its id hashes to; inside one
 * family, a slot already taken passes to the next free one, visiting the
 * branches in the order of their hashes (then ids), so the result does not
 * depend on how a list happened to be sorted. A branch keeps its colour for
 * as long as no branch with a lower hash wants the same slot, and two branches
 * of one family share a colour only once the family has more branches than
 * there are colours.
 * @param rows - conversations with their parent links, in any order.
 * @returns the slot per chat id: 0 … LANE_HUES-1, or {@link TRUNK}.
 */
export function laneHues(rows: readonly { chatId: string, parentChatId?: string | undefined }[]): Map<string, number> {
  const parentOf = new Map(rows.map(row => [row.chatId, row.parentChatId]))
  /** The root a chat's parent links lead to, among these rows; a cycle is cut at its first repeat. */
  const rootOf = (chatId: string): string => {
    const seen = new Set<string>([chatId])
    let root = chatId
    for (let up = parentOf.get(root); up !== undefined && parentOf.has(up) && !seen.has(up); up = parentOf.get(up)) {
      seen.add(up)
      root = up
    }
    return root
  }
  const families = new Map<string, string[]>()
  const hues = new Map<string, number>()
  for (const row of rows) {
    const root = rootOf(row.chatId)
    if (root === row.chatId) {
      hues.set(row.chatId, TRUNK)
      continue
    }
    const members = families.get(root) ?? []
    members.push(row.chatId)
    families.set(root, members)
  }
  for (const members of families.values()) {
    const taken = new Set<number>()
    const ordered = [...new Set(members)]
      .map(chatId => ({ chatId, hash: hashId(chatId) }))
      .sort((a, b) => a.hash - b.hash || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0))
    for (const { chatId, hash } of ordered) {
      let slot = hash % LANE_HUES
      if (taken.size < LANE_HUES) {
        while (taken.has(slot)) slot = (slot + 1) % LANE_HUES
      }
      taken.add(slot)
      hues.set(chatId, slot)
    }
  }
  return hues
}

// ——— line weight: "the more active, the thicker" ————————————————————

/** The thinnest and thickest a lane is drawn, in CSS pixels. */
export const WEIGHT_MIN = 1.5
export const WEIGHT_MAX = 4
/** Floors of its own at which the floor half of the score is full (log scale up to it). */
export const FLOORS_FULL = 64
/** Days in which the recency half of the score halves. */
export const RECENCY_HALF_LIFE_DAYS = 7
/** The floor half's share of the score; recency has the rest. */
export const FLOORS_SHARE = 0.7

const DAY_MS = 86_400_000

/** One lane's activity, with every term the tooltip states. */
export interface LaneActivity {
  /** Floors the conversation wrote itself: everything past its fork (all of them, for a root). */
  own: number
  /** How long before the family's newest activity this one was last active, in days. */
  ageDays: number
  /** 0 … 1. */
  score: number
  /** The stroke width: WEIGHT_MIN + score × (WEIGHT_MAX − WEIGHT_MIN), to 0.01 px. */
  width: number
}

/**
 * The newest activity anywhere in a lineage: the clock recency is read
 * against. Taken from the tree rather than from `Date.now()`, so a layout is a
 * pure function of the host's answer — the same tree draws the same widths
 * tomorrow, and a family nobody has touched for a month still shows which of
 * its branches was the lively one.
 * @param tree - the lineage.
 * @returns epoch milliseconds, 0 for an empty tree.
 */
export function familyNewest(tree: Pick<ChatTreeView, 'chats'>): number {
  return tree.chats.reduce((newest, node) => Math.max(newest, node.updatedAt), 0)
}

/**
 * How active a conversation is, and how thick its lane is drawn.
 *
 * `score = 0.7 × min(1, log2(1 + own) / log2(1 + 64)) + 0.3 × 0.5^(ageDays / 7)`:
 * mostly how much it grew on its own (on a log scale, so the tenth floor
 * counts more than the hundredth), partly how recently it was touched. The
 * width is that score on the bounded 1.5–4 px range. Deterministic: the same
 * node and clock always give the same answer.
 * @param node - a conversation of the tree.
 * @param newest - the family's newest activity (`familyNewest`).
 * @returns the activity.
 */
export function laneActivity(node: Pick<ChatTreeNode, 'floorCount' | 'fork' | 'updatedAt'>, newest: number): LaneActivity {
  const own = Math.max(0, node.floorCount - (node.fork?.shared ?? 0))
  const ageDays = Math.max(0, newest - node.updatedAt) / DAY_MS
  const floors = Math.min(1, Math.log2(1 + own) / Math.log2(1 + FLOORS_FULL))
  const recency = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS)
  const score = FLOORS_SHARE * floors + (1 - FLOORS_SHARE) * recency
  const width = Math.round((WEIGHT_MIN + score * (WEIGHT_MAX - WEIGHT_MIN)) * 100) / 100
  return { own, ageDays, score, width }
}

// ——— deleting a branch ———————————————————————————————————————————

/** What the delete dialog says, read off the tree the map already has. */
export interface DeleteSummary {
  chatId: string
  title: string
  floors: number
  /** The parent the children re-attach to; absent for a root. */
  parent?: { chatId: string, title: string }
  /** Direct sub-branches. */
  children: number
  /** Every conversation below it, children included. */
  descendants: number
  /** A root's first child, which the host promotes (`planBranchDelete`); absent otherwise. */
  promoted?: { chatId: string, title: string }
}

/**
 * Summarise a delete for the confirm dialog.
 *
 * The promoted child is the first child in the tree's order, which is the
 * order the host sorts children in when it picks one (`orderedChildren` in
 * `chat-tree.ts`): by fork floor, then age. So the dialog names the
 * conversation the host will promote without asking it.
 * @param tree - the lineage.
 * @param chatId - the conversation to delete.
 * @returns the summary, or undefined when the chat is not in the tree.
 */
export function deleteSummary(tree: ChatTreeView | undefined, chatId: string): DeleteSummary | undefined {
  const node = tree?.chats.find(one => one.chatId === chatId)
  if (tree === undefined || node === undefined) return undefined
  const byId = new Map(tree.chats.map(one => [one.chatId, one]))
  const kids = tree.chats.filter(one => one.parentChatId === chatId)
  let descendants = 0
  const queue = [...kids]
  const seen = new Set<string>([chatId])
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.chatId)) continue
    seen.add(next.chatId)
    descendants += 1
    queue.push(...tree.chats.filter(one => one.parentChatId === next.chatId))
  }
  const parent = node.parentChatId === undefined ? undefined : byId.get(node.parentChatId)
  const first = parent === undefined ? kids[0] : undefined
  return {
    chatId,
    title: node.title,
    floors: node.floorCount,
    ...parent === undefined ? {} : { parent: { chatId: parent.chatId, title: parent.title } },
    children: kids.length,
    descendants,
    ...first === undefined ? {} : { promoted: { chatId: first.chatId, title: first.title } },
  }
}
