import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ScriptContext } from '@iris/protocol'

import { installSandbox, type FrameEnv } from '../src/sandbox/frame.ts'
import type { FromFrame, ToFrame } from '../src/sandbox/protocol.ts'
import { runCard, type RunnerHost } from '../src/sandbox/runner.ts'
import { buildSrcdoc } from '../src/sandbox/srcdoc.ts'
import type { SandboxPluginRuntime } from '../src/sandbox/system-plugin-runtime.ts'
import { MEMBERS } from './members-table.ts'

const disabled: SandboxPluginRuntime = { revision: 4, tavernHelper: false, mvu: false }
const helperOnly: SandboxPluginRuntime = { revision: 5, tavernHelper: true, mvu: false }
const enabled: SandboxPluginRuntime = { revision: 6, tavernHelper: true, mvu: true }

test('a capability-free interface srcdoc keeps the card HTML', () => {
  const doc = buildSrcdoc('tok', 'http://iris.test/sandbox/bootstrap.js', {
    networkGranted: false,
    libraries: [],
    selfOrigin: 'http://iris.test',
    body: '<article id="static-card">still visible</article>',
    systemPlugins: disabled,
  })

  assert.match(doc, /id="static-card">still visible/)
  assert.match(doc, /iris-system-plugins/)
  assert.match(doc, /&quot;tavernHelper&quot;:false/)
})

function frame(runtime: SandboxPluginRuntime): {
  published: Map<string, unknown>
  send(message: ToFrame): void
  mvuUpdates(): number
  storageInstalls(): number
} {
  const published = new Map<string, unknown>()
  const listeners: Array<(message: ToFrame) => void> = []
  let mvuUpdates = 0
  let storageInstalls = 0
  const members = {
    ...MEMBERS,
    restoreFloorTables: (...args: Parameters<typeof MEMBERS.restoreFloorTables>) => {
      mvuUpdates += 1
      return MEMBERS.restoreFloorTables(...args)
    },
    sealLegacyCleanup: (...args: Parameters<typeof MEMBERS.sealLegacyCleanup>) => {
      mvuUpdates += 1
      return MEMBERS.sealLegacyCleanup(...args)
    },
  }
  const env: FrameEnv = {
    members,
    token: 'tok',
    systemPlugins: runtime,
    interfaceFrame: true,
    container: { querySelector: () => null, querySelectorAll: () => [] },
    factory: {
      createElement: tagName => ({ tagName, style: {}, setAttribute: () => undefined }),
      createTextNode: data => ({ data }),
      createDocumentFragment: () => ({}),
    },
    realWindow: { fetch: () => Promise.resolve(new Response('')) },
    post: (_message: FromFrame) => undefined,
    onMessage: listener => listeners.push(listener),
    evaluate: () => undefined,
    publishGlobals: entries => {
      for (const [name, value] of entries) published.set(name, value)
    },
    provideStorage: () => {
      storageInstalls += 1
    },
  }
  installSandbox(env)
  return {
    published,
    send: message => listeners.forEach(listener => listener(message)),
    mvuUpdates: () => mvuUpdates,
    storageInstalls: () => storageInstalls,
  }
}

test('TH and MVU capabilities disappear independently while static frames still install', () => {
  const none = frame(disabled)
  assert.equal(none.published.has('TavernHelper'), false)
  assert.equal(none.published.has('SillyTavern'), false)
  assert.equal(none.storageInstalls(), 0)

  const helper = frame(helperOnly)
  assert.equal(helper.published.has('TavernHelper'), true)
  assert.equal(helper.published.has('Mvu'), false)
  assert.equal(helper.published.has('mvu_events'), false)
  const nested = helper.published.get('TavernHelper') as Record<string, unknown>
  assert.equal(Object.hasOwn(nested, 'mvu_events'), false)

  const parent = helper.published.get('parent') as Record<string, unknown>
  assert.throws(() => { parent['Mvu'] = {} }, /MVU system plugin is disabled/)
  parent['unrelated_runtime'] = { alive: true }
  assert.deepEqual(parent['unrelated_runtime'], { alive: true })
  const initialize = helper.published.get('initializeGlobal') as (name: string, value: unknown) => void
  assert.throws(() => initialize('Mvu', {}), /MVU system plugin is disabled/)
  initialize('unrelated_global', 1)
  assert.equal(parent['unrelated_global'], 1)
})

