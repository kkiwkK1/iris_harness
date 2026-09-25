import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import { createFakeClient } from '@iris/client-fake'
import type { IrisClient, SystemPluginSnapshot } from '@iris/protocol'
import { createServer } from 'vite'

import { createIrisStore } from '../src/client/store.ts'

/**
 * Ruling 7: Iris's EJS engine is a plugin-center row, and turning it on goes
 * through a risk confirmation.
 *
 * Mounted in jsdom through the shared plugin-center harness (loaded by Vite,
 * because Node's type stripping does not transform JSX), and asserted on
 * **what the client was called with**: a page that showed the dialog and sent
 * the enable anyway would render the same dialog. The dialog is the
 * primitives' `RiskConfirmation`, which portals into `document.body`, so it is
 * looked up there rather than inside the mounted container.
 */

interface RecordedCall { method: string, params: unknown }

const ENGINE = '[data-plugin-id="iris-templates"]'

test('enabling Iris’s EJS engine asks first, cancelling sends nothing, and only an acknowledged confirm enables it', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    fetch: globalThis.fetch,
    navigator: (globalThis as Record<string, unknown>)['navigator'],
  }
  dom.window.localStorage.setItem('iris.language', 'en')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  // The browser-asset probe parks at `loading`, as in the install test.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({
    root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    // The page's enable confirmation is the primitives' `RiskConfirmation`,
    // whose package imports CSS modules Node cannot load; Vite transforms it.
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  })
  const client = createFakeClient({ chunkDelayMs: 0 })
  const calls: RecordedCall[] = []
  const recorder = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => client.onConnectionChange(listener),
  } as unknown as IrisClient

  const wired = createIrisStore(recorder, { transport: 'fake', origin: 'template engine confirm test' })
  await wired.store.getState().boot()
  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as typeof import('./plugin-center-harness.tsx')
  harness.setLanguage('en')
  const page = await harness.mountPluginCenter(wired.store, dom.window.document.getElementById('root')!)

  t.after(async () => {
    await page.unmount()
    wired.dispose()
    client.dispose()
    await server.close()
    globalThis.fetch = previous.fetch
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  })

  const document = dom.window.document
  const enables = (): RecordedCall[] => calls.filter(row => row.method === 'plugin.enable')
  const dialog = (): Element | null => document.querySelector('[role="dialog"]')
  const button = (scope: Element | null, label: string): HTMLButtonElement => {
    const found = [...scope?.querySelectorAll('button') ?? []].find(candidate => candidate.textContent?.trim() === label)
    assert.ok(found !== undefined, `no "${label}" button`)
    return found as HTMLButtonElement
  }
  const click = async (target: HTMLElement): Promise<void> => { await page.settle(() => { target.click() }) }

  // The row says what it is, and what it is not.
  const row = page.find(ENGINE)
  assert.ok(row !== null, 'the plugin center has no row for Iris’s EJS engine')
  assert.equal(row.getAttribute('data-plugin-status'), 'disabled')
  assert.match(row.textContent ?? '', /Iris EJS templates/u)
  assert.match(row.textContent ?? '', /It is not the ST-Prompt-Template extension/u)
  assert.match(row.textContent ?? '', /on this machine, in a contained child process/u)

  // Enable opens the question and sends nothing.
  await click(button(row, 'Enable'))
  assert.ok(dialog() !== null, 'enable ran with no confirmation')
  assert.match(dialog()?.textContent ?? '', /Run card authors’ JavaScript on this machine\?/u)
  assert.match(dialog()?.textContent ?? '', /on this computer rather than in the browser/u)
  assert.equal(enables().length, 0, 'the enable reached the host before it was confirmed')

  // The confirm is unavailable until the acknowledgement is ticked.
  const confirm = button(dialog(), 'Turn on the engine')
  assert.equal(confirm.disabled, true, 'the confirm was available without the acknowledgement')

  // Cancel: nothing sent, row unchanged.
  await click(button(dialog(), 'Keep it off'))
  assert.equal(dialog(), null)
  assert.equal(enables().length, 0, 'cancelling the confirmation enabled the engine')
  assert.equal(page.find(ENGINE)?.getAttribute('data-plugin-status'), 'disabled')

  // Asked again, the box starts unticked: an earlier tick does not carry over.
  await click(button(page.find(ENGINE), 'Enable'))
  const box = dialog()?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  assert.ok(box !== null)
  assert.equal(box.checked, false)
  await click(box)
  assert.equal(button(dialog(), 'Turn on the engine').disabled, false)
  await click(button(dialog(), 'Turn on the engine'))
  assert.equal(dialog(), null)
  assert.deepEqual(enables().map(row => row.params), [{ id: 'iris-templates' }])
  assert.equal(page.find(ENGINE)?.getAttribute('data-plugin-status'), 'enabled')

  // Only this row asks: MVU's enable goes straight through.
  const mvu = page.find('[data-plugin-id="mvu"]')
  await click(button(mvu, 'Disable'))
  await click(button(page.find('[data-plugin-id="mvu"]'), 'Enable'))
  assert.equal(dialog(), null, 'a row that runs no card code asked the template engine’s question')
  assert.deepEqual(enables().map(row => row.params), [{ id: 'iris-templates' }, { id: 'mvu' }])
})

test('with an ST extension also enabled, the engine row says which engine expands prompts', async t => {
  const stored = new Map<string, string>([['iris.language', 'en']])
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
  }
  Object.assign(globalThis, {
    window: {
      localStorage,
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} } },
  })
  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({
    root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    // The page's enable confirmation is the primitives' `RiskConfirmation`,
    // whose package imports CSS modules Node cannot load; Vite transforms it.
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  })
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'template engine both-on test' })
  t.after(async () => {
    wired.dispose()
    client.dispose()
    await server.close()
  })
  await wired.store.getState().boot()
  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as typeof import('./plugin-center-harness.tsx')
  harness.setLanguage('en')

  const base = wired.store.getState().systemPlugins
  assert.ok(base !== undefined)
  const seat = (engineOn: boolean, stOn: boolean): SystemPluginSnapshot => ({
    revision: base.revision + 1,
    plugins: [
      ...base.plugins.map(plugin => plugin.id === 'iris-templates'
        ? { ...plugin, enabled: engineOn, status: engineOn ? 'enabled' as const : 'disabled' as const }
        : plugin),
      {
        id: 'st-prompt-template', name: 'Prompt Template', description: 'The adopted upstream extension.',
        version: '1.17.4.1', apiVersion: 1, dependencies: [], installed: true,
        enabled: stOn, status: stOn ? 'enabled' : 'disabled', origin: 'st-extension',
      },
    ],
  })

  wired.store.setState({ systemPlugins: seat(true, true) })
  const both = harness.renderPluginCenter(wired.store)
  assert.match(both, /data-plugin-template-both/u)
  assert.match(both, /An ST extension \(Prompt Template\) is enabled too/u)

  wired.store.setState({ systemPlugins: seat(true, false) })
  assert.doesNotMatch(harness.renderPluginCenter(wired.store), /data-plugin-template-both/u)
  wired.store.setState({ systemPlugins: seat(false, true) })
  assert.doesNotMatch(harness.renderPluginCenter(wired.store), /data-plugin-template-both/u)

  // And in Chinese the row keeps its own name, not the host's English one.
  harness.setLanguage('zh')
  assert.match(harness.renderPluginCenter(wired.store), /Iris EJS 模板引擎/u)
})
