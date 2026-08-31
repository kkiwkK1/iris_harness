/**
 * The library globals a card expects to already exist.
 *
 * Enumerated from upstream's `predefine.js` rather than discovered one crash at a
 * time. It seeds these onto every script frame:
 *
 * | global | what it is | where upstream gets it |
 * | --- | --- | --- |
 * | `_` | lodash | `window.parent._` |
 * | `z` | zod | `window.parent.z` |
 * | `YAML` | YAML parser | `window.parent.YAML` |
 * | `showdown` | Markdown renderer | `window.parent.showdown` |
 * | `toastr` | notifications | `window.parent.toastr` |
 * | `EjsTemplate` | the extension's own EJS wrapper | `window.parent.EjsTemplate` |
 *
 * **Every one comes from the parent page**, which is SillyTavern itself. So there
 * is no upstream URL to copy and no upstream version to match — unlike Vue, where
 * the answer was "upstream pins latest". Here the answer is "upstream borrows
 * whatever the host page happens to have", and a cross-origin frame cannot borrow.
 * Iris has to choose, and this is the choice.
 *
 * **Bundled by Iris and served from its own origin** (`preset-entry.ts` →
 * `public/sandbox/preset.js`), not fetched from a CDN: no guessing at which UMD
 * build exposes which global name, a version this repository controls, and cards
 * that keep working with the network down — the same reason the interface uses
 * system fonts. This module holds only the enumeration; the values live in that
 * bundle, because inlining them into every frame cost 430 KB per frame.
 *
 * @module iris-web/sandbox/preset-globals
 */

/**
 * The globals upstream seeds, all of them.
 *
 * Listed in full even though only some are provided, because the gap is the
 * useful part: a frame that reports which of these are missing turns "the next
 * card crashes on `YAML`" into something known before it happens.
 */
export const EXPECTED_GLOBALS: readonly string[] = [
  '_',
  'z',
  'YAML',
  'showdown',
  'toastr',
  'EjsTemplate',
]
