import { renderToString } from 'react-dom/server'

import type { IrisStore } from '../src/client/store.ts'
import { StoreProvider } from '../src/client/provider.tsx'
import { PluginCenter } from '../src/app/PluginCenter.tsx'
import { setLanguage } from '../src/app/i18n/language.ts'

export function renderPluginCenter(store: IrisStore): string {
  // React's server snapshot otherwise stays at Zustand's construction state;
  // this harness needs the host state loaded by boot, as a mounted browser does.
  const api = store as IrisStore & { getInitialState: () => ReturnType<IrisStore['getState']> }
  api.getInitialState = () => store.getState()
  return renderToString(<StoreProvider store={store}><PluginCenter /></StoreProvider>)
}

export { setLanguage }
