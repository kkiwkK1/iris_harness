/**
 * Facade for `scripts/popup.js`, served at `<rev>/scripts/popup.js`. Only the
 * code editor calls it (off by default); the import must succeed, the call
 * refuses with a named error.
 */

import { UnsupportedStCompatApiError } from '../../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'

export const POPUP_TYPE = {
  DISPLAY: 'display',
  TEXT: 'text',
  CONFIRM: 'confirm',
  INPUT: 'input',
} as const

export const POPUP_RESULT = {
  NEGATIVE: 0,
  POSITIVE: 1,
  CANCELLED: 2,
} as const

export async function callGenericPopup(): Promise<never> {
  throw new UnsupportedStCompatApiError('callGenericPopup (the code editor popup)')
}
