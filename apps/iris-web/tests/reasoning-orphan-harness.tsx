/**
 * One message row with a reasoning trace, mounted, for `reasoning-orphan.test.ts`.
 *
 * Loaded through vite, because Node's type stripping does not transform JSX,
 * with everything the row needs built in the same module graph as the
 * component — the shape `quote-scope-harness.tsx` established.
 *
 * @module iris-web/tests/reasoning-orphan-harness
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { createFakeClient } from '@iris/client-fake'
import type { MessageView } from '@iris/protocol'

import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'
import { Message } from '../src/app/Message.tsx'

/** What a mounted row hands back to the test driving it. */
export interface MountedReasoning {
  /** Every `onEdit` the row made, as `[id, text]`. */
  edits: [number, string][]
  /** Whether the trace itself is on screen. */
  traceShown: () => boolean
  /** The "the reply is all reasoning" note, or null. */
  note: () => Element | null
  /** The editor's value, or null when the row is not editing. */
  draft: () => string | null
  /** Click the element matching `selector` inside the row, inside `act`. */
  click: (selector: string) => Promise<void>
  unmount: () => Promise<void>
}

/**
 * Mount one assistant message into a real document.
 * @param container - where to mount; an element of a jsdom document.
 * @param over - the view's text, reasoning and streaming flag.
 * @returns readers and drivers for the mounted row.
 */
export async function mountReasoning(
  container: Element,
  over: { text: string, reasoning: string, streaming?: boolean },
): Promise<MountedReasoning> {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'reasoning orphan test' })
  await wired.store.getState().boot()
  const slots = createIrisSlots()
  const edits: [number, string][] = []
  const handlers = {
    onSwipe: () => {},
    onRegenerate: () => {},
    onContinue: () => {},
    onImpersonate: () => {},
    onEdit: (id: number, text: string) => { edits.push([id, text]) },
    onDelete: () => {},
    onNotify: () => {},
    onExplain: () => {},
    onBranch: () => {},
    onOpenBranch: () => {},
  }
  const message: MessageView = {
    id: 33,
    key: 'm33',
    role: 'assistant',
    name: '黑兽',
    text: over.text,
    reasoning: over.reasoning,
    turn: 16,
    ...over.streaming === true ? { streaming: true } : {},
  }

  const root = createRoot(container)
  await act(async () => {
    root.render(
      <SlotProvider core={slots.core}>
        <StoreProvider store={wired.store}>
          <Message message={message} canRegenerate={false} handlers={handlers} />
        </StoreProvider>
      </SlotProvider>,
    )
  })

  return {
    edits,
    traceShown: () => container.querySelector('.iris-reason__body') !== null,
    note: () => container.querySelector('.iris-reason__orphan'),
    draft: () => (container.querySelector('textarea.iris-edit') as HTMLTextAreaElement | null)?.value ?? null,
    click: async (selector: string) => {
      const target = container.querySelector(selector) as HTMLElement | null
      if (target === null) throw new Error(`nothing matches ${selector}`)
      await act(async () => { target.click() })
    },
    unmount: async () => {
      await act(async () => { root.unmount() })
      slots.dispose()
      wired.dispose()
      client.dispose()
    },
  }
}
