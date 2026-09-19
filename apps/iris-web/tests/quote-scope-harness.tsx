/**
 * One message row, mounted, so the quote setting can be flipped under it.
 *
 * The rule itself is asserted in `quoted-dialogue.test.ts` without React. What
 * needs a mounted row is the wiring: the preference is an external store, the
 * marking happens in a `useLayoutEffect`, and the claim "flipping the setting
 * re-colours the prose already on screen" is true only if that value is in the
 * effect's dependency list. A server render cannot show that — the effect never
 * runs there — and reading the deps off the source would assert the line rather
 * than the behaviour.
 *
 * Loaded through vite by `quote-scope.test.ts`, because Node's type stripping
 * does not transform JSX. Everything the row needs is built **here**, in the
 * same module graph as the component, so that the `setQuoteScope` the test
 * calls is the one the row subscribed to.
 *
 * @module iris-web/tests/quote-scope-harness
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

export { getQuoteScope, setQuoteScope } from '../src/app/quote-scope.ts'

/** A row's handlers, all of them inert: nothing here clicks anything. */
const HANDLERS = {
  onSwipe: () => {},
  onRegenerate: () => {},
  onContinue: () => {},
  onImpersonate: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onNotify: () => {},
  onExplain: () => {},
}

/** What a mounted row hands back to the test driving it. */
export interface MountedMessage {
  /** How many `<q>` elements the reading surface is showing. */
  quotes: () => number
  /** The prose as the reader sees it, for the characters-unchanged check. */
  text: () => string
  /** Flush React's queue, running `work` inside the same `act`. */
  settle: (work?: () => void) => Promise<void>
  unmount: () => Promise<void>
}

/**
 * Mount one settled assistant message into a real document.
 *
 * @param container - where to mount; an element of a jsdom document.
 * @param text - the reply's text.
 * @returns readers and drivers for the mounted row.
 */
export async function mountMessage(container: Element, text: string): Promise<MountedMessage> {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'quote scope test' })
  await wired.store.getState().boot()
  const slots = createIrisSlots()
  const message: MessageView = { id: 1, key: 'm1', role: 'assistant', name: '黑兽', text, turn: 1 }

  const root = createRoot(container)
  await act(async () => {
    root.render(
      <SlotProvider core={slots.core}>
        <StoreProvider store={wired.store}>
          <Message message={message} canRegenerate={false} handlers={HANDLERS} />
        </StoreProvider>
      </SlotProvider>,
    )
  })

  const prose = (): Element | null => container.querySelector('.iris-msg__text')
  return {
    quotes: () => prose()?.querySelectorAll('q').length ?? -1,
    text: () => prose()?.textContent ?? '',
    settle: async (work?: () => void) => {
      await act(async () => {
        work?.()
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      slots.dispose()
      wired.dispose()
      client.dispose()
    },
  }
}
