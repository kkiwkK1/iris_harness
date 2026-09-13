/**
 * Facade for `scripts/tokenizers.js`, served at `<rev>/scripts/tokenizers.js`.
 * The extension's token statistics (`LAST_SEND_TOKENS` and friends) call
 * `getTokenCountAsync`. The pilot has no tokenizer bridge; a length estimate
 * fills the informational globals, with a one-time console notice. Recorded as
 * a deviation in the report — these numbers are display-only upstream too.
 */

let warned = false

export async function getTokenCountAsync(text: string): Promise<number> {
  if (!warned) {
    warned = true
    console.warn('[iris-st-compat] token counts are length/4 estimates in the pilot (no tokenizer bridge)')
  }
  const value = typeof text === 'string' ? text : ''
  return Math.ceil(value.length / 4)
}
