import assert from 'node:assert/strict'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createFakeClient } from '@iris/client-fake'
import type { MessageView } from '@iris/protocol'
import { ChatPane } from '../src/app/ChatPane.tsx'
import { RegionBoundary } from '../src/app/RegionBoundary.tsx'
import { SettingsPage } from '../src/app/SettingsNavigation.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'

/** A panel that cannot render. */
function Exploding(): ReactElement {
  throw new Error('panel exploded')
}

export async function checkContainment(container: HTMLElement): Promise<void> {
  const wired = createIrisStore(createFakeClient(), { transport: 'fake', origin: 'region boundary test' })
  const messages: MessageView[] = [
    { id: 0, key: 'm0', name: 'Reader', role: 'user', text: 'Hello there', turn: 1 },
    { id: 1, key: 'm1', name: 'Her', role: 'assistant', text: 'A reply that must stay on screen', turn: 1 },
  ]
  wired.store.setState({ chatId: 'c1', view: { chatId: 'c1', title: 'A chat', messages } })
  const root = createRoot(container)
  const slots = createIrisSlots()
  // React reports every caught render error on the console; the assertion is
  // about what the page does, so the noise is held for the duration.
  const quiet = console.error
  console.error = () => undefined
  try {
    await act(async () => root.render(
      <SlotProvider core={slots.core}><StoreProvider store={wired.store}>
        <SettingsPage route="usage" active>
          <Exploding />
          <p id="sibling-panel">the next panel on this page</p>
        </SettingsPage>
        <RegionBoundary region="composer"><Exploding /></RegionBoundary>
        <ChatPane onOpenSettings={() => {}} />
      </StoreProvider></SlotProvider>,
    ))
    const failed = [...container.querySelectorAll('.iris-region-failed')].map(node => node.textContent ?? '')
    assert.equal(failed.length, 2, 'each throwing region should draw exactly one failure line')
    assert.match(failed[0] ?? '', /settings\/usage.*panel exploded/)
    assert.match(failed[1] ?? '', /composer.*panel exploded/)
    assert.ok(container.querySelector('#sibling-panel'), 'the sibling panel was taken down with the failing one')
    assert.ok(container.textContent?.includes('A reply that must stay on screen'), 'the reading pane was unmounted')
    const log = wired.store.getState().noticeLog.map(notice => notice.text).join('\n')
    assert.match(log, /settings\/usage region failed to render.*panel exploded/)
    assert.match(log, /composer region failed to render/)
  } finally {
    console.error = quiet
    await act(async () => root.unmount())
    wired.dispose()
    slots.dispose()
  }
}
