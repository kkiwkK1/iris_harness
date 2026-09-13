/**
 * Facade for `scripts/extensions.js`, served at `<rev>/scripts/extensions.js`.
 * The pilot's extension reads and mutates `extension_settings` (its own
 * `EjsTemplate` namespace, the global variable layer, the regex table) and
 * renders its settings panel through `renderExtensionTemplateAsync` — both
 * backed by the kernel.
 */

import { renderExtensionTemplateAsync as renderTemplate } from '../kernel-entry.ts'
import { state } from '../kernel-entry.ts'
import { UnsupportedStCompatApiError } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'

export const extension_settings = state.extensionSettings

/** Upstream signature: `(moduleKey, templateName, version?, avoidCache?) → Promise<HTMLElement>`. */
export async function renderExtensionTemplateAsync(
  moduleKey: string,
  templateName: string,
): Promise<HTMLElement> {
  return await renderTemplate(moduleKey, templateName)
}

export function unimplemented(member: string): never {
  throw new UnsupportedStCompatApiError(member)
}
