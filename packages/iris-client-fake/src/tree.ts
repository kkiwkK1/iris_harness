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
