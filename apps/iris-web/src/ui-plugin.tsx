/**
 * The Iris browser plugin the DSH shell mounts.
 *
 * The shell's only service dependency is `uiRenderer`, so whoever provides it
 * owns the entire application surface. That is the seam this whole app hangs
 * from: Iris provides its own renderer and never loads `dsh-client-runtime`,
 * `dsh-client-ui-conversation` or the rest of the coding-agent client stack.
 *
 * Everything created here is created through `ctx.effect`, which means an
 * unmount takes the React root, the store's event subscription and the slot
 * declarations with it, in reverse order. That reversibility is Iris's central
 * claim against SillyTavern, and it starts here rather than being retrofitted.
 *
 * @module iris-web/ui-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.tsx'
import { StoreProvider } from './client/provider.tsx'
import { createIrisStore } from './client/store.ts'
import { createClient } from './client/create-client.ts'
import { SlotProvider } from './slots/Slot.tsx'
import { createIrisSlots } from './slots/slots.ts'

/** What the shell mounts: `scope.uiRenderer.mount(container)` returns a disposer. */
export interface UiRenderer {
  mount(container: HTMLElement): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The application renderer the web shell inject-waits on. */
    uiRenderer: UiRenderer
  }
}

/** Cordis plugin name. */
export const name = 'iris-client-shell'

/**
 * Provide the renderer for this context's fiber.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  // A transport failure has to reach the reader, not the console: a dead socket
  // in a local-first app looks exactly like an app that has stopped working, and
  // the person looking at it is the one who can restart the host.
  //
  // Deferred through a holder because the client is built before the store that
  // will display its failures — the alternative is a circular construction.
  let report: ((error: Error) => void) | undefined
  const built = createClient(error => {
    report?.(error)
  })
  const slots = createIrisSlots()
  ctx.effect(() => slots.dispose, 'iris-client-shell.slots')

  const wired = createIrisStore(built.client, { transport: built.transport, origin: built.origin })
  report = error => {
    wired.store.getState().notify('error', error.message)
  }
  ctx.effect(() => wired.dispose, 'iris-client-shell.store')

  const renderer: UiRenderer = {
    mount(container: HTMLElement): () => void {
      const root = createRoot(container)
      root.render(
        <StrictMode>
          <SlotProvider core={slots.core}>
            <StoreProvider store={wired.store}>
              <App />
            </StoreProvider>
          </SlotProvider>
        </StrictMode>,
      )
      return () => root.unmount()
    },
  }

  ctx.effect(() => ctx.provide('uiRenderer', renderer), 'iris-client-shell.provide(uiRenderer)')
}
