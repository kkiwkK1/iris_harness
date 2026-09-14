/**
 * Facade for `lib.js`, served at `<rev>/lib.js`. Upstream's lib.js is a vendor
 * aggregator; the pilot's extension imports only `yaml` from it, and only on
 * the YAML-schema variable path (`applyVarYamlAnnotate`), which the pilot does
 * not implement. The object exists so the import succeeds; calling it refuses
 * with a named error.
 */

import { UnsupportedStCompatApiError } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'

export const yaml = {
  stringify(): string {
    throw new UnsupportedStCompatApiError('lib.js yaml.stringify (YAML-schema variables)')
  },
  parseDocument(): never {
    throw new UnsupportedStCompatApiError('lib.js yaml.parseDocument (YAML-schema variables)')
  },
}
