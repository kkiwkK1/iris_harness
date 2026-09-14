/**
 * One catalog entry together with its profile-local runtime state.
 *
 * `id` is an open string, deliberately not a union of the builtin names: an ST
 * extension adopted through the host's `adoptDefinition` handshake arrives
 * with an id of its own, and a catalog row must hold that id beside the
 * builtins without a cast.
 */
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
