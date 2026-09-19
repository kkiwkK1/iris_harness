/**
 * The authoring row: choosing a provider, and 「用它写插件」 lighting up.
 *
 * The defect this file was written for (owner, 2026-09-19, on `40460d7`): pick
 * a provider in the 「写插件用」 row, watch the model control fill in with a
 * model name — and the button stays dark. The cause was one line. The model
 * control is a **controlled `<select>`** whose options are the provider's
 * models plus the 「自定义…」 sentinel, and none of them carries `''`; the draft
 * started at `{ id: '', model: '' }` and moving the provider wrote only `id`.
 * A browser cannot display "no option", so it displayed the first model, while
 * React state stayed `''` — and `disabled` was reading the state. The two only
 * agreed again after the reader moved the selection away and back, which is a
 * thing nobody does to a control that already shows the right answer.
 *
 * Three claims are pinned, in the order a reader meets them:
 *
 * 1. **A provider with models arms the button in one move.** Read immediately
 *    after the change, with no second interaction — that "immediately" is the
 *    whole bug, since a second move fixed it before and would hide it here.
 *    And the draft's model is checked against *what the control displays*, not
 *    merely against non-empty: the failure being excluded is a disagreement
 *    between the two, so an assertion that looks at only one side cannot see it.
 * 2. **A provider with no list keeps the hand-typed path**, disabled until
 *    something is typed. This is the direction a `disabled` relaxed to "an id
 *    is chosen" would have broken, and the reason the fix is on the state.
 * 3. **What is saved is the displayed pair**, measured at the client call and
 *    in the store afterwards, with the row's own sentence reading it back.
 *
 * Mounted in jsdom under `act` rather than server-rendered, because all three
 * live behind an event; `connection-panel-harness.tsx` says more about that.
 * The fake client refuses `connection.authoring` (it keeps no connection file),
 * so the third claim runs against a recorder that answers it and remembers what
 * it was asked — the same door `plugin-center-install.test.ts` opens, and the
 * stronger measurement anyway: what the panel *sent* is the fact, and the page
 * never renders it.
 *
 * @module iris-web/tests/connection-authoring-row
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import { createFakeClient } from '@iris/client-fake'
import type { IrisClient } from '@iris/protocol'
import { createServer } from 'vite'

import { createIrisStore, type IrisStore } from '../src/client/store.ts'
import type { MountedConnectionPanel } from './connection-panel-harness.tsx'

/** One RPC the panel made, with what it sent. */
interface RecordedCall { method: string, params: unknown }

/** The row's two controls and its button, addressed inside their own block. */
const BLOCK = '[data-block="authoring"]'
const PROVIDER = `${BLOCK} select[aria-label="Provider"]`
const MODEL_SELECT = `${BLOCK} select[aria-label="Model"]`
const MODEL_INPUT = `${BLOCK} input[aria-label="Model"]`
const NOTE = `${BLOCK} .iris-field__note`

/**
 * The 「用它写插件」 button, found by its words rather than by position.
 *
 * The row holds a second control in the same actions strip — 「清除」, present
 * only while something is stored — so `button:first-of-type` would name
 * different elements in the two states this file drives.
 * @param page - the mounted panel.
 * @returns the button.
 */
function saveButton(page: MountedConnectionPanel): HTMLButtonElement {
  const found = page.findAll(`${BLOCK} button`)
    .find(button => button.textContent?.includes('Use for writing plugins'))
  assert.ok(found !== undefined, 'the authoring row has no 「use for writing plugins」 button')
  return found as HTMLButtonElement
}

/**
 * What the model `<select>` is actually showing.
 *
 * Read off the DOM's own selection rather than off React's `value` prop, which
 * is the point: in the defect these two disagreed, and only the browser's
 * answer is what the reader sees.
 * @param page - the mounted panel.
 * @returns the displayed model name.
 */
function displayedModel(page: MountedConnectionPanel): string {
  const select = page.find(MODEL_SELECT)
  assert.ok(select !== null, 'the model control is not a select, so the provider advertised no models')
  return (select as HTMLSelectElement).value
}