test('MVU-specific context processing runs only in an MVU-enabled incarnation', () => {
  const context = { chat: [], extensionSettings: {} } as unknown as ScriptContext
  const helper = frame(helperOnly)
  helper.send({ iris: 'tok', type: 'context', context, floor: 0 })
  assert.equal(helper.mvuUpdates(), 0)

  const mvu = frame(enabled)
  mvu.send({ iris: 'tok', type: 'context', context, floor: 0 })
  assert.equal(mvu.mvuUpdates(), 2)
})

function runnerHarness() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const docListeners = new Map<string, Set<(event: unknown) => void>>()
  const calls: Array<{ method: string, params: unknown }> = []
  const makeCard = (runtime: SandboxPluginRuntime) => {
    const posted: Record<string, unknown>[] = []
    const contentWindow = { postMessage: (message: unknown) => posted.push(message as Record<string, unknown>) }
    const element = {
      style: { setProperty: () => undefined, removeProperty: () => undefined },
      dataset: {} as Record<string, string>,
      contentWindow,
      srcdoc: '',
      setAttribute: () => undefined,
      remove: () => undefined,
    }
    const view = {
      location: { origin: 'http://iris.test', href: 'http://iris.test/chat' },
      fetch: () => Promise.resolve(new Response('')),
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener)
      },
    }
    const document = {
      defaultView: view,
      hidden: false,
      createElement: () => element,
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const set = docListeners.get(type) ?? new Set()
        set.add(listener)
        docListeners.set(type, set)
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        docListeners.get(type)?.delete(listener)
      },
    }
    const host: RunnerHost = {
      systemPlugins: runtime,
      bootstrapUrl: 'http://iris.test/sandbox/bootstrap.js',
      scripts: [{ id: 'script', code: ';' }],
      mode: 'classic',
      libraries: [],
      documentGranted: false,
      networkGranted: false,
      bundleOrigin: 'http://iris.test',
      context: {} as ScriptContext,
      viewport: () => ({ width: 800, height: 600 }),
      fetch: async () => '',
      onSettings: () => undefined,
      onSlash: async () => '',
      onDialog: () => undefined,
      onPopup: () => undefined,
      onPopupWithdrawn: () => undefined,
      onCall: async (method, params) => {
        calls.push({ method, params })
        return {}
      },
      onError: () => undefined,
      onBlocked: () => undefined,
    }
    const card = runCard(host, document as unknown as Document)
    const token = /name="iris-token" content="([0-9a-f]+)"/.exec(card.element.srcdoc)?.[1]
    assert.ok(token)
    return {
      card,
      posted,
      send: (message: Record<string, unknown>) => {
        for (const listener of listeners.get('message') ?? []) {
          listener({ source: contentWindow, data: { iris: token, ...message } })
        }
      },
    }
  }
  return { makeCard, calls, listenerCount: (type: string) => listeners.get(type)?.size ?? 0 }
}

test('remounts keep old requests fenced and old ready messages inert after disposal', async () => {
  const harness = runnerHarness()
  const old = harness.makeCard({ revision: 10, tavernHelper: true, mvu: true })
  const next = harness.makeCard({ revision: 12, tavernHelper: true, mvu: false })

  old.send({ type: 'call', id: 'old-call', method: 'setVariables', params: { value: 1 } })
  next.send({ type: 'call', id: 'new-call', method: 'setVariables', params: { value: 2 } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(
    harness.calls.map(call => (call.params as Record<string, unknown>)['pluginRevision']),
    [10, 12],
  )

  old.card.dispose()
  assert.equal(harness.listenerCount('message'), 1)
  const before = old.posted.length
  old.send({ type: 'ready' })
  assert.equal(old.posted.length, before)

  next.send({ type: 'ready' })
  assert.equal(next.posted.some(message => message.type === 'run'), true)
  next.card.dispose()
  assert.equal(harness.listenerCount('message'), 0)
})
