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
 * Activation does no server-side work: the ST extension's runtime IS the
 * browser plane. What activation exists for is the runtime's own invariants —
 * a commit, a revision bump, an enable in the snapshot — which is exactly what
 * the arm/submit bridge and the asset gate key off.
 */

import type { NormalizedManifest } from '../manifest.ts'

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
  dependencies?: string[]
  activate(scope: StExtensionActivationScope): { dispose?: () => void }
}

export function buildStExtensionDefinition(input: {
  id: string
  manifest: NormalizedManifest
}): StExtensionDefinition {
  const { id, manifest } = input
  return {
    id,
    name: manifest.displayName ?? id,
    description: `SillyTavern extension "${manifest.displayName ?? id}" (v${manifest.version}) running in the Iris ST-compat plane.`,
    version: manifest.version ?? '0.0.0',
    apiVersion: 1,
    activate(scope: StExtensionActivationScope): { dispose?: () => void } {
      scope.provide(ST_EXTENSION_CAPABILITY, {
        extensionId: id,
        manifestVersion: manifest.version,
        entry: manifest.js,
      })
      return {}
    },
  }
}
