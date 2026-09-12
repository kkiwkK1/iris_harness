/** Built-in system plugins shipped with Iris. */
export type SystemPluginId = 'tavern-helper' | 'mvu'

/** One catalog entry together with its profile-local runtime state. */
export interface SystemPluginView {
  id: string
  name: string
  description: string
  version: string
  apiVersion: 1
  dependencies: string[]
  installed: boolean
  enabled: boolean
  status: 'not-installed' | 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error'
  error?: string
}

/** Authoritative state of the profile's registered system-plugin catalog. */
export interface SystemPluginSnapshot {
  revision: number
  plugins: SystemPluginView[]
}
