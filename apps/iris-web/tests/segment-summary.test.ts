/**
 * The tree map's segment summaries on the web side: the pure mapping onto the
 * drawing, and the store slice against the fake host.
 *
 * Chosen where the nearest wrong implementation disagrees: a folded row that
 * named only its first lane would hide a parallel branch's segment; a
 * 「summarize all」 that counted current summaries would pay for them twice; a
 * run that fired every request at once could not be stopped between them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeClient } from '@iris/client-fake'
import { segmentsOf, type ChatTreeNode, type ChatTreeView, type IrisClient, type SegmentSummaryView } from '@iris/protocol'

import { createIrisStore } from '../src/client/store.ts'
import { gapSegments, pendingSegments, rowOfFloor, segmentHits, segmentOfFloor } from '../src/app/segment-summary.ts'
import { layoutTree } from '../src/app/tree-map.ts'

function node(chatId: string, floorCount: number, fork?: { parent: string, floor: number, shared: number }): ChatTreeNode {
  return {
    chatId, title: chatId, updatedAt: 1, depth: fork === undefined ? 0 : 1, floorCount,
    swipes: Array.from({ length: floorCount }, () => 1),
    ...fork === undefined ? {} : { parentChatId: fork.parent, fork: { floor: fork.floor, shared: fork.shared, source: 'recorded' as const } },
  }
}

/** 黑兽's shape, longer: a root of 0–32 and a branch from floor 30 with 31–40 of its own. */
const TREE: ChatTreeView = {
  rootChatId: 'root',
  chats: [node('root', 33), node('b', 41, { parent: 'root', floor: 30, shared: 31 })],
  current: { chatId: 'b', floor: 40 },
}

test('every segment has a place on the drawing, on its own lane', () => {
  const layout = layoutTree(TREE)
  const segments = segmentsOf(TREE)
  const hits = segmentHits(layout, segments)
  assert.deepEqual(hits.map(hit => [hit.segment.chatId, hit.segment.from, hit.segment.to, hit.lane]), [
    ['root', 0, 30, 0], ['root', 31, 32, 0], ['b', 31, 40, 1],
  ])
  for (const hit of hits) {
    assert.ok(hit.top <= hit.bottom, 'a segment runs upwards')
    assert.equal(rowOfFloor(layout.rows, hit.segment.from), hit.top)
  }
})

test('a folded run stands for the segment of every lane it is drawn on', () => {
  const layout = layoutTree(TREE)
  const segments = segmentsOf(TREE)
  const gaps = layout.rows.filter(row => row.kind === 'gap')
  const prefix = gaps.find(row => row.from === 1)
  assert.ok(prefix !== undefined && prefix.kind === 'gap', 'premise: the prefix folds into one run')
  assert.deepEqual(gapSegments(prefix, segments), [{ chatId: 'root', from: 0, to: 30 }])
  // 32–39 on the branch lane; the root ends at 32 so only the branch holds 33–39.
  const tail = gaps.find(row => row.from === 32 || row.from === 33)
  assert.ok(tail !== undefined && tail.kind === 'gap')
  assert.ok(gapSegments(tail, segments).every(segment => segment.chatId === 'b'))

  // Two lanes running side by side through one folded run: both segments.
  const wide: ChatTreeView = {
    rootChatId: 'root',
    chats: [node('root', 61), node('b', 51, { parent: 'root', floor: 10, shared: 11 })],
    current: { chatId: 'b', floor: 50 },
  }
  const run = layoutTree(wide).rows.find(row => row.kind === 'gap' && row.from === 12)
  assert.ok(run !== undefined && run.kind === 'gap', 'premise: floors 12–49 fold into one run on both lanes')
  assert.deepEqual(gapSegments(run, segmentsOf(wide)), [{ chatId: 'root', from: 11, to: 60 }, { chatId: 'b', from: 11, to: 50 }])
})

