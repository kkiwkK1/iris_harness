/**
 * The reader's quote-colour preference: stored, and live.
 *
 * Two claims, and they fail for different reasons. **Stored**: the choice
 * round-trips through `localStorage` under its own key, and a value that is
 * neither word degrades to the default rather than building a scan out of it —
 * the same shape `body-tag.test.ts` holds `iris.bodyTag` to. **Live**: a
 * message already on the reading surface re-colours itself the moment the
 * setting changes, which is true only while `quoteScope` is in the marking
 * effect's dependency list. The second is asserted against a mounted row,
 * because a dependency list is exactly the kind of claim that reads as correct
 * in the source and does nothing on the page.
 *
 * @module iris-web/tests/quote-scope
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import { createServer } from 'vite'

import { QUOTE_SCOPE_DEFAULT, type QuoteScope } from '../src/app/quoted-dialogue.ts'

/** A reply with one line of speech and one bracketed term, so the two scopes disagree by exactly one. */
const REPLY = '她说“我明白了”，然后把「资格」两个字念了一遍。'

test('the preference round-trips, notifies, and degrades to the default on a corrupt store', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const previous = (globalThis as Record<string, unknown>)['window']
  Object.assign(globalThis, { window: dom.window, localStorage: dom.window.localStorage })
  try {
    // Imported after the window exists: the module reads the store once, at
    // load, exactly as `body-tag.ts` and `language.ts` do.
    const store = await import(`../src/app/quote-scope.ts?fresh=${String(Date.now())}`) as {
      getQuoteScope: () => QuoteScope
      setQuoteScope: (scope: QuoteScope) => void
      subscribeQuoteScope: (listener: () => void) => () => void
    }

    assert.equal(QUOTE_SCOPE_DEFAULT, 'dialogue', 'Iris colours speech only until the reader says otherwise')
    assert.equal(store.getQuoteScope(), 'dialogue', 'an empty store reads as the default')

    let notified = 0
    const dispose = store.subscribeQuoteScope(() => { notified += 1 })

    store.setQuoteScope('upstream')
    assert.equal(store.getQuoteScope(), 'upstream')
    assert.equal(notified, 1, 'the row was not told')
    assert.equal(
      dom.window.localStorage.getItem('iris.quoteScope'),
      'upstream',
      'the choice did not reach the device store',
    )

    store.setQuoteScope('upstream')
    assert.equal(notified, 1, 'choosing what is already chosen is not a change')

    store.setQuoteScope('dialogue')
    assert.equal(notified, 2)
    assert.equal(dom.window.localStorage.getItem('iris.quoteScope'), 'dialogue')
    dispose()

    store.setQuoteScope('upstream')
    assert.equal(notified, 2, 'the disposer did not unsubscribe')

    // A hand-edited or corrupt value is not a scope: the next load must read
    // the default rather than carry the word into the rule.
    dom.window.localStorage.setItem('iris.quoteScope', '「…」')
    const reloaded = await import(`../src/app/quote-scope.ts?fresh=${String(Date.now())}-corrupt`) as {
      getQuoteScope: () => QuoteScope
    }
    assert.equal(reloaded.getQuoteScope(), 'dialogue')
  } finally {
    Object.assign(globalThis, { window: previous })
    dom.window.close()
  }
})

test('a message on screen re-colours itself when the setting flips', async t => {
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
  // The browser-asset probe must not answer during this test; a never-settling
  // fetch is what the other mounted-row suites use for the same reason.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    /*
     * The row reaches the dsh primitives (`writeClipboard`, `MarkdownText`),
     * whose entry imports a CSS module. Vite externalises dependencies for SSR
     * by default, so Node would be handed `StateDot.module.css` to load as a
     * module and the mount would die before any prose rendered — the same toll
     * `connection-authoring-row.test.ts` pays, with the same one line.
     */
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  })
  const harness = await server.ssrLoadModule('/tests/quote-scope-harness.tsx') as {
    mountMessage: (container: Element, text: string) => Promise<{
      quotes: () => number
      text: () => string
      settle: (work?: () => void) => Promise<void>
      unmount: () => Promise<void>
    }>
    getQuoteScope: () => QuoteScope
    setQuoteScope: (scope: QuoteScope) => void
  }

  const container = dom.window.document.getElementById('root')
  assert.ok(container !== null)
  const page = await harness.mountMessage(container, REPLY)

  t.after(async () => {
    await page.unmount()
    await server.close()
    harness.setQuoteScope('dialogue')
    globalThis.fetch = previous.fetch
    Object.assign(globalThis, { window: previous.window, document: previous.document })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  })

  const reading = page.text()
  assert.equal(harness.getQuoteScope(), 'dialogue', 'the row mounted under a scope nobody chose')
  assert.equal(page.quotes(), 1, 'the settled reply did not colour its one line of speech')

  await page.settle(() => { harness.setQuoteScope('upstream') })
  assert.equal(page.quotes(), 2, 'the row did not hear the setting change — is `quoteScope` in the effect’s deps?')

  await page.settle(() => { harness.setQuoteScope('dialogue') })
  assert.equal(page.quotes(), 1, 'and back: 「资格」 is a term again')
  assert.equal(page.text(), reading, 'the reader’s characters changed under the re-marking')
})
