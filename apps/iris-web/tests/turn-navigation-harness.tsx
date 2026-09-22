import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeClient } from '@iris/client-fake'
import type { MessageView } from '@iris/protocol'
import { ChatPane } from '../src/app/ChatPane.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'

export async function checkNavigation(container: HTMLElement): Promise<void> {
  const wired = createIrisStore(createFakeClient(), { transport: 'fake', origin: 'navigation test' })
  const messages: MessageView[] = Array.from({ length: 240 }, (_, id) => ({
    id, key: `message-${id}`, name: 'Reader', role: id % 2 ? 'assistant' : 'user',
    text: `Plain message ${id}`, turn: Math.floor(id / 2) + 1,
  }))
  wired.store.setState({ chatId: 'long', view: { chatId: 'long', title: 'Long chat', messages } })
  const root = createRoot(container)
  const slots = createIrisSlots()
  try {
    await act(async () => root.render(
      <SlotProvider core={slots.core}><StoreProvider store={wired.store}>
        <ChatPane onOpenSettings={() => {}} />
      </StoreProvider></SlotProvider>,
    ))
    assert.equal(container.querySelectorAll('[data-turn-anchor]').length, 50)
    const button = container.querySelector<HTMLButtonElement>('nav[aria-label="Conversation navigation"] button')!
    assert.ok(button)
    await act(async () => { button.focus() })
    assert.ok(container.querySelector('[role="tooltip"]')?.textContent?.includes('Plain message 0'))
    await act(async () => { button.click() })
    assert.equal(container.querySelectorAll('[data-turn-anchor]').length, 120)
    const scroller = container.querySelector<HTMLElement>('.iris-scroll')!
    assert.equal(scroller.scrollTop, 0, 'old target should be at the start after expansion')
    assert.equal(button.getAttribute('aria-current'), 'true')
    await act(async () => wired.store.setState({
      stream: { turn: 121, key: 'stream-121', text: 'New reply', reasoning: '' },
    }))
    assert.equal(scroller.scrollTop, 0, 'streaming must not pull the reader to the bottom')
    await act(async () => wired.store.setState({
      chatId: 'other', stream: undefined,
      view: { chatId: 'other', title: 'Other chat', messages: messages.slice(0, 2) },
    }))
    assert.equal(container.querySelector('[role="tooltip"]'), null)
    assert.equal(container.querySelector('[aria-label="Conversation navigation"]'), null)
  } finally {
    await act(async () => root.unmount())
    wired.dispose()
    slots.dispose()
  }
}
