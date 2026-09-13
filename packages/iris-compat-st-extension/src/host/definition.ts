/**
 * The handshake between the task-A installer and the system-plugin runtime:
 * an installed ST extension becomes a `SystemPluginDefinition`-shaped row the
 * runtime can adopt, enable, disable and uninstall through the machinery it
 * already runs TH and MVU with.
 *
 * Deliberately structural: this package still imports nothing from
 * `@iris/app-service` — the definition mirrors the runtime's shape, and the
 * wiring commit's adoption call site asserts compatibility by construction
 * (the runtime accepts it or refuses loudly, never silently reshapes it).
 *
 * Activation does no server-side computation: the ST extension's runtime IS
 * the browser plane. What activation exists for is the runtime's own
 * invariants — a commit, a revision bump, an enable in the snapshot — which is
 * exactly what the arm/submit bridge and the asset gate key off — plus one
 * file write: the card-facing member bundle, materialized at
 * `memberBundlePath` so the aggregated plugin manifest grows a row for the
 * extension the moment it is enabled. "Enabled" is then the only switch:
 * disable stops serving, uninstall stops activating, no second lifecycle.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { NormalizedManifest } from '../manifest.ts'
import { buildMemberBundle } from './member-bundle.ts'

/** The capability name an activated ST extension publishes (diagnostic handle). */
export const ST_EXTENSION_CAPABILITY = 'st-extension-browser-plane'

/** The slice of the runtime's activation scope the pilot's activation needs. */
export interface StExtensionActivationScope {
  provide(name: string, capability: unknown): unknown
}

export interface StExtensionDefinition {
  id: string
  name: string
  description: string
  version: string
  apiVersion: 1
  dependencies?: readonly string[]
  activate(scope: StExtensionActivationScope): void
}

export function buildStExtensionDefinition(input: {
  id: string
  manifest: NormalizedManifest
  /** Where activation materializes the card-facing member proxy bundle. */
  memberBundlePath?: string
}): StExtensionDefinition {
  const { id, manifest, memberBundlePath } = input
  return {
    id,
    name: manifest.displayName ?? id,
    description: `SillyTavern extension "${manifest.displayName ?? id}" (v${manifest.version ?? '0.0.0'}) running in the Iris ST-compat plane.`,
    version: manifest.version ?? '0.0.0',
    apiVersion: 1,
    activate(scope: StExtensionActivationScope): void {
      scope.provide(ST_EXTENSION_CAPABILITY, {
        extensionId: id,
        manifestVersion: manifest.version,
        entry: manifest.js,
      })
      if (memberBundlePath !== undefined) {
        void (async () => {
          try {
            await mkdir(dirname(memberBundlePath), { recursive: true })
            await writeFile(memberBundlePath, buildMemberBundle(id), 'utf8')
          } catch (cause: unknown) {
            console.warn(`[iris-st-compat] the card-facing member bundle for "${id}" could not be written; cards will not see its members`, cause)
          }
        })()
      }
    },
  }
}
