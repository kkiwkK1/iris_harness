import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

/*
 * The tree map's segment hover cards, rendered for real: focusing a folded run
 * shows its stored summary, hovering a lane segment offers 「summarize this
 * segment」, the button sends exactly that segment, and nothing — mounting,
 * hovering, the summarize-all confirm — spends a request on its own.
 */
test('hovering a segment shows its summary, and only the button asks for one', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const win = dom.window
  win.localStorage.setItem('iris.language', 'en')
  const replacements = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, localStorage: win.localStorage, Node: win.Node,
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
    const harness = await server.ssrLoadModule('/tests/segment-summary-harness.tsx') as {
      checkSegmentHover: (container: HTMLElement, win: Window & typeof globalThis) => Promise<void>
    }
    await harness.checkSegmentHover(win.document.getElementById('root')!, win)
  } finally {
    await server.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})
