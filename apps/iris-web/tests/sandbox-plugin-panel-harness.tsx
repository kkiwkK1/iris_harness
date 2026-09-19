import { renderToString } from 'react-dom/server'

import type { UsageSummary } from '@iris/protocol'

import type { IrisStore } from '../src/client/store.ts'
import { StoreProvider } from '../src/client/provider.tsx'
import { SandboxPluginPanel } from '../src/app/SandboxPluginPanel.tsx'
import { UsageReport } from '../src/app/UsagePanel.tsx'
import { setLanguage } from '../src/app/i18n/language.ts'

/**
 * Server renders of the two surfaces PR-D changes.
 *
 * Both are **projections** — what the page says about a state the host
 * describes a given way — which is the one thing a server render is exactly
 * right for. Nothing here clicks: the panel's one transition (opening the
 * source) is driven through the store in the test, because the interesting half
 * is what the store does with the answer, not what React does with the state.
 *
 * @module iris-web/tests/sandbox-plugin-panel-harness
 */

/**
 * 「What this conversation grew」, rendered against a booted store.
 * @param store - the store, in whatever state the test put it.
 * @returns the markup.
 */
export function renderPluginPanel(store: IrisStore): string {
  // React's server snapshot otherwise stays at Zustand's construction state;
  // this harness needs whatever the test set, as a mounted browser would see.
  const api = store as IrisStore & { getInitialState: () => ReturnType<IrisStore['getState']> }
  api.getInitialState = () => store.getState()
  return renderToString(<StoreProvider store={store}><SandboxPluginPanel /></StoreProvider>)
}

/**
 * The usage report on its own, over a summary the test composes.
 *
 * `UsageReport` is a pure function of its props, which is what lets a test put
 * a side share on the page without a model call or a corpus — the alternative
 * would be seeding a host's chat files just to reach a `<span>`.
 * @param summary - the aggregate to read.
 * @returns the markup.
 */
export function renderUsageReport(summary: UsageSummary): string {
  return renderToString(
    <UsageReport summary={summary} range="week" onRange={() => {}} onOpenChat={() => {}} />,
  )
}

export { setLanguage }
