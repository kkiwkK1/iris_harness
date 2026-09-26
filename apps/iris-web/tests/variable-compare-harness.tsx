/**
 * The tree map's 「比较变量」 mode, driven on the real `StatePanel` (whose lower
 * half is the real `TreeMap`) against the fake host's seeded floor tables.
 *
 * Mounted by `variable-compare-mount.test.ts` under jsdom through Vite's SSR
 * loader, the way `stream-render-harness.tsx` is.
 */
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeClient } from '@iris/client-fake'
import type { BranchLink } from '../src/app/tree-map.ts'
import { Message, type MessageHandlers } from '../src/app/Message.tsx'
import { StatePanel } from '../src/app/StatePanel.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore } from '../src/client/store.ts'

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Wait, inside `act`, until a condition holds. */
async function until(what: string, holds: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (holds()) return
    await act(async () => { await pause(5) })
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Click an element, with Shift held when asked. */
async function click(element: Element | null | undefined, shiftKey = false): Promise<void> {
  assert.ok(element !== null && element !== undefined, 'the element to click exists')
  const view = element.ownerDocument.defaultView as Window & typeof globalThis
  await act(async () => { element.dispatchEvent(new view.MouseEvent('click', { bubbles: true, shiftKey })) })
}

/** The floor label on the map for a floor number (the first row that draws it). */
function floorLabel(container: HTMLElement, floor: number): Element | undefined {
  return [...container.querySelectorAll('.iris-tree__label--floor')]
    .find(label => label.querySelector('.iris-tree__floor')?.textContent === `#${String(floor)}`)
}

/**
 * Compare mode end to end in the margin.
 * @param container - where to mount.
 */
export async function checkCompareMode(container: HTMLElement): Promise<void> {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'variable compare test' })
  const { store } = wired
  const root = createRoot(container)
  const document = container.ownerDocument
  try {
    // A branch, so the map has two lanes: floor 2's other reading.
    await store.getState().openChat('chat-lamplighter')
    await store.getState().branchChat('chat-lamplighter', 2, 1)
    const reading = store.getState().chatId
    assert.notEqual(reading, 'chat-lamplighter')
    await store.getState().loadTree(reading ?? '')

    await act(async () => root.render(
      <StoreProvider store={store}><StatePanel drawerOpen={false} /></StoreProvider>,
    ))
    await until('the tree map', () => floorLabel(container, 0) !== undefined)
    const variablesTools = (): Element | null => container.querySelector('.iris-aside__inner > .iris-var__tools')

    // The mode switch: the upper half becomes the comparison, asking for A.
    await click(container.querySelector('[data-control="tree-compare"]'))
    assert.equal(container.querySelector('[data-control="tree-compare"]')?.getAttribute('aria-pressed'), 'true')
    assert.ok(container.querySelector('[data-control="variable-compare"]') !== null, 'the comparison replaces the variables')
    assert.equal(variablesTools(), null, 'the ordinary variable tools are gone while comparing')
    assert.match(container.querySelector('[data-control="compare-hint"]')?.textContent ?? '', /pick A/u)

    // A, then B: clicking picks, and does not switch conversations.
    await click(floorLabel(container, 0))
    assert.match(container.querySelector('[data-control="compare-hint"]')?.textContent ?? '', /second floor for B/u)
    assert.equal(container.querySelector('.iris-tree__rows .iris-tree__pick[data-side="a"]')?.textContent, 'A', 'A is marked on the map')
    await click(floorLabel(container, 4))
    assert.equal(store.getState().chatId, reading, 'picking never switched chats')
    assert.deepEqual(store.getState().compare?.a, { chatId: 'chat-lamplighter', floor: 0 })
    assert.deepEqual(store.getState().compare?.b, { chatId: 'chat-lamplighter', floor: 4 })
    assert.equal(container.querySelector('.iris-tree__rows .iris-tree__pick[data-side="b"]')?.textContent, 'B', 'B is marked on the map')

    // The diff renders: the counts, the marked rows, and `A → B` in place.
    const summary = (): string => container.querySelector('[data-control="compare-summary"]')?.textContent ?? ''
    await until('the diff', () => summary() !== '')
    assert.equal(summary(), '+2 ~2 −0')
    const header = container.querySelector('.iris-compare__head')?.textContent ?? ''
    assert.ok(header.includes('雨夜的第三次点数'), `the header names the branch: ${header}`)
    const changedRows = [...container.querySelectorAll('.iris-compare .iris-var__row[data-changed]')]
    const hp = changedRows.find(row => row.querySelector('.iris-var__key')?.textContent?.includes('好感度') === true)
    assert.equal(hp?.querySelector('.iris-var__value')?.textContent, '30 → 35', 'the MVU pair shows its two readings')
    const items = changedRows.find(row => row.querySelector('.iris-var__key')?.textContent?.includes('物品') === true)
    assert.equal(items?.querySelector('.iris-var__value--change')?.textContent, '细口钳 → 灯芯, 细口钳', 'a flat list changes as one row')
    assert.ok(container.querySelector('.iris-compare .iris-var__delta--new') !== null, 'the key only B holds is marked new')
    // 「只看变化」 is on by default: the unchanged 地点 is not drawn…
    const keyTexts = (): string[] => [...container.querySelectorAll('.iris-compare .iris-var__key')].map(key => key.textContent ?? '')
    assert.ok(!keyTexts().some(key => key.includes('地点')))
    // …and turning it off draws the whole of B around the changes.
    await click(container.querySelector('[data-control="compare-only-changes"]'))
    assert.ok(keyTexts().some(key => key.includes('地点')))

    // Swap: B's table is now A's, so what was added is what only A holds.
    await click(container.querySelector('[data-control="compare-swap"]'))
    await until('the swapped diff', () => summary() === '+0 ~2 −2')
    assert.ok(container.querySelector('[data-control="compare-removed"]') !== null, 'what only A holds is listed')

    // Escape leaves the mode, and the variables come back.
    await act(async () => { document.dispatchEvent(new (document.defaultView as Window & typeof globalThis).KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(store.getState().compare, undefined)
    assert.equal(container.querySelector('[data-control="variable-compare"]'), null)
    assert.equal(container.querySelector('[data-control="tree-compare"]')?.getAttribute('aria-pressed'), 'false')

    // Shift-click picks at any time, starting the mode, and still does not switch.
    await click(floorLabel(container, 0), true)
    assert.deepEqual(store.getState().compare?.a, { chatId: 'chat-lamplighter', floor: 0 })
    assert.equal(store.getState().chatId, reading)
    // The close button leaves as Escape does.
    await click(container.querySelector('[data-control="compare-close"]'))
    assert.equal(store.getState().compare, undefined)
    // And outside the mode a plain click is the straight jump it always was.
    await click(floorLabel(container, 4))
    await until('the jump', () => store.getState().chatId === 'chat-lamplighter')
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
    client.dispose()
  }
}

/**
 * The ⑂N list on a floor: its compare entry starts a comparison of this floor
 * against the same floor of the named conversation, and its delete entry opens
 * the tree map's delete dialog and deletes through `chat.delete`.
 * @param container - where to mount.
 */
export async function checkForkBadgeActions(container: HTMLElement): Promise<void> {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'fork badge test' })
  const { store } = wired
  const root = createRoot(container)
  const document = container.ownerDocument
  try {
    await store.getState().openChat('chat-lamplighter')
    await store.getState().branchChat('chat-lamplighter', 2, 1)
    const branch = store.getState().chatId ?? ''
    await store.getState().jumpToFloor('chat-lamplighter', 2)
    await store.getState().loadTree('chat-lamplighter')
    const message = store.getState().view?.messages[2]
    assert.ok(message !== undefined)
    const links: BranchLink[] = [{ chatId: branch, title: 'the branch', relation: 'child' }]
    const handlers = new Proxy({}, { get: () => () => {} }) as MessageHandlers
    await act(async () => root.render(
      <StoreProvider store={store}><Message message={message} canRegenerate={false} handlers={handlers} branches={links} /></StoreProvider>,
    ))

    /** Open the badge's menu, then its group, then the row naming the branch. */
    const choose = async (group: string): Promise<void> => {
      await click(container.querySelector('[data-control="floor-forks"]'))
      // Menu rows only: the message row has a Delete action of its own.
      const menuRows = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      const parent = menuRows().find(row => row.textContent?.trim() === group)
      assert.ok(parent !== undefined, `the ${group} group is in the menu`)
      await click(parent)
      const rows = menuRows().filter(row => row.textContent?.trim() === 'the branch')
      assert.ok(rows.length >= 2, `the ${group} submenu names the branch (found ${String(rows.length)} rows)`)
      await click(rows.at(-1))
    }

    await choose('Compare variables with')
    assert.deepEqual(store.getState().compare?.a, { chatId: 'chat-lamplighter', floor: 2 })
    assert.deepEqual(store.getState().compare?.b, { chatId: branch, floor: 2 })
    store.getState().setCompareMode(false)

    await choose('Delete')
    const confirm = document.body.querySelector('[data-control="tree-delete-confirm"]')
    assert.ok(confirm !== null, 'the delete dialog is the tree map’s')
    await click(confirm)
    await until('the delete', () => !store.getState().chats.some(row => row.chatId === branch))
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
    client.dispose()
  }
}
