/**
 * `NoticeLog` renders at a bounded rate under a flood of refused requests,
 * and the row it shows still counts every one (#189's leftover 2).
 *
 * The flood harness is `notice-log-render-harness.tsx`; renders are React's
 * `Profiler` commits for the real component.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

test('3,000 refused fonts over ~2 s: NoticeLog renders a bounded number of times, counts stay exact', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const win = dom.window
  win.localStorage.setItem('iris.language', 'en')
  const replacements = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const saved = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
  })
  try {
    const harness = await server.ssrLoadModule('/tests/notice-log-render-harness.tsx') as typeof import('./notice-log-render-harness.tsx')
    const { BLOCKED_NOTICE_FLUSH_MS } = await server.ssrLoadModule('/src/client/store.ts') as typeof import('../src/client/store.ts')
    const result = await harness.flood(win.document.getElementById('root')!, 3_000, 2_000)
    if (process.env['NOTICE_RENDER_DEBUG'] === '1') console.log(JSON.stringify(result))
    assert.equal(result.reports, 3_000)
    assert.equal(result.counted, 3_000, 'every refusal is on the record')
    assert.equal(result.rows, 2, 'two hosts, two rows')
    assert.equal(result.shownCount, '×1500', 'the newest row shows its exact count')
    // At most one flush per interval, plus the trailing one; each flush is one
    // store write and so at most one render.
    const bound = Math.ceil(result.elapsedMs / BLOCKED_NOTICE_FLUSH_MS) + 1
    assert.ok(result.renders <= bound, `NoticeLog rendered ${String(result.renders)} times for 3,000 reports in ${String(result.elapsedMs)} ms (bound ${String(bound)})`)
  } finally {
    await server.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})
