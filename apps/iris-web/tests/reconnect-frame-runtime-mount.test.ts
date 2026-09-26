/**
 * A reconnect that changed nothing rebuilds no frame run; one that changed
 * something frames can see still does (#189's leftover 1: "reconnect →
 * rebuild → burst of reports → longer main-thread block").
 *
 * The store used to clear the plugin snapshot on every reconnect, so every
 * frame owner keyed on it went `N → undefined → N` and tore its run down
 * twice over. Mounted through Vite's SSR loader because the hook reads the
 * store through `provider.tsx`; the counting is `reconnect-frame-runtime-harness.tsx`'s.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

test('reconnect: identical catalog keeps the run; changed bundle, revision or a failed read rebuilds', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const win = dom.window
  win.localStorage.setItem('iris.language', 'en')
  let manifestBody = ''
  let manifestReads = 0
  const replacements = {
    window: win, document: win.document, navigator: win.navigator,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: unknown) => {
      const url = String(input)
      if (!url.endsWith('manifest.json')) throw new Error(`unexpected fetch ${url}`)
      manifestReads += 1
      const body = manifestBody
      return { ok: true, status: 200, text: async () => body }
    },
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
    const harness = await server.ssrLoadModule('/tests/reconnect-frame-runtime-harness.tsx') as typeof import('./reconnect-frame-runtime-harness.tsx')
    const counts = await harness.checkReconnect(
      win.document.getElementById('root')!,
      body => { manifestBody = body },
      () => manifestReads,
    )
    const { boot, identical, identicalAgain, bundleChanged, revisionChanged, listFailed } = counts
    // Boot builds twice when a plugin has a bundle: once on the catalog, once
    // when the manifest row lands (that frame was built without its tags).
    // Only one run is live at the end of it.
    assert.equal(boot.started - boot.disposed, 1, 'boot leaves one live run')

    // The subject: two reconnects whose plugin.list and manifest are identical.
    assert.ok(identical.manifestReads > boot.manifestReads, 'the reconnect did re-read the manifest (it looked, and found nothing new)')
    assert.equal(identical.disposed, boot.disposed, 'an identical reconnect disposes no run')
    assert.equal(identical.started, boot.started, 'an identical reconnect starts no run')
    assert.equal(identicalAgain.started, boot.started, 'nor does a second one')
    assert.equal(identicalAgain.key, boot.key, 'the run key is unchanged')

    // Controls: each change a frame can observe rebuilds exactly as it must.
    assert.ok(bundleChanged.key?.includes('bbbbbbbbbbbb'), 'the new bundle reached the runtime')
    assert.equal(bundleChanged.disposed, identicalAgain.disposed + 1, 'a changed client bundle at the same revision disposes the run')
    assert.equal(bundleChanged.started, identicalAgain.started + 1, 'and starts one on the new runtime')
    assert.ok(revisionChanged.key?.includes('"revision":9'), 'the new revision reached the runtime')
    assert.ok(revisionChanged.started > bundleChanged.started, 'a changed revision rebuilds')
    assert.ok(revisionChanged.disposed > bundleChanged.disposed, 'and disposes the old run')

    // A failed list leaves the new session with nothing authoritative: no runtime.
    assert.equal(listFailed.key, undefined, 'a reconnect whose plugin.list failed drops the held runtime')
    assert.equal(listFailed.disposed, listFailed.started, 'and every run is disposed')
  } finally {
    await server.close()
    win.close()
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})
