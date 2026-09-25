import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

test('old-turn navigation mounts its target and keeps the reader there during streaming', async () => {
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
  Object.defineProperties(win.HTMLElement.prototype, {
    clientHeight: { get() { return 400 } },
    scrollHeight: { get() { return Math.max(400, win.document.querySelectorAll('[data-turn-anchor]').length * 200) } },
    scrollTop: {
      get(this: HTMLElement & { testTop?: number }) { return this.testTop ?? 0 },
      set(this: HTMLElement & { testTop?: number }, value: number) {
        this.testTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
      },
    },
  })
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const rows = Array.from(win.document.querySelectorAll('[data-turn-anchor]'))
    const index = rows.indexOf(this)
    const top = index < 0 ? 0 : index * 200 + 24 - (win.document.querySelector('.iris-scroll')?.scrollTop ?? 0)
    return { top, bottom: top + 200, left: 0, right: 800, width: 800, height: 200, x: 0, y: top, toJSON() {} }
  }
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
  })
  try {
    const harness = await server.ssrLoadModule('/tests/turn-navigation-harness.tsx') as typeof import('./turn-navigation-harness.tsx')
    await harness.checkNavigation(win.document.getElementById('root')!)
  } finally {
    await server.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})
