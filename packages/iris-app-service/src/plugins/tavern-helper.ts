/**
 * Tavern Helper's detachable host capability.
 *
 * Card-facing JavaScript stays in the browser sandbox. The host half owns the
 * macro family that Tavern Helper registers over SillyTavern's native macros.
 * A live chat receives this object through the system-plugin registry and does
 * not import or invoke the implementation directly.
 *
 * @module @iris/app-service/plugins/tavern-helper
 */

import { expandHelperMacros, type MacroSources } from '@iris/compat-tavernhelper'

/** The host behavior Tavern Helper contributes to prompt expansion. */
export interface TavernHelperCapability {
  /** Activation revision that owns this object. */
  readonly revision: number
  /** Expand Tavern Helper's variable-macro family. */
  expandMacros(text: string, sources: MacroSources): string
}

/** Build one activation's Tavern Helper capability. */
export function createTavernHelperCapability(revision: number): TavernHelperCapability {
  return {
    revision,
    expandMacros: (text, sources) => expandHelperMacros(text, sources),
  }
}

/** Compatibility behavior for callers constructed without a plugin runtime. */
export const COMPAT_TAVERN_HELPER = createTavernHelperCapability(0)
