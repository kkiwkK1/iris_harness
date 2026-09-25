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
import {
  createTemplateEngineDefinition,
  TEMPLATE_ENGINE_PLUGIN_ID,
  type TemplateEngineCapability,
} from './template-engine.ts'

export { TEMPLATE_ENGINE_PLUGIN_ID }

/**
 * The first two bundled ids, named once, here (the third,
 * {@link TEMPLATE_ENGINE_PLUGIN_ID}, is named in its own module).
 *
 * They are deliberately plain strings: the catalog holds definitions adopted
 * from installed ST extensions beside these, so the protocol's closed
 * `SystemPluginId` union retired rather than stretching, and the runtime's
 * default-enabled set imports the names instead of retyping the literals.
 */
export const TAVERN_HELPER_PLUGIN_ID = 'tavern-helper'
export const MVU_PLUGIN_ID = 'mvu'

/**
 * Tavern Helper, MVU and Iris's EJS template engine, available for
 * profile-local install and activation.
 *
 * A function because the template engine carries the composition's tuning
 * (`templateDeadlineMs`) into the capability it publishes; the other two take
 * nothing. {@link BUILTIN_SYSTEM_PLUGIN_DEFINITIONS} is this with defaults.
 * @param options.templates - the template engine's tuning.
 * @returns the bundled definitions, in catalog order.
 */
export function builtinSystemPluginDefinitions(
  options: { templates?: TemplateEngineCapability } = {},
): readonly SystemPluginDefinition[] {
  return [...BASE_DEFINITIONS, createTemplateEngineDefinition(options.templates)]
}

const BASE_DEFINITIONS: readonly SystemPluginDefinition[] = [
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

/** The bundled definitions with default tuning. */
export const BUILTIN_SYSTEM_PLUGIN_DEFINITIONS: readonly SystemPluginDefinition[] = builtinSystemPluginDefinitions()
