/**
 * Facade for `scripts/slash-commands.js`, served at `<rev>/scripts/slash-commands.js`.
 * The extension imports `executeSlashCommandsWithOptions` for the template
 * `execute()` helper, which the pilot's UCs do not use — the import must
 * succeed, the call refuses with a named error so a template that reaches for
 * it fails loudly instead of returning an empty pipe.
 */

import { UnsupportedStCompatApiError } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'

export async function executeSlashCommandsWithOptions(): Promise<never> {
  throw new UnsupportedStCompatApiError('executeSlashCommandsWithOptions (template execute() helper)')
}
