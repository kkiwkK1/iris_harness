/**
 * The store's branch-tree slice: the open lineage, and the one pending
 * "scroll to this floor" request.
 *
 * A slice file rather than more lines in `store.ts`, which several workers
 * edit: the store spreads these in (`...branchTreeState()`,
 * `...branchTreeActions(…)`) and otherwise does not know they exist.
 *
 * @module iris-web/client/branch-tree
 */

import type { ChatSummary, ChatTreeView, IrisClient } from '@iris/protocol'

/** A request to bring one floor of one conversation into view. */
export interface FloorJump {
  chatId: string
  floor: number
  /** Distinguishes two jumps to the same floor, so the second still scrolls. */
  seq: number
}

/** What the slice keeps. */
export interface BranchTreeState {
  /**
   * The lineage the open conversation belongs to, as `chat.tree` last said.
   * Kept across a switch **inside** the family — the graph is the same one, so
   * clearing it would blank the map for the length of a round trip on every
   * click; `TreeMap` checks the open chat is in it before drawing.
   */
  tree: ChatTreeView | undefined
  /** Set by a click on the map or a badge; `ChatPane` scrolls to it and settles it. */
  floorJump: FloorJump | undefined
  /**
   * The floor the map marks as "you are here": the last one jumped to. Not
   * cleared when the jump settles — the reader is still there — and ignored by
   * the map once another conversation is open, which falls back to its newest
   * floor.
   */
  treeFocus: { chatId: string, floor: number } | undefined
}

/** What the slice does. */
export interface BranchTreeActions {
  /** Re-read the lineage of a conversation. */
  loadTree(chatId: string): Promise<void>
  /**
   * Branch a conversation at a floor — from a given reading, when `swipeId` is
   * given — then open the branch and bring that floor into view.
   */
  branchChat(chatId: string, id: number, swipeId?: number): Promise<void>
  /** Open a conversation (if it is not the open one) and bring a floor into view. */
  jumpToFloor(chatId: string, floor: number): Promise<void>
  /** The pane has scrolled to the jump with this `seq`. */
  settleFloorJump(seq: number): void
}

/** The slice's starting state. */
export function branchTreeState(): BranchTreeState {
  return { tree: undefined, floorJump: undefined, treeFocus: undefined }
}

/**
 * What the slice needs from the store it lives in.
 *
 * Structural, so this file does not import `store.ts` and the store does not
 * have to export its internals.
 */
export interface BranchTreeDeps {
  client: IrisClient
  get: () => BranchTreeState & { chatId: string | undefined, openChat(chatId: string): Promise<void> }
  set: (patch: Partial<BranchTreeState> & { chats?: ChatSummary[] }) => void
  guard: <T>(work: () => Promise<T>) => Promise<T | undefined>
}

/**
 * Build the slice's actions.
 * @param deps - the store's client, accessors and error guard.
 * @returns the actions.
 */
export function branchTreeActions({ client, get, set, guard }: BranchTreeDeps): BranchTreeActions {
  let seq = 0
  const jump = (chatId: string, floor: number): void => {
    seq += 1
    set({ floorJump: { chatId, floor, seq }, treeFocus: { chatId, floor } })
  }
  return {
    async loadTree(chatId) {
      await guard(async () => {
        const { tree } = await client.call('chat.tree', { chatId })
        // Last write wins by chat: an answer for a conversation the reader has
        // already left is dropped rather than drawn under the wrong one.
        if (get().chatId === chatId) set({ tree })
      })
    },

    async branchChat(chatId, id, swipeId) {
      const answer = await guard(() => client.call('chat.branch', {
        chatId,
        id,
        ...swipeId === undefined ? {} : { swipeId },
      }))
      if (answer === undefined) return
      set({ chats: answer.chats })
      // Opened through the ordinary path, so the switch announces itself to
      // card scripts and loads the branch's settings exactly as a sidebar click
      // would; the view in the answer is the same one `chat.open` returns.
      await get().openChat(answer.view.chatId)
      jump(answer.view.chatId, id)
    },

    async jumpToFloor(chatId, floor) {
      // Switch **directly** — no preview step (owner ruling 2026-09-25).
      if (get().chatId !== chatId) await get().openChat(chatId)
      jump(chatId, floor)
    },

    settleFloorJump(done) {
      if (get().floorJump?.seq === done) set({ floorJump: undefined })
    },
  }
}