test('the authoring row, driven by its own controls', async t => {
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
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    /*
     * The one line here that is not boilerplate, and it is the line this file
     * was first written without: `ConnectionPanel.tsx` takes `Button` and
     * `Modal` from the dsh primitives, whose entry imports a CSS module. Vite
     * externalises dependencies for SSR by default, so Node was handed
     * `StateDot.module.css` to load as a module and the mount died before the
     * panel rendered anything. Naming the package hands it to Vite's own
     * pipeline, which turns that import into nothing —
     * `sandbox-plugin-panel.test.ts` pays the same toll for `UsagePanel.tsx`.
     */
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  })
  const client = createFakeClient({ chunkDelayMs: 0 })

  /*
   * Everything the panel sends, and an answer for the one method the fake
   * refuses. `connection.authoring` is refused there deliberately — a client
   * with no connection file cannot keep the setting — so the alternative to
   * this recorder is teaching the fake to keep one, which is a bigger change to
   * the development model than this file is owed.
   */
  const calls: RecordedCall[] = []
  let stored: { id: string, model: string } | undefined
  const recorder = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'connection.authoring') {
        const next = params as { id?: string, model?: string }
        stored = next.id === undefined || next.model === undefined
          ? undefined
          : { id: next.id, model: next.model }
        return stored === undefined ? {} : { authoring: stored }
      }
      if (method === 'connection.list') {
        const listed = await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> })
          .call(method, params) as Record<string, unknown>
        return stored === undefined ? listed : { ...listed, authoring: stored }
      }
      return (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => client.onConnectionChange(listener),
  } as unknown as IrisClient

  const wired = createIrisStore(recorder, { transport: 'fake', origin: 'authoring row test' })

  /*
   * Registered before anything below can throw, which is not tidiness.
   *
   * The vite server and the fake client both hold the event loop open, so a
   * failure *before* a teardown was registered did not report a failure at all:
   * the runner printed nothing and hung until it was killed, and the actual
   * error (the CSS module above) was only readable by importing the file by
   * hand. A teardown that runs on the bad path is what makes a broken setup say
   * so.
   */
  let page: MountedConnectionPanel | undefined
  t.after(async () => {
    await page?.unmount()
    wired.dispose()
    client.dispose()
    await server.close()
    globalThis.fetch = previous.fetch
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT']
  })

  await wired.store.getState().boot()
  await wired.store.getState().loadConnections()

  const harness = await server.ssrLoadModule('/tests/connection-panel-harness.tsx') as {
    mountConnectionPanel: (store: IrisStore, container: Element) => Promise<MountedConnectionPanel>
  }
  page = await harness.mountConnectionPanel(wired.store, dom.window.document.getElementById('root')!)
  const mounted = page

  /*
   * The fixtures this file stands on, asserted rather than assumed: a provider
   * that advertises models and one that never has. Without both, two of the
   * three claims below would be checking an empty branch and passing.
   */
  const profiles = wired.store.getState().connections
  const withModels = profiles.find(row => (row.models?.length ?? 0) > 1)
  const withoutModels = profiles.find(row => row.models === undefined)
  assert.ok(withModels !== undefined, 'the seed must carry a provider with a probed model list')
  assert.ok(withoutModels !== undefined, 'the seed must carry a provider that has never been probed')

  await t.test('choosing a provider with models arms the button in one move', async () => {
    assert.equal(saveButton(mounted).disabled, true, 'the button should start disabled with nothing chosen')

    await mounted.choose(PROVIDER, withModels.id)

    // Read now. A second interaction was what used to fix this, so anything
    // between the change and this line would hide the defect rather than catch it.
    assert.equal(
      saveButton(mounted).disabled,
      false,
      'the button is still disabled right after a provider with models was chosen',
    )
    // And the state matches what the control displays, which is the property
    // the button was lying about.
    const shown = displayedModel(mounted)
    assert.ok(withModels.models?.includes(shown) === true, `the control shows ${shown}, which the provider does not advertise`)
    assert.equal(shown, withModels.models?.[0], 'the control should open on the provider’s first model')
  })

  await t.test('a provider with no list keeps the hand-typed path, disabled until typed', async () => {
    await mounted.choose(PROVIDER, withoutModels.id)

    assert.equal(mounted.find(MODEL_SELECT), null, 'an unprobed provider should not render a dropdown')
    const field = mounted.find(MODEL_INPUT)
    assert.ok(field !== null, 'an unprobed provider should fall back to a text field')
    /*
     * The previous provider's model does not follow into the field. Carrying it
     * would arm the button over a model this endpoint has never been asked
     * about — the exact pairing the draft exists to prevent — and it is also
     * what a `disabled` relaxed to "an id is chosen" would have produced.
     */
    assert.equal((field as HTMLInputElement).value, '', 'the previous provider’s model followed into the field')
    assert.equal(saveButton(mounted).disabled, true, 'the button is armed over an empty model')

    await mounted.type(MODEL_INPUT, 'some-beta-model')
    assert.equal(saveButton(mounted).disabled, false, 'the button stays disabled over a hand-typed model name')
  })

  await t.test('what is saved is the pair that was displayed', async () => {
    await mounted.choose(PROVIDER, withModels.id)
    const shown = displayedModel(mounted)

    // The click starts an RPC that the store resolves a turn later, so the wait
    // for it happens *inside* `act` — see `settle` in the harness.
    await mounted.settle(async () => {
      saveButton(mounted).click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })

    const sent = calls.filter(entry => entry.method === 'connection.authoring')
    assert.equal(sent.length, 1, 'the button should have sent exactly one setting')
    assert.deepEqual(sent[0]?.params, { id: withModels.id, model: shown }, 'the pair sent is not the pair displayed')
    assert.deepEqual(
      wired.store.getState().authoringConnection,
      { id: withModels.id, model: shown },
      'the store does not report the saved pair',
    )
    // And the row says it back, which is what the reader has to go on.
    const note = mounted.text(NOTE)
    assert.ok(note !== undefined && note.includes(shown), `the row’s sentence does not name the model: ${String(note)}`)

    /*
     * The round trip through `connection.list`, which is the read the composer's
     * 「创造」 entry depends on: a host that answered the write and then omitted
     * `authoring` from the list would leave that entry dark forever, and the
     * panel would still look right.
     */
    calls.length = 0
    /*
     * Cleared first, and this line is the assertion's teeth rather than
     * housekeeping. The write's own answer already put the pair in the store,
     * so a re-read that does not clear it passes over a `loadConnections` that
     * ignores the field entirely — measured, 2026-09-20: deleting
     * `authoringConnection: listed.authoring` from `store.ts` left this test
     * green until the clear was added.
     */
    wired.store.setState({ authoringConnection: undefined })
    await mounted.settle(async () => { await wired.store.getState().loadConnections() })
    assert.ok(calls.some(entry => entry.method === 'connection.list'), 'the reload did not read the list')
    assert.deepEqual(
      wired.store.getState().authoringConnection,
      { id: withModels.id, model: shown },
      'the setting did not survive a re-read of connection.list',
    )
  })

  await t.test('a reload reads the setting back, which is what the composer waits for', async () => {
    /*
     * A second store over the same host, booted from cold — the page after a
     * refresh. It is a separate read from the one above: `loadConnections` is
     * what the connection card calls, and `boot` is what everybody else gets,
     * including a reader who never opens the card. The composer's 「创造」
     * entry is dark until this field is set, so a boot that skipped it would
     * leave the entry dark until the card was opened — which is the entry
     * lying about a setting that is stored.
     */
    const reloaded = createIrisStore(recorder, { transport: 'fake', origin: 'authoring row reload' })
    try {
      await reloaded.store.getState().boot()
      assert.deepEqual(
        reloaded.store.getState().authoringConnection,
        { id: withModels.id, model: withModels.models?.[0] },
        'a cold boot did not carry the stored authoring setting into the store',
      )
    } finally {
      reloaded.dispose()
    }
  })
})
