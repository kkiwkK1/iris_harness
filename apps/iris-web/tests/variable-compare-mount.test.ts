/**
 * The tree map's 「比较变量」 mode and the ⑂N list's two actions, mounted on the
 * real components under jsdom (the harness is `variable-compare-harness.tsx`).
 */
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

async function mounted(run: (harness: typeof import('./variable-compare-harness.tsx'), root: HTMLElement) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
  const win = dom.window
  win.localStorage.setItem('iris.language', 'en')
  const replacements = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, Element: win.Element, Node: win.Node,
    KeyboardEvent: win.KeyboardEvent, MouseEvent: win.MouseEvent,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const saved = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let server: ViteDevServer | undefined
  try {
    server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
      server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    })
    const harness = await server.ssrLoadModule('/tests/variable-compare-harness.tsx') as typeof import('./variable-compare-harness.tsx')
    await run(harness, win.document.getElementById('root')!)
  } finally {
    await server?.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

/*
 * One jsdom page and one Vite server for both checks, run in order: a server
 * per test doubled this file's share of the suite's CPU, and the suite has a
 * timing-bounded neighbour (`stream-render-mount.test.ts`) that load pushes
 * over its bound.
 */
test('compare mode on the map, then the ⑂N list’s compare and delete', async (t) => {
  await mounted(async (harness, root) => {
    await t.test('compare mode: pick A and B on the map, the diff renders in the margin, swap, Escape leaves', async () => {
      await harness.checkCompareMode(root)
    })
    await t.test('the ⑂N list compares this floor with a branch, and deletes a branch through the tree map’s dialog', async () => {
      await harness.checkForkBadgeActions(root)
    })
  })
})
