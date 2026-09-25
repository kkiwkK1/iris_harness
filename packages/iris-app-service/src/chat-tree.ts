/**
 * A conversation's lineage as a graph, for the tree map (`chat.tree`).
 *
 * **One branch is one SillyTavern chat file**, which is the compatibility
 * floor: every node here is a file that exports to SillyTavern as-is, and the
 * graph is only ever *read* off the files — nothing here writes. What a file
 * says about its lineage comes in three strengths, and the strongest one
 * present wins:
 *
 * 1. **recorded** — `iris.branchAt { floor, lineId }`, written by `chat.branch`
 *    since the tree map exists. The line id finds the floor again even after
 *    the parent lost floors above it; the floor number is the fallback when
 *    the parent no longer holds that line.
 * 2. **marker** — upstream's own `extra.branches` on the parent's floor, which
 *    names the child (SillyTavern writes the new chat's name; Iris writes its
 *    title). Every branch either host made carries it, recorded or not.
 * 3. **prefix** — the longest common prefix of the two conversations, compared
 *    floor by floor on role plus text. The inference of last resort, for a
 *    branch whose parent never recorded the marker.
 *
 * Pure: the inputs are already-read files, so `node --test` can build every
 * lineage shape without a disk.
 *
 * @module @iris/app-service/chat-tree
 */

import { createHash } from 'node:crypto'

import { lineIdOf, type SillyTavernChat, type SillyTavernMessage } from '@iris/persistence'
import type { ChatSummary, ChatTreeFork, ChatTreeNode, ChatTreeView } from '@iris/protocol'

import { readMeta, type BranchAt } from './entry.ts'

/** What the graph needs of one floor, and nothing more. */
export interface TreeFloor {
  /** Role plus text, hashed: equal keys mean "the same floor" for the prefix rule. */
  key: string
  /** The whole reading set, hashed, so a swipe-turned-branch is recognised. */
  swipeKey: string
  swipes: number
  lineId?: string
  /** Upstream's `extra.branches`: the names of chats cut from this floor. */
  branches: readonly string[]
}

/** One conversation, as the graph builder takes it. */
export interface TreeChatInput {
  chatId: string
  title: string
  updatedAt: number
  /** Resolved the way the sidebar resolves it (`linkImportedParents`). */
  parentChatId?: string
  branchAt?: BranchAt
  /** Undefined when the file could not be read. */
  floors?: readonly TreeFloor[]
}

/**
 * A short content hash.
 * @param text - what to hash.
 * @returns 16 hex characters — ample for telling floors of one lineage apart.
 */
function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Project a file's lines onto what the graph compares.
 * @param messages - the file's message lines.
 * @returns one entry per floor.
 */
export function projectFloors(messages: readonly SillyTavernMessage[]): TreeFloor[] {
  return messages.map(line => {
    const role = line.is_user ? 'user' : line.is_system === true ? 'system' : 'assistant'
    const swipes = Array.isArray(line.swipes) && line.swipes.length > 0 ? line.swipes : [line.mes]
    const marked = line.extra?.['branches']
    const lineId = lineIdOf(line)
    return {
      key: digest(`${role}\u0000${typeof line.mes === 'string' ? line.mes : ''}`),
      swipeKey: digest(`${role}\u0000${JSON.stringify(swipes)}`),
      swipes: role === 'assistant' ? swipes.length : 1,
      ...lineId === undefined ? {} : { lineId },
      branches: Array.isArray(marked) ? marked.filter((name): name is string => typeof name === 'string') : [],
    }
  })
}

/**
 * Turn a stored file plus its sidebar summary into a graph input.
 * @param summary - the chat's list row, whose `parentChatId` is already resolved.
 * @param file - the parsed file, or undefined when it could not be read.
 * @returns the input.
 */
