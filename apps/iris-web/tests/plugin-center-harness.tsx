import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'

import type { SystemPluginInstallPreview } from '@iris/protocol'
import type { IrisStore } from '../src/client/store.ts'
import { StoreProvider } from '../src/client/provider.tsx'
import { PluginCenter, PluginConsent, installFormProblem } from '../src/app/PluginCenter.tsx'
import { setLanguage } from '../src/app/i18n/language.ts'
import type { Language } from '../src/app/i18n/strings.ts'

export function renderPluginCenter(store: IrisStore): string {
  // React's server snapshot otherwise stays at Zustand's construction state;
  // this harness needs the host state loaded by boot, as a mounted browser does.
  const api = store as IrisStore & { getInitialState: () => ReturnType<IrisStore['getState']> }
  api.getInitialState = () => store.getState()
  return renderToString(<StoreProvider store={store}><PluginCenter /></StoreProvider>)
}

/**
 * The consent page on its own, in whatever state the caller names.
 *
 * `PluginConsent` is a pure function of its props, which is the only way to
 * render the states the fake client cannot produce — an `incompatible` preview
 * above all: `FakeSystemPlugins.previewInstall` always answers
 * `compatible: true`, and the alternative to this door is a seam that lets the
 * fake lie about compatibility, which buys a worse model of the host in
 * exchange for a worse test.
 * @param preview - the staged package to describe.
 * @param lang - which dictionary to render in.
 * @returns the rendered markup.
 */
export function renderConsent(preview: SystemPluginInstallPreview, lang: Language = 'en'): string {
  return renderToString(<PluginConsent
    preview={preview}
    lang={lang}
    busy={false}
    error={undefined}
    onConfirm={() => {}}
    onCancel={() => {}}
  />)
}

/** What a mounted plugin center hands back to the test driving it. */
export interface MountedPluginCenter {
  html: () => string
  find: (selector: string) => Element | null
  click: (selector: string) => Promise<void>
  type: (selector: string, value: string) => Promise<void>
  /** Flush React's queue, optionally running `work` inside the same `act`. */
  settle: (work?: () => void) => Promise<void>
  unmount: () => Promise<void>
}

/**
 * Mount the plugin center into a real document, for the half of this surface
 * that only exists once something has been clicked.
 *
 * A server render cannot reach the install form's submit, the consent page's
 * two buttons or a `tampered` row's reinstall, because each of them is a
 * `useState` transition behind a click. The caller supplies the container (an
 * element of a jsdom document) and everything here runs inside React's `act`,
 * so the test drives the scheduler rather than racing it.
 * @param store - the booted store.
 * @param container - where to mount.
 * @returns readers and drivers for the mounted tree, plus an unmount.
 */
export async function mountPluginCenter(store: IrisStore, container: Element): Promise<MountedPluginCenter> {
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(StoreProvider, { store, children: createElement(PluginCenter) }))
  })
  const find = (selector: string): Element | null => container.querySelector(selector)
  const view = container.ownerDocument.defaultView as Window & typeof globalThis
  return {
    html: () => container.innerHTML,
    find,
    click: async (selector: string) => {
      const target = find(selector)
      if (target === null) throw new Error(`no element matched ${selector}`)
      await act(async () => { (target as HTMLElement).click() })
    },
    type: async (selector: string, value: string) => {
      const target = find(selector)
      if (target === null) throw new Error(`no element matched ${selector}`)
      const input = target as HTMLInputElement
      // React 18 installs its own `value` setter on the element instance, so a
      // plain assignment is invisible to the synthetic change event. Writing
      // through the prototype's setter is what makes a controlled input take a
      // value without a browser.
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set
      await act(async () => {
        setter?.call(input, value)
        input.dispatchEvent(new view.Event('input', { bubbles: true }))
      })
    },
    settle: async (work?: () => void) => { await act(async () => { work?.() }) },
    unmount: async () => { await act(async () => { root.unmount() }) },
  }
}

export { installFormProblem, setLanguage }
