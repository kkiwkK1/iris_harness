/**
 * The store's branch-tree slice, against the fake host.
 *
 * Chosen where the nearest wrong implementation disagrees: a branch action
 * that forgot to open the new chat would leave the reader on the parent; a
 * jump that previewed instead of switching would leave `chatId` alone; a tree
 * read that ignored which chat is open would draw one family under another.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeClient } from '@iris/client-fake'
import type { ChatTreeView, IrisClient } from '@iris/protocol'

import { createIrisStore } from '../src/client/store.ts'

function wired(): { store: ReturnType<typeof createIrisStore>['store'], methods: string[], dispose: () => void } {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const methods: string[] = []
  const recorder = {
    call: async (method: string, params: unknown) => {
      methods.push(method)
      return await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => client.onConnectionChange(listener),
  } as unknown as IrisClient
  const { store, dispose } = createIrisStore(recorder, { transport: 'fake', origin: 'branch tree store test' })
  return { store, methods, dispose: () => { dispose(); client.dispose() } }
}

test('branching opens the branch and asks for its fork floor to be shown', async () => {
  const { store, methods, dispose } = wired()
  await store.getState().openChat('chat-lamplighter')
  const floors = store.getState().view?.messages.length ?? 0
  assert.ok(floors > 0)

  await store.getState().branchChat('chat-lamplighter', 0)
  const state = store.getState()
  assert.notEqual(state.chatId, 'chat-lamplighter', 'the reader is on the branch now')
  assert.equal(state.view?.chatId, state.chatId)
  assert.equal(state.view?.messages.length, 1, 'cut at floor 0, inclusive')
  assert.equal(state.chats.find(row => row.chatId === state.chatId)?.parentChatId, 'chat-lamplighter')
  assert.deepEqual(state.floorJump && { chatId: state.floorJump.chatId, floor: state.floorJump.floor }, { chatId: state.chatId, floor: 0 })
  // Through the ordinary open, so the branch's settings are read like any switch.
  assert.ok(methods.lastIndexOf('chat.open') > methods.indexOf('chat.branch'))

  // Settling clears the jump, and only the jump it names.
  const seq = state.floorJump?.seq ?? -1
  store.getState().settleFloorJump(seq + 1)
  assert.ok(store.getState().floorJump !== undefined)
  store.getState().settleFloorJump(seq)
  assert.equal(store.getState().floorJump, undefined)
  assert.deepEqual(store.getState().treeFocus, { chatId: state.chatId, floor: 0 }, 'the map still marks where the reader is')
  dispose()
})

test('a jump to another conversation switches to it directly', async () => {
  const { store, dispose } = wired()
  await store.getState().openChat('chat-lamplighter')
  await store.getState().jumpToFloor('chat-survey', 1)
  assert.equal(store.getState().chatId, 'chat-survey')
  assert.equal(store.getState().view?.chatId, 'chat-survey')
  assert.equal(store.getState().floorJump?.floor, 1)
  dispose()
})

test('the lineage is read for the open chat, and an answer for a chat already left is dropped', async () => {
  const { store, dispose } = wired()
  await store.getState().openChat('chat-lamplighter')
  await store.getState().branchChat('chat-lamplighter', 0)
  const branch = store.getState().chatId ?? ''
  await store.getState().loadTree(branch)
  const tree = store.getState().tree as ChatTreeView
  assert.equal(tree.rootChatId, 'chat-lamplighter')
  assert.deepEqual(tree.chats.map(node => node.chatId), ['chat-lamplighter', branch])

  // Asked for one chat, answered after the reader moved on: not drawn.
  const pending = store.getState().loadTree('chat-lamplighter')
  store.setState({ chatId: 'chat-survey' })
  await pending
  assert.equal(store.getState().tree, tree, 'the stale answer did not replace the tree')
  dispose()
})