export function treeInputOf(summary: ChatSummary, file: SillyTavernChat | undefined): TreeChatInput {
  const branchAt = file === undefined ? undefined : readMeta(file.header).branchAt
  return {
    chatId: summary.chatId,
    title: summary.title,
    updatedAt: summary.updatedAt,
    ...summary.parentChatId === undefined ? {} : { parentChatId: summary.parentChatId },
    ...branchAt === undefined ? {} : { branchAt },
    ...file === undefined ? {} : { floors: projectFloors(file.messages) },
  }
}

/**
 * How many leading floors two conversations hold in common.
 * @param left - one conversation's floors.
 * @param right - the other's.
 * @returns the common prefix length.
 */
function commonPrefix(left: readonly TreeFloor[], right: readonly TreeFloor[]): number {
  const limit = Math.min(left.length, right.length)
  let at = 0
  while (at < limit && left[at]?.key === right[at]?.key) at += 1
  return at
}

/**
 * The shared length that follows from a known fork floor.
 *
 * `floor + 1` when the child's copy of the floor still reads like the
 * parent's; `floor` when it does not — the branch was cut from another reading
 * of that floor, or one side edited it since.
 */
function sharedAfter(parent: readonly TreeFloor[], child: readonly TreeFloor[], floor: number): number {
  const same = parent[floor] !== undefined && parent[floor]?.key === child[floor]?.key
  return same ? floor + 1 : floor
}

/**
 * Where a child leaves its parent.
 * @param parent - the parent conversation.
 * @param child - the branch.
 * @returns the fork, in the parent's floor numbers.
 */
export function forkOf(parent: TreeChatInput, child: TreeChatInput): ChatTreeFork {
  const up = parent.floors ?? []
  const down = child.floors ?? []
  const last = Math.max(0, up.length - 1)

  if (child.branchAt !== undefined) {
    const { floor, lineId } = child.branchAt
    // The id first: it names the same line wherever the parent's floors moved.
    const found = lineId === undefined ? -1 : up.findIndex(row => row.lineId === lineId)
    const at = found >= 0 ? found : Math.min(floor, last)
    return { floor: at, shared: Math.min(sharedAfter(up, down, at), down.length), source: 'recorded' }
  }

  // Upstream's marker. The newest floor naming the child wins: a name reused
  // after its first owner was deleted is the later branch.
  for (let at = up.length - 1; at >= 0; at -= 1) {
    const names = up[at]?.branches ?? []
    if (names.includes(child.chatId) || names.includes(child.title)) {
      return { floor: at, shared: Math.min(sharedAfter(up, down, at), down.length), source: 'marker' }
    }
  }

  // The prefix. A child that diverges on a floor whose reading SET still
  // matches the parent's is a swipe turned into a branch: it was cut *at* that
  // floor, with another reading selected, rather than after the floor before.
  const shared = commonPrefix(up, down)
  const next = shared < up.length && shared < down.length ? shared : -1
  const fork = next >= 0 ? up[next] : undefined
  if (fork !== undefined && fork.swipes > 1 && fork.swipeKey === down[next]?.swipeKey) {
    return { floor: next, shared, source: 'prefix' }
  }
  return { floor: Math.max(0, shared - 1), shared, source: 'prefix' }
}

/**
 * Which conversations a lineage holds, from the sidebar rows alone.
 *
 * Decided before any file is read, so `chat.tree` opens only the files of the
 * family it is drawing, not every chat in the profile.
 * @param rows - every conversation's list row, parents resolved.
 * @param chatId - the conversation asked about.
 * @returns the root ancestor and every descendant of it, `chatId` included.
 */
export function lineageOf(rows: readonly Pick<ChatSummary, 'chatId' | 'parentChatId'>[], chatId: string): Set<string> {
  const parentOf = new Map(rows.map(row => [row.chatId, row.parentChatId]))
  let root = chatId
  const seen = new Set<string>([chatId])
  for (let up = parentOf.get(root); up !== undefined && parentOf.has(up) && !seen.has(up); up = parentOf.get(up)) {
    seen.add(up)
    root = up
  }
  const members = new Set<string>([root])
  // Breadth-first down: every row whose parent is already a member joins.
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (members.has(row.chatId) || row.parentChatId === undefined) continue
      if (members.has(row.parentChatId)) {
        members.add(row.chatId)
        grew = true
      }
    }
  }
  members.add(chatId)
  return members
}

