/**
 * Facade for `scripts/utils.js`, served at `<rev>/scripts/utils.js`. The
 * extension imports `copyText` (error-toast "copy source" buttons) and
 * `getCharaFilename` (the charaExtra world-info lookup, off by default).
 */

import { state } from '../kernel-entry.ts'

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(String(text))
  } catch (cause: unknown) {
    console.warn('[iris-st-compat] copyText could not reach the clipboard (sandboxed frame)', cause)
  }
}

/** Upstream returns ST's own character-file stem; the pilot's stem is synthetic and only lookup-key shaped. */
export function getCharaFilename(characterId?: number): string {
  const index = characterId ?? state.characterId
  return `chara_${index >= 0 ? index : 'unknown'}`
}