test('a floor of the branch’s copied prefix belongs to the root’s segment', () => {
  const segments = segmentsOf(TREE)
  assert.deepEqual(segmentOfFloor(TREE, segments, 'b', 12), { chatId: 'root', from: 0, to: 30 })
  assert.deepEqual(segmentOfFloor(TREE, segments, 'b', 35), { chatId: 'b', from: 31, to: 40 })
})

test('「summarize all」 counts missing and stale summaries, never current ones', () => {
  const segments = segmentsOf(TREE)
  const view = (from: number, to: number, chatId: string, stale: boolean): SegmentSummaryView =>
    ({ chatId, from, to, summary: 's', at: 1, stale })
  const pending = pendingSegments(segments, [view(0, 30, 'root', false), view(31, 32, 'root', true)])
  assert.deepEqual(pending.segments, [{ chatId: 'root', from: 31, to: 32 }, { chatId: 'b', from: 31, to: 40 }])
  assert.equal(pending.stale, 1)
})

function wired(gate?: Promise<void>): { store: ReturnType<typeof createIrisStore>['store'], calls: { method: string, params: unknown }[], dispose: () => void } {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const calls: { method: string, params: unknown }[] = []
  const recorder = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'chat.summarizeSegment' && gate !== undefined) await gate
      return await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => client.onConnectionChange(listener),
  } as unknown as IrisClient
  const { store, dispose } = createIrisStore(recorder, { transport: 'fake', origin: 'segment summary test' })
  return { store, calls, dispose: () => { dispose(); client.dispose() } }
}

test('the slice: a summary is asked for only by the action, lands in state, and runs one request at a time', async () => {
  let release = (): void => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { store, calls, dispose } = wired(gate)
  const chatId = 'chat-lamplighter'
  await store.getState().openChat(chatId)
  await store.getState().branchChat(chatId, 0)
  const branch = store.getState().chatId ?? ''
  await store.getState().loadTree(branch)
  await store.getState().loadSegmentSummaries(branch)
  assert.equal(calls.filter(call => call.method === 'chat.summarizeSegment').length, 0, 'a read asked for a summary')

  const tree = store.getState().tree
  assert.ok(tree !== undefined)
  const segments = segmentsOf(tree)
  assert.ok(segments.length >= 2, `premise: the family has segments to run over (${String(segments.length)})`)
  const run = store.getState().summarizeAllSegments(branch, segments)
  await new Promise(resolve => setTimeout(resolve, 5))
  // One request out, the rest waiting behind it.
  assert.equal(calls.filter(call => call.method === 'chat.summarizeSegment').length, 1, 'the run did not wait for each request')
  assert.deepEqual(store.getState().segmentRun, { chatId: branch, done: 0, total: segments.length })
  release()
  await run
  assert.equal(calls.filter(call => call.method === 'chat.summarizeSegment').length, segments.length)
  assert.equal(store.getState().segmentRun, undefined)
  assert.equal(store.getState().segmentSummaries?.summaries.length, segments.length)
  // The lane is named, so a sibling's segment reaches its owner.
  const first = calls.find(call => call.method === 'chat.summarizeSegment')?.params as { lane?: string }
  assert.equal(first.lane, segments[0]?.chatId)
  dispose()
})

test('the slice: cancelling a run starts no further request and stops the one in flight', async () => {
  let release = (): void => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { store, calls, dispose } = wired(gate)
  const chatId = 'chat-lamplighter'
  await store.getState().openChat(chatId)
  await store.getState().branchChat(chatId, 0)
  const branch = store.getState().chatId ?? ''
  await store.getState().loadTree(branch)
  const segments = segmentsOf(store.getState().tree as ChatTreeView)
  const run = store.getState().summarizeAllSegments(branch, segments)
  await new Promise(resolve => setTimeout(resolve, 5))
  await store.getState().cancelSegmentRun()
  release()
  await run
  assert.equal(calls.filter(call => call.method === 'chat.summarizeSegment').length, 1, 'a request started after the cancel')
  assert.ok(calls.some(call => call.method === 'chat.abort'), 'the request in flight was not stopped')
  assert.equal(store.getState().segmentRun, undefined)
  dispose()
})