/**
 * Build the lineage graph a conversation belongs to.
 *
 * The root is found by walking parents up from the asked-about chat; a parent
 * the inputs do not hold (deleted, or a SillyTavern name that never resolved)
 * ends the walk, and the chat that named it becomes a root with `detachedFrom`
 * saying so. A parent cycle — only a hand-edited file can make one — is cut at
 * the first repeat, so the answer is always a tree.
 * @param inputs - every conversation that could be in the lineage.
 * @param chatId - the conversation the reader is looking at.
 * @returns the graph, or undefined when `chatId` is not among the inputs.
 */
export function buildChatTree(inputs: readonly TreeChatInput[], chatId: string): ChatTreeView | undefined {
  const byId = new Map(inputs.map(input => [input.chatId, input]))
  const asked = byId.get(chatId)
  if (asked === undefined) return undefined

  /**
   * Each chat's effective parent: present in the inputs, and not closing a
   * cycle. Decided once for every chat, so the root walk and the child lists
   * cannot disagree about an edge.
   */
  const parentOf = new Map<string, string>()
  /** Whether the accepted edges lead from `from` up to `target`. Acyclic by construction, so it ends. */
  const reaches = (from: string, target: string): boolean => {
    for (let cursor: string | undefined = from; cursor !== undefined; cursor = parentOf.get(cursor)) {
      if (cursor === target) return true
    }
    return false
  }
  for (const input of inputs) {
    const parent = input.parentChatId
    if (parent === undefined || parent === input.chatId || !byId.has(parent)) continue
    // An edge that would close a loop is refused; the chat stays a root.
    if (!reaches(parent, input.chatId)) parentOf.set(input.chatId, parent)
  }

  let root = asked.chatId
  const walked = new Set<string>([root])
  for (let up = parentOf.get(root); up !== undefined && !walked.has(up); up = parentOf.get(up)) {
    walked.add(up)
    root = up
  }

  const children = new Map<string, TreeChatInput[]>()
  for (const [child, parent] of parentOf) {
    const input = byId.get(child)
    if (input === undefined) continue
    const list = children.get(parent) ?? []
    list.push(input)
    children.set(parent, list)
  }

  const chats: ChatTreeNode[] = []
  const placed = new Set<string>()
  const visit = (input: TreeChatInput, depth: number, fork: ChatTreeFork | undefined): void => {
    if (placed.has(input.chatId)) return
    placed.add(input.chatId)
    const floors = input.floors ?? []
    const parent = parentOf.get(input.chatId)
    const dangling = input.parentChatId !== undefined && !byId.has(input.parentChatId)
    chats.push({
      chatId: input.chatId,
      title: input.title,
      updatedAt: input.updatedAt,
      ...parent === undefined ? {} : { parentChatId: parent },
      ...dangling ? { detachedFrom: input.parentChatId as string } : {},
      depth,
      floorCount: floors.length,
      swipes: floors.map(row => row.swipes),
      ...fork === undefined ? {} : { fork },
      ...input.floors === undefined ? { unreadable: true as const } : {},
    })
    const kids = (children.get(input.chatId) ?? [])
      .map(kid => ({ kid, fork: forkOf(input, kid) }))
      // By where they leave, then by age, so lanes read left to right in the
      // order the reader made them.
      .sort((a, b) => a.fork.floor - b.fork.floor || a.kid.updatedAt - b.kid.updatedAt || a.kid.chatId.localeCompare(b.kid.chatId))
    for (const { kid, fork: kidFork } of kids) visit(kid, depth + 1, kidFork)
  }
  const top = byId.get(root)
  if (top !== undefined) visit(top, 0, undefined)

  return {
    rootChatId: root,
    chats,
    current: { chatId: asked.chatId, floor: Math.max(0, (asked.floors?.length ?? 0) - 1) },
  }
}
