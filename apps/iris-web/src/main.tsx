/**
 * Phase-0 spike, step 5: boot the DSH web shell with an Iris-authored plugin
 * graph and nothing from the coding-agent client stack.
 *
 * Two pieces normally come from the host: `window.__ModuleLoader__` (installed
 * by an inline script in the served index — see index.html) and
 * `window.__DSH_BOOT__` (the plugin graph `dsh-client-modules`' node half
 * composes from the enabled loader rows). The spike supplies both in-page and
 * feeds the plugin bundle through the shell's own `loadBundle` transport seam —
 * the hook DSH itself uses for jsdom tests — so the browser plane can be proven
 * before the host plane exists.
 */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import * as irisUiPlugin from './ui-plugin.tsx'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const PLUGIN_ID = 'iris-client-shell'

declare global {
  interface Window {
    __ModuleLoader__?: ClientModuleLoaderTarget
    __DSH_BOOT__?: unknown
    __IRIS_SPIKE__?: { status: 'booting' | 'ok' | 'failed', error?: string }
  }
}

window.__IRIS_SPIKE__ = { status: 'booting' }

// Dynamic, not static: the modules bundle registers itself into the facade the
// moment it executes, so it must not be hoisted above the facade install.
await import('@deepseek-ai/dsh-client-modules/client')

const facade = window.__ModuleLoader__
if (facade === undefined) throw new Error('iris spike: the module loader facade is missing')
if (!facade.pendingQueue.some(row => row.id === MODULES_ID)) {
  throw new Error('iris spike: the modules bundle did not reach the facade queue')
}

// The plugin graph the host would otherwise compose. One row: our own UI plugin.
window.__DSH_BOOT__ = {
  rev: 'spike',
  entries: [{ id: PLUGIN_ID, url: `/plugins/${PLUGIN_ID}/client.js?rev=spike`, rev: 'spike', immediately: true }],
}

const container = document.getElementById('root')
if (container === null) throw new Error('iris spike: missing #root')

const entry = new AppWebEntry(container, {
  // Stand in for fetching a built plugin bundle over the network: register the
  // factory directly. A real bundle does exactly this from a classic script.
  loadBundle: (url: string) => {
    if (!url.includes(PLUGIN_ID)) throw new Error(`iris spike: unexpected bundle request ${url}`)
    window.__ModuleLoader__?.load({
      id: PLUGIN_ID,
      factory: () => irisUiPlugin as unknown as Record<string, unknown>,
    })
    return Promise.resolve()
  },
})

try {
  await entry.run()
  window.__IRIS_SPIKE__ = { status: 'ok' }
} catch (error: unknown) {
  window.__IRIS_SPIKE__ = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  throw error
}
