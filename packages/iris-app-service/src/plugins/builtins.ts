/** Bundled system-plugin definitions for the host control plane. */

import type { SystemPluginDefinition } from '../system-plugins.ts'
import {
  MVU_CAPABILITY,
  TAVERN_HELPER_CAPABILITY,
} from './capabilities.ts'
import { createMvuCapability } from './mvu.ts'
import {
  createTavernHelperCapability,
  type TavernHelperCapability,
} from './tavern-helper.ts'

/**
 * The two bundled ids, named once, here.
 *
 * They are deliberately plain strings: the catalog holds definitions adopted
 * from installed ST extensions beside these, so the protocol's closed
 * `SystemPluginId` union retired rather than stretching, and the runtime's
 * default-enabled set imports the names instead of retyping the literals.
 */
export const TAVERN_HELPER_PLUGIN_ID = 'tavern-helper'
export const MVU_PLUGIN_ID = 'mvu'

/** Tavern Helper and MVU, available for profile-local install and activation. */
export const BUILTIN_SYSTEM_PLUGIN_DEFINITIONS: readonly SystemPluginDefinition[] = [
  {
    id: TAVERN_HELPER_PLUGIN_ID,
    name: 'Tavern Helper',
    description: 'Card-script compatibility APIs and variable macros.',
    version: '0.0.0',
    apiVersion: 1,
    activate(scope) {
      return scope.provide(
        TAVERN_HELPER_CAPABILITY,
        createTavernHelperCapability(scope.revision),
      )
    },
  },
  {
    id: MVU_PLUGIN_ID,
    name: 'MVU',
    description: 'Initial variables, reply updates, and variable-state replay.',
    version: '0.0.0',
    apiVersion: 1,
    dependencies: [TAVERN_HELPER_PLUGIN_ID],
    activate(scope) {
      const helper = scope.getDependency<TavernHelperCapability>(
        TAVERN_HELPER_PLUGIN_ID,
        TAVERN_HELPER_CAPABILITY,
      )
      if (helper === undefined) {
        throw new Error('MVU requires Tavern Helper’s active macro-expander capability')
      }
      return scope.provide(MVU_CAPABILITY, createMvuCapability(scope.revision))
    },
  },
]
