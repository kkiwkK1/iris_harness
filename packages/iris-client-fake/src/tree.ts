/**
 * `chat.tree` for the fake: the lineage graph over the fake's own chats.
 *
 * **A second, smaller implementation of the host's `chat-tree.ts`**, for the
 * reason `summariseFakeUsage` gives: this package depends on `@iris/protocol`
 * alone. It is smaller because the fake only ever holds branches it made
 * itself, so every fork is `recorded` and none has to be inferred — the
 * marker and prefix rules have no input here to run on.
 *
 * @module @iris/client-fake/tree
 */

import type { ChatTreeNode, ChatTreeView } from '@iris/protocol'

import type { FakeChat } from './state.ts'

/**
 * Build the lineage `chatId` belongs to.
 * @param chats - every fake conversation.
 * @param chatId - the conversation asked about; must exist.
 * @returns the graph, root first, depth-first, children by fork floor.
 */
export function fakeChatTree(chats: readonly FakeChat[], chatId: string): ChatTreeView {
  const byId = new Map(chats.map(chat => [chat.chatId, chat]))
  let root = chatId
  const seen = new Set<string>([root])
  for (let up = byId.get(root)?.parentChatId; up !== undefined && byId.has(up) && !seen.has(up); up = byId.get(up)?.parentChatId) {
    seen.add(up)
    root = up
  }

  const nodes: ChatTreeNode[] = []
  const placed = new Set<string>([root])
  const visit = (chat: FakeChat, depth: number): void => {
    const parent = chat.parentChatId !== undefined && byId.has(chat.parentChatId) ? chat.parentChatId : undefined
    const at = chat.branchAt
    nodes.push({
      chatId: chat.chatId,
      title: chat.title,
      updatedAt: chat.updatedAt,
      ...(parent === undefined ? {} : { parentChatId: parent }),
      ...(chat.parentChatId !== undefined && parent === undefined ? { detachedFrom: chat.parentChatId } : {}),
      depth,
      floorCount: chat.messages.length,
      swipes: chat.messages.map(message => (message.role === 'assistant' ? message.candidates.length : 1)),
      ...(parent === undefined || at === undefined
        ? {}
        : { fork: { floor: at.floor, shared: at.swiped ? at.floor : at.floor + 1, source: 'recorded' as const } }),
    })
    const kids = chats
      .filter(kid => kid.parentChatId === chat.chatId && !placed.has(kid.chatId))
      .sort((a, b) => (a.branchAt?.floor ?? 0) - (b.branchAt?.floor ?? 0) || a.updatedAt - b.updatedAt)
    for (const kid of kids) {
      placed.add(kid.chatId)
      visit(kid, depth + 1)
    }
  }
  const top = byId.get(root)
  if (top !== undefined) visit(top, 0)

  const asked = byId.get(chatId)
  return {
    rootChatId: root,
    chats: nodes,
    current: { chatId, floor: Math.max(0, (asked?.messages.length ?? 0) - 1) },
  }
}

/** One child moved by a delete: its new parent and fork, or neither for a new root. */
export interface FakeRelink {
  chatId: string
  parentChatId?: string
  branchAt?: { floor: number, swiped: boolean }
}

/**
 * `chat.delete`'s plan, the host's rules over the fake's recorded forks.
 *
 * A child moved up a level forks from its new parent at the lower of its own
 * fork and the fork it passes through; at that floor it is another reading
 * when whichever of the two cuts is lower (or either, when they are the same
 * floor) took another reading.
 * @param chats - every fake conversation.
 * @param chatId - the conversation being deleted; must exist.
 * @param mode - `'reattach'` (children move up) or `'delete'` (the subtree goes).
 * @returns what is deleted and what moves.
 */
export function fakeDeletePlan(
  chats: readonly FakeChat[],
  chatId: string,
  mode: 'reattach' | 'delete',
): { deleted: string[], relinks: FakeRelink[], promoted?: string, successor?: string } {
  const byId = new Map(chats.map(chat => [chat.chatId, chat]))
  const kidsOf = (id: string): FakeChat[] => chats
    .filter(kid => kid.parentChatId === id && kid.chatId !== id)
    .sort((a, b) => (a.branchAt?.floor ?? 0) - (b.branchAt?.floor ?? 0) || a.updatedAt - b.updatedAt)
  const victim = byId.get(chatId)
  const parent = victim?.parentChatId !== undefined && byId.has(victim.parentChatId) ? victim.parentChatId : undefined
  const successor = parent === undefined ? {} : { successor: parent }

  if (mode === 'delete') {
    const deleted: string[] = []
    const queue = [chatId]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (deleted.includes(next)) continue
      deleted.push(next)
      queue.push(...kidsOf(next).map(kid => kid.chatId))
    }
    return { deleted, relinks: [], ...successor }
  }

  const through = (own: FakeChat['branchAt'], via: FakeChat['branchAt']): FakeChat['branchAt'] => {
    if (own === undefined || via === undefined) return own ?? via
    if (own.floor === via.floor) return { floor: own.floor, swiped: own.swiped || via.swiped }
    return own.floor < via.floor ? own : via
  }
  const kids = kidsOf(chatId)
  if (parent !== undefined) {
    return {
      deleted: [chatId],
      relinks: kids.map(kid => {
        const at = through(kid.branchAt, victim?.branchAt)
        return { chatId: kid.chatId, parentChatId: parent, ...at === undefined ? {} : { branchAt: at } }
      }),
      ...successor,
    }
  }
  const [first, ...rest] = kids
  if (first === undefined) return { deleted: [chatId], relinks: [] }
  return {
    deleted: [chatId],
    relinks: [
      { chatId: first.chatId },
      ...rest.map(kid => {
        const at = through(kid.branchAt, first.branchAt)
        return { chatId: kid.chatId, parentChatId: first.chatId, ...at === undefined ? {} : { branchAt: at } }
      }),
    ],
    promoted: first.chatId,
    successor: first.chatId,
  }
}
