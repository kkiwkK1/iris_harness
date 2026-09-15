import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import type { SystemPluginSnapshot } from '@iris/protocol'
import type { PluginBrowserAssetStatus } from '../src/app/use-plugin-manifest.ts'

/**
 * The retry lifecycle, mounted — the acceptance this file exists for.
 *
 * The unit tests in `plugin-browser-assets.test.ts` cover the decision
 * function and the classifier, but the bug they cannot see is lifecycle: a
 * retry whose in-flight probe was killed by an effect cleanup, so the answer
 * never landed and the row healed only when the ten-second poll happened to
 * refetch. So this file mounts `usePluginBrowserAssets` in jsdom under React
 * `act`, drives fetches with deferred promises the test resolves by hand, and
 * asserts:
 *
 * 1. the first probe fails and the row reads degraded;
 * 2. clicking retry starts a second probe **without advancing the poll
 *    timer** (pinned by counting manifest reads: one per retry, no more);
 * 3. the deferred second fetch resolves success and the row reads loaded
 *    immediately;
 * 4. an **older** probe's response landing after the newer one cannot
 *    overwrite it.
 *
 * Each test file is its own Node process, so the jsdom globals installed here
 * do not leak into the other plugin tests. React is imported dynamically,
 * after the globals exist, because the reconciler binds to them at render.
 */

