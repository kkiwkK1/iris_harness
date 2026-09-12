import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createFakeClient } from '@iris/client-fake'
import type { SystemPluginSnapshot } from '@iris/protocol'
import { createServer } from 'vite'

import { createIrisStore } from '../src/client/store.ts'

test('plugin center renders factual lifecycle, dependency and host-error guidance in both languages', async t => {
  const stored = new Map<string, string>([['iris.language', 'en']])
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
  }
  Object.assign(globalThis, {
    window: {
      localStorage,
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} } },
  })

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'plugin center test' })
  t.after(async () => {
    wired.dispose()
    client.dispose()
    await server.close()
  })
  await wired.store.getState().boot()

  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as {
    renderPluginCenter: (store: typeof wired.store) => string
    setLanguage: (language: 'en' | 'zh') => void
  }
  const render = (): string => harness.renderPluginCenter(wired.store)

  const enabled = render()
  assert.match(enabled, /data-plugin-id="tavern-helper"/)
  assert.match(enabled, /Disable MVU first/)
  assert.match(enabled, /<button[^>]*disabled=""[^>]*title="Disable MVU first\."/)
  assert.match(enabled, /Uninstalling keeps card and chat data/)
  assert.doesNotMatch(enabled, /marketplace|download package/i)

  const current = wired.store.getState().systemPlugins
  assert.ok(current !== undefined)
  const failed: SystemPluginSnapshot = {
    revision: current.revision + 1,
    plugins: current.plugins.map(plugin => plugin.id === 'mvu'
      ? {
          ...plugin,
          enabled: false,
          status: 'error',
          error: 'MVU activation failed because TavernHelper did not publish its API.',
        }
      : plugin),
  }
  wired.store.setState({ systemPlugins: failed })
  const errored = render()
  assert.match(errored, /Host error:/)
  assert.match(errored, /MVU activation failed because TavernHelper did not publish its API/)
  assert.match(errored, />Retry enable<\/button>/)
  assert.match(errored, /Fix the reported cause, then retry enable or uninstall this plugin/)

  harness.setLanguage('zh')
  const chinese = render()
  assert.match(chinese, /宿主错误：/)
  assert.match(chinese, />重试启用<\/button>/)
  assert.match(chinese, /请先处理上述原因/)
})
