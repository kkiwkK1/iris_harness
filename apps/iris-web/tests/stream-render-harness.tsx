/**
 * What a streaming delta renders, counted on the real `ChatPane`.
 *
 * Mounted by `stream-render-mount.test.ts` under jsdom through Vite's SSR
 * loader, with a `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub the test installs before
 * React loads: React reports every commit to it, and each commit is walked for
 * the function components that actually ran (`PerformedWork`). A subtree whose
 * child pointer did not move was bailed out and is not walked, so a flag left
 * over from an earlier commit is never counted.
 */
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeClient } from '@iris/client-fake'
import type { IrisEvent, MessageView } from '@iris/protocol'
import { ChatPane } from '../src/app/ChatPane.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { applyEvent, createIrisStore } from '../src/client/store.ts'
import { STREAM_PAINT_INTERVAL_MS } from '../src/client/stream-display.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'

/** One commit's rendered components, by where they sit. */
export interface CommitCount {
  streamingRow: number
  settledRows: number
  settledInterfaces: number
  composer: number
}

interface Fiber {
  tag: number
  type: unknown
  flags: number
  memoizedProps: unknown
  child: Fiber | null
  sibling: Fiber | null
  alternate: Fiber | null
}

const COMPONENT = new Set([0, 1, 11, 14, 15])
/** Debug only: every component that ran, by name. */
export const RAN = new Map<string, number>()

function nameOf(fiber: Fiber): string | undefined {
  const type = fiber.type
  if (typeof type === 'function') {
    const named = type as { name?: string, displayName?: string }
    return named.displayName ?? named.name
  }
  if (typeof type === 'object' && type !== null) {
    const wrapper = type as { displayName?: string, render?: { name?: string }, type?: { name?: string } }
    return wrapper.displayName ?? wrapper.render?.name ?? wrapper.type?.name
  }
  return undefined
}

/**
 * Count one commit.
 * @param root - the committed root React handed the hook.
 * @returns the rendered components, by region.
 */
