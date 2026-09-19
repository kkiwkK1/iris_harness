/**
 * The connection panel, mounted in a real document and driven by events.
 *
 * `connection-key-field.test.ts` reads this surface as source and
 * `tools/render-check.tsx` renders it once with `react-dom/server`; both are
 * the right instrument for the decisions they pin, and the wrong one for the
 * authoring row's defect of 2026-09-19. That defect was a **disagreement
 * between what a control displayed and what the state held**, and neither a
 * source read nor a single server render can see a disagreement — it only
 * exists after a `<select>` has been changed, which is a `useState` transition
 * behind an event.
 *
 * So this mounts the real component under React's `act`, against whatever
 * client the test wires, and hands back readers and drivers. It is the same
 * shape as `plugin-center-harness.tsx`, and it is loaded the same way: through
 * vite, because Node's type stripping does not transform JSX.
 *
 * @module iris-web/tests/connection-panel-harness
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import type { IrisStore } from '../src/client/store.ts'
import { StoreProvider } from '../src/client/provider.tsx'
import { ConnectionPanel } from '../src/app/ConnectionPanel.tsx'
import { setLanguage } from '../src/app/i18n/language.ts'

/** What a mounted connection panel hands back to the test driving it. */
export interface MountedConnectionPanel {
  html: () => string
  find: (selector: string) => Element | null
  findAll: (selector: string) => Element[]
  /** The text of the first match, whitespace collapsed; `undefined` if none. */
  text: (selector: string) => string | undefined
  click: (selector: string) => Promise<void>
  /** Move a `<select>` to a value, the way a person moving it does. */
  choose: (selector: string, value: string) => Promise<void>
  /** Type into a text field, through React's own value setter. */
  type: (selector: string, value: string) => Promise<void>
  /**
   * Run `work` inside `act`, and let React finish what it starts.
   *
   * `work` may be async, and that is not a convenience: the store resolves the
   * save RPC on a later turn, and awaiting that *outside* `act` makes React
   * print "an update was not wrapped in act(...)" across a passing test — a
   * warning the next reader then has to learn to ignore.
   */
  settle: (work?: () => void | Promise<void>) => Promise<void>
  unmount: () => Promise<void>
}

/**
 * Mount the panel into `container` and return drivers for it.
 * @param store - the booted store.
 * @param container - an element of a jsdom document.
 * @returns readers and drivers for the mounted panel, plus an unmount.
 */
export async function mountConnectionPanel(
  store: IrisStore,
  container: Element,
): Promise<MountedConnectionPanel> {
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(StoreProvider, { store, children: createElement(ConnectionPanel) }))
  })
  const find = (selector: string): Element | null => container.querySelector(selector)
  const view = container.ownerDocument.defaultView as Window & typeof globalThis
  const must = (selector: string): HTMLElement => {
    const target = find(selector)
    if (target === null) throw new Error(`no element matched ${selector}`)
    return target as HTMLElement
  }
  return {
    html: () => container.innerHTML,
    find,
    findAll: (selector: string) => [...container.querySelectorAll(selector)],
    text: (selector: string) => find(selector)?.textContent?.replace(/\s+/g, ' ').trim(),
    click: async (selector: string) => {
      const target = must(selector)
      await act(async () => { target.click() })
    },
    choose: async (selector: string, value: string) => {
      const target = must(selector) as HTMLSelectElement
      /*
       * Through the prototype's setter, not `target.value = …`.
       *
       * React installs its own `value` property on the element instance to
       * track what it last wrote; a plain assignment updates the DOM and leaves
       * that tracker agreeing with it, so the synthetic `change` event is
       * dropped as "no change" and the component never hears the move. This is
       * the same door `plugin-center-harness.tsx` opens for text inputs, and
       * without it every assertion below would pass on an unfixed panel.
       */
      const setter = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(target, value)
        target.dispatchEvent(new view.Event('change', { bubbles: true }))
      })
    },
    type: async (selector: string, value: string) => {
      const target = must(selector) as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(target, value)
        target.dispatchEvent(new view.Event('input', { bubbles: true }))
      })
    },
    settle: async (work?: () => void | Promise<void>) => { await act(async () => { await work?.() }) },
    unmount: async () => { await act(async () => { root.unmount() }) },
  }
}

export { setLanguage }
