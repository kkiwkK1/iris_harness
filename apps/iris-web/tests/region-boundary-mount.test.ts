import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

/*
 * A render failure stays in its region: a throwing settings panel leaves its
 * sibling panel and the reading pane mounted, and says so in the notice log.
 * Mounted through Vite + JSDOM because the unit under test is React's own
 * error-boundary behaviour, which only a real render exercises.
 */
test('a throwing panel fails small: its sibling and the chat stay mounted, and the notice log says so', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const win = dom.window
  win.localStorage.setItem('iris.language', 'en')
  const replacements = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, localStorage: win.localStorage,
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const saved = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
  })
  try {
    const harness = await server.ssrLoadModule('/tests/region-boundary-harness.tsx') as {
      checkContainment: (container: HTMLElement) => Promise<void>
    }
    await harness.checkContainment(win.document.getElementById('root')!)
  } finally {
    await server.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})
