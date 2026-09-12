/**
 * The shell's half of the plugin merge: the aggregate manifest, fetched and
 * held for the snapshot reduction.
 *
 * Fetched per **snapshot revision**, not per mount: the manifest is the host
 * composing the enabled set, and a `plugins.changed` that moved the revision
 * is the only event that can change its content. The result lands in state,
 * whose identity is a rebuild dependency one level up — a manifest that
 * arrives after frames have mounted rebuilds them, because their tags were
 * built from the rows it carries.
 *
 * Failure is **empty, not fatal, and named in the console**: a card that needs
 * no plugin must keep working when `/plugins/manifest.json` does not answer,
 * so the reduction receives `undefined` and frames run with no plugin rows —
 * the same failure direction the build's own manifest takes (missing means
 * no-cache, not no-card). The named warning here is the shell-side half of the
 * visibility rule; the frame-side half is the merge's per-plugin reports. A
 * user-facing status surface for this fetch belongs to the plugin center, not
 * to the frame runner.
 *
 * @module iris-web/app/use-plugin-manifest
 */
import { useEffect, useState } from 'react'

import { PLUGIN_ASSET_MANIFEST_PATH, parsePluginAssetManifest, type PluginAssetManifest } from '@iris/plugin-web-api'

/** Read and validate the aggregate manifest, or say why it could not be read. */
async function pluginAssetManifest(): Promise<PluginAssetManifest> {
  const response = await fetch(PLUGIN_ASSET_MANIFEST_PATH)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const parsed = parsePluginAssetManifest(await response.text())
  if (typeof parsed === 'string') throw new Error(parsed)
  return parsed
}

/**
 * The manifest for one snapshot revision, or `undefined` while it is absent —
 * not yet fetched, unreachable, or invalid.
 * @param revision - the snapshot revision the manifest should answer for.
 * @returns the manifest, when one has been read for the current revision.
 */
export function usePluginAssetManifest(revision: number | undefined): PluginAssetManifest | undefined {
  const [manifest, setManifest] = useState<PluginAssetManifest | undefined>(undefined)
  useEffect(() => {
    if (revision === undefined) {
      setManifest(undefined)
      return
    }
    let stale = false
    pluginAssetManifest().then(
      read => {
        if (!stale) setManifest(read)
      },
      error => {
        if (!stale) {
          setManifest(undefined)
          console.warn(`plugin manifest: ${PLUGIN_ASSET_MANIFEST_PATH} could not be read (${String(error)}); frames run without plugin members`)
        }
      },
    )
    return () => {
      stale = true
    }
  }, [revision])
  return manifest
}