test('a retried probe lands without the poll timer, and a late older response cannot overwrite it', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    fetch: globalThis.fetch,
    window: (globalThis as Record<string, unknown>)['window'],
    document: (globalThis as Record<string, unknown>)['document'],
    navigator: (globalThis as Record<string, unknown>)['navigator'],
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  // `navigator` is a getter-only global in modern Node; define, don't assign.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

  interface FakeResponse {
    ok: boolean
    status: number
    text: () => Promise<string>
  }
  // The fetch double: every request is parked as a deferred the test resolves
  // by call order, so "deferred second fetch" and "late older response" are
  // both expressible without timers.
  const calls: Array<{ url: string, kind: 'manifest' | 'client', respond: (response: FakeResponse) => void }> = []
  globalThis.fetch = ((input: unknown): Promise<FakeResponse> => {
    const url = String(input)
    return new Promise(resolve => {
      calls.push({
        url,
        kind: url.endsWith('manifest.json') ? 'manifest' : 'client',
        respond: response => resolve(response),
      })
    })
  }) as typeof fetch

  const manifestBody = (revision: number): string => JSON.stringify({
    revision,
    plugins: { demo: { rev: 'abc123def456', client: '/plugins/demo/client.js?rev=abc123def456' } },
  })
  const answer = (call: (typeof calls)[number] | undefined, status: number, body: string): void => {
    assert.ok(call !== undefined, 'no fetch call was available to answer')
    call.respond({ ok: status >= 200 && status < 300, status, text: async () => body })
  }
  const lastCall = (kind: 'manifest' | 'client'): (typeof calls)[number] | undefined =>
    [...calls].reverse().find(row => row.kind === kind)
  const manifestReads = (): number => calls.filter(row => row.kind === 'manifest').length
  const clientProbes = (): number => calls.filter(row => row.kind === 'client').length

  try {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { usePluginBrowserAssets } = await import('../src/app/use-plugin-manifest.ts')

    const snapshot: SystemPluginSnapshot = {
      revision: 7,
      plugins: [{
        id: 'demo',
        name: 'Demo',
        description: 'probe fixture',
        version: '0.0.0',
        apiVersion: 1,
        dependencies: [],
        installed: true,
        enabled: true,
        status: 'enabled',
      }],
    }

    let latest: { statuses: Record<string, PluginBrowserAssetStatus>, retry: (pluginId?: string) => void } | undefined
    function Probe(): null {
      latest = usePluginBrowserAssets(snapshot)
      return null
    }

    const root = createRoot(document.getElementById('root')!)
    let mounted = true
    try {
      await act(async () => {
        root.render(createElement(Probe))
      })

    // Mount: the manifest read is in flight; answer it, and the client probe starts.
    answer(lastCall('manifest'), 200, manifestBody(7))
    await act(async () => {})
    assert.equal(manifestReads(), 1, 'mount should issue exactly one manifest read')
    answer(lastCall('client'), 500, 'server exploded')
    await act(async () => {})
    assert.equal(latest?.statuses['demo']?.phase, 'degraded', 'the first probe failure must read degraded')

    // Click retry. The second probe is deferred and left unresolved on purpose.
    await act(async () => {
      latest?.retry('demo')
    })
    assert.equal(manifestReads(), 2, 'a retry refetches the manifest once — the poll timer has not fired')
    answer(lastCall('manifest'), 200, manifestBody(7))
    await act(async () => {})
    assert.equal(clientProbes(), 2, 'retry issues exactly one new probe')
    const secondProbe = lastCall('client')
    assert.equal(latest?.statuses['demo']?.phase, 'degraded', 'the row waits for the deferred second fetch')

    // Deferred second fetch succeeds — without advancing any timer.
    answer(secondProbe, 200, 'globalThis.__iris_plugin_ready__demo = true')
    await act(async () => {})
    assert.equal(latest?.statuses['demo']?.phase, 'loaded', 'the retried probe must land immediately')

    // A third retry leaves its probe pending; a fourth retry supersedes it.
    // The superseded probe resolves LAST, with a failure, and must not
    // overwrite the newer one's success.
    await act(async () => {
      latest?.retry('demo')
    })
    answer(lastCall('manifest'), 200, manifestBody(7))
    await act(async () => {})
    const supersededProbe = lastCall('client')
    await act(async () => {
      latest?.retry('demo')
    })
    answer(lastCall('manifest'), 200, manifestBody(7))
    await act(async () => {})
    const newerProbe = lastCall('client')
    assert.notEqual(supersededProbe, newerProbe, 'the superseded retry must have issued its own probe')
    answer(newerProbe, 200, 'globalThis.__iris_plugin_ready__demo = true')
    await act(async () => {})
    assert.equal(latest?.statuses['demo']?.phase, 'loaded', 'the newer probe lands')
    answer(supersededProbe, 500, 'late server exploded')
    await act(async () => {})
    assert.equal(latest?.statuses['demo']?.phase, 'loaded', 'a late older response must not overwrite the newer result')
    } finally {
      // Unmount even on a failed assertion: the hook's poll interval would
      // otherwise hold the test process open forever.
      if (mounted) {
        mounted = false
        await act(async () => {
          root.unmount()
        })
      }
    }
  } finally {
    globalThis.fetch = previous.fetch
    Object.assign(globalThis, { window: previous.window, document: previous.document })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>).HTMLElement
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

test('a manifest answering for an older generation mounts as stale, carrying both generations as numbers', async () => {
  // The same fixture as the retry test above (snapshot revision 7), with the
  // manifest answered at 6: the mounted hook must mark the row stale and
  // surface BOTH generations — the catalog's and the manifest's — as numbers
  // a row can show side by side, not fold one into the other.
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    fetch: globalThis.fetch,
    window: (globalThis as Record<string, unknown>)['window'],
    document: (globalThis as Record<string, unknown>)['document'],
    navigator: (globalThis as Record<string, unknown>)['navigator'],
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

  interface FakeResponse {
    ok: boolean
    status: number
    text: () => Promise<string>
  }
  const calls: Array<{ url: string, kind: 'manifest' | 'client', respond: (response: FakeResponse) => void }> = []
  globalThis.fetch = ((input: unknown): Promise<FakeResponse> => {
    const url = String(input)
    return new Promise(resolve => {
      calls.push({
        url,
        kind: url.endsWith('manifest.json') ? 'manifest' : 'client',
        respond: response => resolve(response),
      })
    })
  }) as typeof fetch

  try {
    const { createElement, act } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { usePluginBrowserAssets } = await import('../src/app/use-plugin-manifest.ts')

    const snapshot: SystemPluginSnapshot = {
      revision: 7,
      plugins: [{
        id: 'demo',
        name: 'Demo',
        description: 'stale fixture',
        version: '0.0.0',
        apiVersion: 1,
        dependencies: [],
        installed: true,
        enabled: true,
        status: 'enabled',
      }],
    }

    let latest: { statuses: Record<string, PluginBrowserAssetStatus>, retry: (pluginId?: string) => void } | undefined
    function Probe(): null {
      latest = usePluginBrowserAssets(snapshot)
      return null
    }

    const root = createRoot(document.getElementById('root')!)
    let mounted = true
    try {
      await act(async () => {
        root.render(createElement(Probe))
      })
      const manifestCall = calls.find(row => row.kind === 'manifest')
      assert.ok(manifestCall !== undefined, 'the mount issued no manifest read')
      // Answer for generation 6 while the snapshot says 7: stale, by
      // construction.
      manifestCall.respond({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          revision: 6,
          plugins: { demo: { rev: 'abc123def456', client: '/plugins/demo/client.js?rev=abc123def456' } },
        }),
      })
      await act(async () => {})

      const status = latest?.statuses['demo']
      assert.equal(status?.phase, 'stale', 'a manifest answering for generation 6 under snapshot 7 must read stale')
      assert.equal(status?.expectedRevision, 7)
      assert.equal(status?.manifestRevision, 6)
      assert.equal(typeof status?.expectedRevision, 'number')
      assert.equal(typeof status?.manifestRevision, 'number')
      assert.notEqual(status?.expectedRevision, status?.manifestRevision,
        'the stale row exists to show two generations apart; folding one into the other erases the row')
    } finally {
      if (mounted) {
        mounted = false
        await act(async () => {
          root.unmount()
        })
      }
    }
  } finally {
    globalThis.fetch = previous.fetch
    Object.assign(globalThis, { window: previous.window, document: previous.document })
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>).HTMLElement
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})
