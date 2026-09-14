/**
 * Facade for `scripts/reasoning.js`, served at `<rev>/scripts/reasoning.js`.
 * The extension calls `updateReasoningUI` after a floor's DOM rewrite; the
 * pilot's projection floor carries no reasoning block, so the refresh is a
 * no-op. `ReasoningType` is a type-only import upstream (erased in the bundle).
 */

export const ReasoningType = {
  EMBEDDED: 'auto',
  STRING_VALUE: 'string',
  JSON_VALUE: 'json',
} as const

export function updateReasoningUI(): void {}
