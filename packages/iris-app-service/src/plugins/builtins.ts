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

/** Tavern Helper and MVU, available for profile-local install and activation. */
export const BUILTIN_SYSTEM_PLUGIN_DEFINITIONS: readonly SystemPluginDefinition[] = [
  {
    id: 'tavern-helper',
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
    id: 'mvu',
    name: 'MVU',
    description: 'Initial variables, reply updates, and variable-state replay.',
    version: '0.0.0',
    apiVersion: 1,
    dependencies: ['tavern-helper'],
    activate(scope) {
      const helper = scope.getDependency<TavernHelperCapability>(
        'tavern-helper',
        TAVERN_HELPER_CAPABILITY,
      )
      if (helper === undefined) {
        throw new Error('MVU requires Tavern Helper’s active macro-expander capability')
      }
      return scope.provide(MVU_CAPABILITY, createMvuCapability(scope.revision))
    },
  },
]
