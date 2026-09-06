/**
 * Browser entry: boot the DSH web shell with an Iris-authored plugin graph and
 * nothing from the coding-agent client stack.
 *
 * Two pieces normally come from the host process: `window.__ModuleLoader__` (an
 * inline script in the served index — see index.html) and `window.__DSH_BOOT__`
 * (the plugin graph `dsh-client-modules`' node half composes from the enabled
 * loader rows). Until the host plane exists, both are supplied in-page and the
 * plugin is fed through the shell's own `loadBundle` transport seam — the hook
 * DSH itself uses for jsdom tests.
 *
 * Three details here are load-bearing and were established by trial in phase 0
 * (notes/spike/RESULTS.md section 6). Do not "simplify" them:
 *   1. `@deepseek-ai/dsh-client-modules/client` is not an ordinary module — its
 *      body IS a bundle registration — so it is imported DYNAMICALLY, after the
 *      facade in index.html has been installed. A static import hoists above it.
 *   2. The shell waits on one service, `uiRenderer`. Providing it is the seam.
 *   3. Vite needs the `node:module` alias and the three `process.*` defines in
 *      vite.config.ts, or the vendored Cordis Loader will not run in a browser.
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
    /** Boot status, read back by the browser smoke check. */
    __IRIS_BOOT__?: { status: 'booting' | 'ok' | 'failed', error?: string }
  }
}

window.__IRIS_BOOT__ = { status: 'booting' }

// Dynamic, not static: the modules bundle registers itself into the facade the
// moment it executes, so it must not be hoisted above the facade install.
await import('@deepseek-ai/dsh-client-modules/client')

const facade = window.__ModuleLoader__
if (facade === undefined) throw new Error('iris: the module loader facade is missing')
if (!facade.pendingQueue.some(row => row.id === MODULES_ID)) {
  throw new Error('iris: the modules bundle did not reach the facade queue')
}

// The plugin graph the host would otherwise compose. One row: the Iris UI plugin.
window.__DSH_BOOT__ = {
  rev: 'inpage',
  entries: [{ id: PLUGIN_ID, url: `/plugins/${PLUGIN_ID}/client.js?rev=inpage`, rev: 'inpage', immediately: true }],
}

const container = document.getElementById('root')
if (container === null) throw new Error('iris: missing #root')

const entry = new AppWebEntry(container, {
  // Stand in for fetching a built plugin bundle over the network: register the
  // factory directly. A real bundle does exactly this from a classic script.
  loadBundle: (url: string) => {
    if (!url.includes(PLUGIN_ID)) throw new Error(`iris: unexpected bundle request ${url}`)
    window.__ModuleLoader__?.load({
      id: PLUGIN_ID,
      factory: () => irisUiPlugin as unknown as Record<string, unknown>,
    })
    return Promise.resolve()
  },
})

try {
  await entry.run()
  window.__IRIS_BOOT__ = { status: 'ok' }
} catch (error: unknown) {
  window.__IRIS_BOOT__ = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  throw error
}
