/**
 * A streaming delta renders the streaming row and nothing else (review finding
 * `streaming-render-path`; owner report 2026-09-26, "the beautification of
 * floors that are not streaming re-renders with it").
 *
 * The count comes from React itself: a `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub is
 * installed on the global **before** Vite loads React, and React hands it every
 * commit. The walk is `stream-render-harness.tsx`'s.
 */
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

import type { CommitCount } from './stream-render-harness.tsx'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

test('a streaming delta re-renders only the streaming row; start and end are shown at once', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const win = dom.window
  win.localStorage.setItem('iris.language', 'en')
  const commits: CommitCount[] = []
  let count: ((root: never) => CommitCount) | undefined
  const hook = {
    renderers: new Map<number, unknown>(),
    supportsFiber: true,
    isDisabled: false,
    checkDCE() {},
    inject(renderer: unknown) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: never) { if (count !== undefined) commits.push(count(root)) },
  }
  const replacements = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement, localStorage: win.localStorage,
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
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
    const harness = await server.ssrLoadModule('/tests/stream-render-harness.tsx') as typeof import('./stream-render-harness.tsx')
    count = harness.countCommit as unknown as (root: never) => CommitCount
    await harness.checkStreamRender(win.document.getElementById('root')!, commits)
  } finally {
    await server.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})
