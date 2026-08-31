/**
 * The Iris-authored browser plugin the shell mounts.
 *
 * The point of this file: the DSH web shell's only service dependency is
 * `uiRenderer`. Whoever provides it owns the entire application surface. So a
 * product that is not the coding agent supplies its own renderer here and never
 * loads `dsh-client-runtime`, `dsh-client-ui-conversation`, or the rest of the
 * coding-agent client stack.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

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
export const name = 'iris-spike-ui'

/** One line of evidence rendered into the page and read back by the browser check. */
function Line({ id, children }: { id: string, children: ReactNode }): React.ReactElement {
  return React.createElement('li', { id }, children)
}

/** The spike's application surface. */
function App({ slotCoreOk }: { slotCoreOk: boolean }): React.ReactElement {
  return React.createElement(
    'main',
    { style: { fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.7 } },
    React.createElement('h1', { id: 'iris-heading' }, 'Iris shell spike'),
    React.createElement(
      'ul',
      null,
      React.createElement(Line, { id: 'evidence-shell', key: 'shell' }, 'DSH web shell booted this plugin tree.'),
      React.createElement(Line, { id: 'evidence-renderer', key: 'renderer' }, 'uiRenderer was provided by an Iris plugin, not by dsh-client-runtime.'),
      React.createElement(
        Line,
        { id: 'evidence-slots', key: 'slots' },
        `SlotCore instantiated standalone: ${slotCoreOk ? 'yes' : 'no'}.`,
      ),
    ),
    React.createElement('p', { id: 'iris-verdict' }, 'IRIS_SHELL_SPIKE_OK'),
  )
}

/**
 * Provide the renderer for this context's fiber.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  // The slot registry service lives in dsh-client-runtime, which we are
  // replacing — but its pure core is a separate, dependency-free package, so
  // confirm we can build a registry on it ourselves.
  let slotCoreOk = false
  try {
    void new SlotCore()
    slotCoreOk = true
  } catch {
    slotCoreOk = false
  }

  const renderer: UiRenderer = {
    mount(container: HTMLElement): () => void {
      const root = createRoot(container)
      root.render(React.createElement(App, { slotCoreOk }))
      return () => root.unmount()
    },
  }

  ctx.effect(() => ctx.provide('uiRenderer', renderer), 'iris-spike-ui.provide(uiRenderer)')
}