export function countCommit(root: { current: Fiber }): CommitCount {
  const out: CommitCount = { streamingRow: 0, settledRows: 0, settledInterfaces: 0, composer: 0 }
  const stack: Array<[Fiber, 0 | 1 | 2, boolean]> = [[root.current, 0, false]]
  while (stack.length > 0) {
    const [fiber, row, inComposer] = stack.pop()!
    let nextRow = row
    let nextComposer = inComposer
    let isRow = false
    const props = fiber.memoizedProps as { message?: MessageView, handlers?: unknown } | null
    if (props !== null && typeof props === 'object' && props.message !== undefined && props.handlers !== undefined) {
      nextRow = props.message.streaming === true ? 1 : 2
      isRow = true
    }
    const name = COMPONENT.has(fiber.tag) ? nameOf(fiber) : undefined
    // Vite's SSR transform may suffix a name (`Composer2`) where a binding
    // shadows the function it wraps, so a name is matched with its suffix.
    const isComposer = name !== undefined && /^Composer\d*$/.test(name)
    if (isComposer) nextComposer = true
    if (COMPONENT.has(fiber.tag) && (fiber.flags & 1) === 1) {
      if (process.env.STREAM_RENDER_DEBUG === '1') RAN.set(String(name), (RAN.get(String(name)) ?? 0) + 1)
      if (isComposer) out.composer += 1
      else if (!nextComposer && nextRow === 1) out.streamingRow += 1
      else if (!nextComposer && nextRow === 2) {
        if (isRow) out.settledRows += 1
        if (name !== undefined && /^MessageInterfaces\d*$/.test(name)) out.settledInterfaces += 1
      }
    }
    const alternate = fiber.alternate
    if (fiber.child !== null && (alternate === null || fiber.child !== alternate.child)) {
      for (let child: Fiber | null = fiber.child; child !== null; child = child.sibling) {
        stack.push([child, nextRow, nextComposer])
      }
    }
  }
  return out
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Stream a reply into a pane holding `floors` settled rows and count what ran.
 * @param container - where to mount.
 * @param commits - the hook's commit log, which this empties before streaming.
 */
export async function checkStreamRender(container: HTMLElement, commits: CommitCount[]): Promise<void> {
  const wired = createIrisStore(createFakeClient(), { transport: 'fake', origin: 'stream render test' })
  const chatId = 'streaming'
  // Settled rows with interface markup on them, so a re-render would also be a
  // re-claim — the cost the per-row memo exists to avoid.
  const messages: MessageView[] = Array.from({ length: 24 }, (_, id) => ({
    id,
    key: `message-${String(id)}`,
    name: id % 2 === 1 ? 'Card' : 'Reader',
    role: id % 2 === 1 ? 'assistant' : 'user',
    text: id % 2 === 1
      ? `Reply ${String(id)}\n\n\`\`\`html\n<div class="panel">status ${String(id)}</div>\n\`\`\``
      : `Line ${String(id)}`,
    turn: Math.floor(id / 2) + 1,
  }))
  wired.store.setState({ chatId, view: { chatId, title: 'Streaming chat', messages: [...messages, {
    id: 24, key: 'message-24', name: 'Reader', role: 'user', text: 'Go on', turn: 13,
  }] } })
  const root = createRoot(container)
  const slots = createIrisSlots()
  const push = (event: IrisEvent): void => { applyEvent(wired.store, event) }
  try {
    await act(async () => root.render(
      <SlotProvider core={slots.core}><StoreProvider store={wired.store}>
        <ChatPane onOpenSettings={() => {}} />
      </StoreProvider></SlotProvider>,
    ))
    assert.equal(container.querySelectorAll('[data-floor]').length, 25, 'every settled floor is mounted')

    // The opening frame is published at once: the caret is on screen in the
    // same act, with no paint interval waited.
    await act(async () => { push({ type: 'stream.start', chatId, turn: 13, key: 'reply-13' }) })
    assert.ok(container.querySelector('.iris-caret') !== null, 'stream.start is shown immediately')

    commits.length = 0
    const DELTAS = 40
    for (let at = 0; at < DELTAS; at += 1) {
      await act(async () => {
        push({ type: 'stream.text', chatId, turn: 13, delta: `word${String(at)} ` })
        // Faster than the paint interval, as a fast provider is.
        await pause(STREAM_PAINT_INTERVAL_MS / 8)
      })
    }
    await act(async () => { await pause(STREAM_PAINT_INTERVAL_MS * 3) })
    const text = container.querySelector('.iris-caret')?.closest('.iris-msg__text')?.textContent ?? ''
    assert.ok(text.includes(`word${String(DELTAS - 1)}`), 'the newest delta reaches the screen after the interval')

    const total = (key: keyof CommitCount): number => commits.reduce((sum, row) => sum + row[key], 0)
    if (process.env.STREAM_RENDER_DEBUG === '1') console.log(JSON.stringify([...RAN]), JSON.stringify({ commits: commits.length, streamingRow: total('streamingRow'), settledRows: total('settledRows'), settledInterfaces: total('settledInterfaces'), composer: total('composer') }))
    assert.ok(total('streamingRow') > 0, 'the streaming row renders while text arrives')
    assert.ok(commits.length < DELTAS / 2, `growth is painted at a bounded rate: ${String(commits.length)} commits for ${String(DELTAS)} deltas`)
    assert.equal(total('settledRows'), 0, 'no settled row re-renders for a streaming delta')
    assert.equal(total('settledInterfaces'), 0, 'no settled row re-renders its interfaces (claim, budget, frames) for a delta')
    assert.equal(total('composer'), 0, 'the composer does not re-render for a delta')

    // The end is published at once too, and the reply settles in place.
    await act(async () => {
      push({ type: 'stream.text', chatId, turn: 13, delta: 'tail' })
      push({ type: 'stream.end', chatId, turn: 13, reason: 'completed', view: {
        chatId, title: 'Streaming chat', messages: [...messages,
          { id: 24, key: 'message-24', name: 'Reader', role: 'user', text: 'Go on', turn: 13 },
          { id: 25, key: 'reply-13', name: 'Card', role: 'assistant', text: 'the settled reply', turn: 13 }],
      } })
    })
    assert.equal(container.querySelector('.iris-caret'), null, 'stream.end is shown immediately, not after a paint interval')
    assert.ok(container.textContent?.includes('the settled reply'))
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
    slots.dispose()
  }
}
