/**
 * The system-plugin state captured by one sandbox incarnation.
 *
 * Frames never read the live store. A run is born against one host revision
 * and keeps that revision for every request it can schedule later; changing
 * the host snapshot destroys the run and creates another one. This small value
 * is also written into the srcdoc so parse-time interface code and the shell
 * agree about which optional facades exist.
 *
 * @module iris-web/sandbox/system-plugin-runtime
 */
import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'

/** Capabilities and revision fixed for one frame lifetime. */
export interface SandboxPluginRuntime {
  revision: number
  tavernHelper: boolean
  mvu: boolean
}

/** Metadata name shared by the srcdoc writer and bootstrap reader. */
export const SYSTEM_PLUGIN_RUNTIME_META = 'iris-system-plugins'

/** Legacy direct builders behave like an existing profile with both built-ins enabled. */
export const DEFAULT_SANDBOX_PLUGIN_RUNTIME: SandboxPluginRuntime = Object.freeze({
  revision: 0,
  tavernHelper: true,
  mvu: true,
})

/** A plugin is usable only after its runtime transition has completed. */
function running(plugin: SystemPluginView | undefined): boolean {
  return plugin?.installed === true && plugin.enabled === true && plugin.status === 'enabled'
}

/** Reduce the authoritative catalog to the capabilities a sandbox understands. */
export function sandboxPluginRuntime(
  snapshot: SystemPluginSnapshot | undefined,
): SandboxPluginRuntime | undefined {
  if (snapshot === undefined) return undefined
  const tavernHelper = running(snapshot.plugins.find(plugin => plugin.id === 'tavern-helper'))
  const mvu = tavernHelper && running(snapshot.plugins.find(plugin => plugin.id === 'mvu'))
  return { revision: snapshot.revision, tavernHelper, mvu }
}

/** Encode the capability snapshot for a metadata attribute. */
export function encodeSandboxPluginRuntime(runtime: SandboxPluginRuntime): string {
  return JSON.stringify(runtime)
}

/** Parse the capability snapshot before the sandbox installs. */
export function parseSandboxPluginRuntime(value: string | null | undefined): SandboxPluginRuntime {
  let parsed: unknown
  try {
    parsed = value === null || value === undefined ? undefined : JSON.parse(value)
  } catch {
    throw new Error('iris sandbox: the system-plugin snapshot is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('iris sandbox: the frame was built without a system-plugin snapshot')
  }
  const bag = parsed as Record<string, unknown>
  if (
    typeof bag['revision'] !== 'number'
    || !Number.isSafeInteger(bag['revision'])
    || bag['revision'] < 0
    || typeof bag['tavernHelper'] !== 'boolean'
    || typeof bag['mvu'] !== 'boolean'
  ) {
    throw new Error('iris sandbox: the system-plugin snapshot has an invalid shape')
  }
  if (bag['mvu'] && !bag['tavernHelper']) {
    throw new Error('iris sandbox: MVU cannot be enabled without Tavern Helper')
  }
  return {
    revision: bag['revision'],
    tavernHelper: bag['tavernHelper'],
    mvu: bag['mvu'],
  }
}

/** Attach the frame's immutable revision to a host-bound action payload. */
export function fenceFrameParams(params: unknown, revision: number): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return params
  return { ...(params as Record<string, unknown>), pluginRevision: revision }
}
