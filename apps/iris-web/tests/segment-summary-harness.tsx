/**
 * The tree map's segment hover cards, mounted for real.
 *
 * Loaded by `segment-summary-mount.test.ts` under jsdom through Vite's SSR
 * loader. The client is the fake host with the three tree-map methods
 * answered here, so the lineage is 黑兽's shape (a root of floors 0–32 and a
 * branch from floor 30) whatever the fake's seed holds, and every call the map
 * makes is recorded.
 */
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeClient } from '@iris/client-fake'
import type { ChatTreeNode, ChatTreeView, IrisClient, MessageView, SegmentSummaryView } from '@iris/protocol'

import { TreeMap } from '../src/app/TreeMap.tsx'
import { SummarizeAllButton } from '../src/app/SegmentSummary.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore } from '../src/client/store.ts'

function node(chatId: string, floorCount: number, fork?: { parent: string, floor: number, shared: number }): ChatTreeNode {
  return {
    chatId, title: chatId === 'root' ? '黑兽' : '黑兽 - Branch #1', updatedAt: 1, depth: fork === undefined ? 0 : 1, floorCount,
    swipes: Array.from({ length: floorCount }, () => 1),
    ...fork === undefined ? {} : { parentChatId: fork.parent, fork: { floor: fork.floor, shared: fork.shared, source: 'recorded' as const } },
  }
}

const TREE: ChatTreeView = {
  rootChatId: 'root',
  chats: [node('root', 33), node('b', 41, { parent: 'root', floor: 30, shared: 31 })],
  current: { chatId: 'b', floor: 40 },
}

const PREFIX: SegmentSummaryView = {
  chatId: 'root', from: 0, to: 30, summary: 'The black beast wakes in the snow and follows the traveller.', at: Date.UTC(2026, 8, 26, 8, 0), model: 'mock-model', stale: false,
}

const settle = async (ms = 0): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

export async function checkSegmentHover(container: HTMLElement, win: Window & typeof globalThis): Promise<void> {
  const fake = createFakeClient({ chunkDelayMs: 0 })
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const stored: SegmentSummaryView[] = [PREFIX]
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'chat.tree') return { tree: TREE }
      if (method === 'chat.segmentSummaries') return { summaries: [...stored] }
      if (method === 'chat.summarizeSegment') {
        const summary: SegmentSummaryView = {
          chatId: String(params['lane']), from: Number(params['fromFloor']), to: Number(params['toFloor']),
          summary: 'A canned branch summary.', at: Date.UTC(2026, 8, 26, 9, 0), stale: false,
        }
        stored.push(summary)
        return { summary }
      }
      return await (fake as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => fake.subscribe(listener),
    get connected() { return fake.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => fake.onConnectionChange(listener),
  } as unknown as IrisClient
  const wired = createIrisStore(client, { transport: 'fake', origin: 'segment summary mount' })
  const messages: MessageView[] = Array.from({ length: 41 }, (_, id) => ({
    id, key: `m${String(id)}`, name: id % 2 === 0 ? '黑兽' : 'Reader', role: id % 2 === 0 ? 'assistant' : 'user', text: `floor ${String(id)}`, turn: id,
  }))
  wired.store.setState({ chatId: 'b', view: { chatId: 'b', title: '黑兽 - Branch #1', messages }, tree: TREE })

  const root = createRoot(container)
  const summarizeCalls = (): number => calls.filter(call => call.method === 'chat.summarizeSegment').length
  try {
    await act(async () => root.render(
      <StoreProvider store={wired.store}>
        <SummarizeAllButton />
        <TreeMap />
      </StoreProvider>,
    ))
    // The sync reads the stored summaries — and generates nothing.
    await settle(200)
    assert.ok(calls.some(call => call.method === 'chat.segmentSummaries'), 'the map never read the stored summaries')
    assert.equal(summarizeCalls(), 0, 'mounting the map asked for a summary')

    // The folded prefix: focusing it (as hovering does) shows the stored summary.
    const gap = [...container.querySelectorAll<HTMLButtonElement>('.iris-tree__label--gap')]
      .find(button => button.textContent?.includes('29 floors'))
    assert.ok(gap !== undefined, 'premise: floors 1–29 fold into one "29 floors" row')
    await act(async () => { gap.focus() })
    let card = container.querySelector('.iris-seg-card')
    assert.ok(card !== null, 'focusing the folded run opened no card')
    assert.match(card.textContent ?? '', /The black beast wakes in the snow/u, 'the card does not show the stored summary')
    assert.match(card.textContent ?? '', /Floors 0–30/u)
    assert.match(card.textContent ?? '', /mock-model/u, 'the card does not say who wrote it')
    assert.equal(card.querySelector('[data-control="segment-summarize"]'), null, 'a current summary offered to be paid for again')
    assert.equal(gap.getAttribute('aria-describedby'), card.id, 'the trigger does not point at its card')
    assert.equal(summarizeCalls(), 0, 'showing a card asked for a summary')

    // Escape closes it.
    await act(async () => {
      card?.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(container.querySelector('.iris-seg-card'), null, 'Escape left the card open')

    // A lane segment with no summary: hovering its run offers the button.
    const hit = container.querySelector('path[data-segment="b:31-40"]')
    assert.ok(hit !== null, 'the branch’s own segment has no hover target on its lane')
    const Pointer = (win as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? win.MouseEvent
    await act(async () => { hit.dispatchEvent(new Pointer('pointerover', { bubbles: true })) })
    card = container.querySelector('.iris-seg-card')
    assert.ok(card !== null, 'hovering a lane segment opened no card')
    assert.match(card.textContent ?? '', /Not summarized yet/u)
    const go = card.querySelector<HTMLButtonElement>('[data-control="segment-summarize"]')
    assert.ok(go !== null, 'a segment with no summary offers no button')
    assert.equal(summarizeCalls(), 0, 'hovering asked for a summary')

    await act(async () => { go.click() })
    await settle()
    const asked = calls.find(call => call.method === 'chat.summarizeSegment')
    assert.deepEqual(asked?.params, { chatId: 'b', fromFloor: 31, toFloor: 40, lane: 'b' }, 'the button sent the wrong segment')
    assert.match(container.querySelector('.iris-seg-card')?.textContent ?? '', /A canned branch summary/u,
      'the new summary did not appear in the open card')

    // The header's 「summarize all」 names how many it will send, and sends none until confirmed.
    const all = container.querySelector<HTMLButtonElement>('[data-control="segment-summarize-all"]')
    assert.ok(all !== null && !all.disabled)
    await act(async () => { all.click() })
    const dialog = win.document.querySelector('.iris-seg-confirm')
    assert.ok(dialog !== null, 'summarize-all did not confirm first')
    assert.match(dialog.textContent ?? '', /1 segments will be summarized/u, 'the confirm counts the wrong segments')
    assert.equal(summarizeCalls(), 1, 'the confirm itself sent a request')
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
    fake.dispose()
  }
}
