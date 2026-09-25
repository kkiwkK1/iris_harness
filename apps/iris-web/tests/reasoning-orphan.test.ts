/**
 * A settled reply that is all reasoning and no body.
 *
 * The shape is the owner's 黑兽 floor #33 (2026-09-25): DeepSeek billed all
 * 4086 completion tokens as reasoning, sent no `content`, and the row showed an
 * empty body under a collapsed "Reasoning · N words" label, so the reply read
 * as lost. Upstream shows the same thing and leaves the user to copy the trace
 * into an edit by hand; here the block opens itself, says why the body is
 * empty, and offers that edit (web ledger §130).
 *
 * The healthy shape is held too, because the nearest wrong implementation —
 * opening every trace, or offering the edit on every reply — would pass the
 * orphan case alone.
 *
 * @module iris-web/tests/reasoning-orphan
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer, type ViteDevServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

/** Redacted stand-in with the real trace's shape: the card's planning block, then the prose meant as the body. */
const TRACE = 'Master，小此已经切换到日本語进行思考啦！\n<konatan_planning~>\n- 当前什么情况?\n</konatan_planning~>\n\n横杆搁在槽里，门没栓。'

type Harness = typeof import('./reasoning-orphan-harness.tsx')

/** A jsdom window plus a vite server that can load the harness, torn down on `t.after`. */
async function environment(t: TestContext): Promise<{ harness: Harness, container: Element }> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    window: (globalThis as Record<string, unknown>)['window'],
    document: (globalThis as Record<string, unknown>)['document'],
    navigator: (globalThis as Record<string, unknown>)['navigator'],
    fetch: globalThis.fetch,
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  // The browser-asset probe must not answer during this test, as in the other mounted-row suites.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch

  const server: ViteDevServer = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    // The row reaches the dsh primitives, whose entry imports a CSS module (see quote-scope.test.ts).
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  })
  const harness = await server.ssrLoadModule('/tests/reasoning-orphan-harness.tsx') as Harness
  t.after(async () => {
    await server.close()
    globalThis.fetch = previous.fetch
    Object.assign(globalThis, { window: previous.window, document: previous.document })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  })
  const container = dom.window.document.getElementById('root')
  assert.ok(container !== null)
  return { harness, container }
}

test('a reply that is all reasoning opens its trace and offers it as the body; others do not', async t => {
  const { harness, container } = await environment(t)

  // The orphan: settled, no body.
  const orphan = await harness.mountReasoning(container, { text: '', reasoning: TRACE })
  try {
    assert.equal(orphan.traceShown(), true, 'the whole reply sat behind a collapsed label')
    assert.ok(orphan.note() !== null, 'nothing said why the body is empty')

    await orphan.click('[data-control="reasoning-use-as-reply"]')
    assert.equal(orphan.draft(), TRACE, 'the editor did not open on the trace')
    assert.deepEqual(orphan.edits, [], 'nothing is written before the reader saves')

    await orphan.click('.iris-actions--shown .iris-act')
    assert.deepEqual(orphan.edits, [[33, TRACE]], 'saving did not write the trace into the body')
  } finally {
    await orphan.unmount()
  }

  // The healthy shape: a body beside the trace.
  const healthy = await harness.mountReasoning(container, { text: '横杆搁在槽里。', reasoning: 'planning' })
  try {
    assert.equal(healthy.traceShown(), false, 'a footnote opened itself on an ordinary reply')
    assert.equal(healthy.note(), null, 'an ordinary reply was told its body is empty')
  } finally {
    await healthy.unmount()
  }

  // Still thinking: no body yet, and that is not an empty reply.
  const thinking = await harness.mountReasoning(container, { text: '', reasoning: TRACE, streaming: true })
  try {
    assert.equal(thinking.traceShown(), true, 'a live trace opens itself, as before')
    assert.equal(thinking.note(), null, 'the body was called empty before the model had finished')
  } finally {
    await thinking.unmount()
  }
})
