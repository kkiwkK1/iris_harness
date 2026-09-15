/**
 * The React side of the plugins' copy overlay: the loader.
 *
 * Loading tracks the **aggregate manifest**, not the `plugins.changed` event:
 * the manifest is already fetched once per snapshot revision
 * (`usePluginAssetManifest`), and that fetch is the only event that can
 * change what copy exists — a `plugins.changed` without a manifest row is a
 * revision for something else. One hook, mounted once at the app level, owns
 * the overlay's lifetime; it deliberately does not live in `PluginCenter`,
 * which is never unmounted (the settings page hides non-active routes) and
 * would tie copy presence to page visibility.
 *
 * Server renders have no effects, so the loader never fetches during
 * `check:render` — the copy overlay is simply empty there, and the render
 * check feeds it through the store directly instead.
 *
 * @module iris-web/app/i18n/use-plugin-copy
 */

import { useEffect } from 'react'

import type { PluginAssetManifest } from '@iris/plugin-web-api'

import { syncPluginCopy } from './plugin-copy.ts'

/**
 * Keep the copy overlay in step with one aggregate manifest.
 * @param manifest - the manifest for the current snapshot revision, or
 *   `undefined` while it has not been read.
 */
export function usePluginCopyLoader(manifest: PluginAssetManifest | undefined): void {
  useEffect(() => {
    if (manifest === undefined) return
    let stale = false
    syncPluginCopy(manifest).catch(error => {
      // `syncPluginCopy` handles its own per-plugin failures; this is the
      // never-expected rejection of the sync itself.
      if (!stale) console.warn(`plugin copy: the overlay could not be synced (${String(error)})`)
    })
    return () => {
      stale = true
    }
  }, [manifest])
}
