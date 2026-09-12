/**
 * Runtime-owned capabilities used by live chats.
 *
 * The system-plugin runtime owns the registry. This module names only the
 * read-side contract needed by a chat, which keeps `entry.ts` independent of
 * the runtime implementation and lets old construction paths retain their
 * pre-plugin behavior.
 *
 * @module @iris/app-service/plugins/capabilities
 */

import type { MvuCapability } from './mvu.ts'
import type { TavernHelperCapability } from './tavern-helper.ts'

/** Service name published by the Tavern Helper builtin. */
export const TAVERN_HELPER_CAPABILITY = 'macro-expander'

/** Service name published by the MVU builtin. */
export const MVU_CAPABILITY = 'mvu-engine'

/** The runtime surface a live chat needs. */
export interface SystemPluginCapabilities {
  /** Current control-plane revision. */
  snapshot(): { revision: number }
  /** A capability currently published by an active plugin. */
  capability<T>(pluginId: string, name: string): T | undefined
}

/** Look up Tavern Helper's currently active implementation. */
export function tavernHelperCapability(
  plugins: SystemPluginCapabilities | undefined,
  fallback: TavernHelperCapability,
): TavernHelperCapability | undefined {
  return plugins === undefined
    ? fallback
    : plugins.capability<TavernHelperCapability>('tavern-helper', TAVERN_HELPER_CAPABILITY)
}

/** Look up MVU's currently active implementation. */
export function mvuCapability(
  plugins: SystemPluginCapabilities | undefined,
  fallback: MvuCapability,
): MvuCapability | undefined {
  return plugins === undefined
    ? fallback
    : plugins.capability<MvuCapability>('mvu', MVU_CAPABILITY)
}
