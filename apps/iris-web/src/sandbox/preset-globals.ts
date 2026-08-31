/**
 * The library globals a card expects to already exist.
 *
 * Enumerated from upstream rather than discovered one crash at a time — but the
 * first enumeration was taken from `predefine.js` alone, and that was not the
 * whole injected layer. A card reached for `$` and found nothing, because
 * upstream seeds jQuery from a *second* script. The script frame's real template
 * (`src/panel/script/iframe.ts`) injects five things, in this order:
 *
 * 1. `third_party_script.html` — Vue and vue-router, by CDN tag
 * 2. `parent_jquery.js` — `window.$ = window.parent.$`, and `jQuery` likewise
 * 3. `predefine.js` — the six globals below, plus three Vue flags
 * 4. `cleanup_protector.js` — only when the card's own source has no `pagehide`
 * 5. `log.js` — from a CDN `gh` path
 *
 * | global | what it is | where upstream gets it |
 * | --- | --- | --- |
 * | `$` / `jQuery` | jQuery | `window.parent.$` — **bound to the parent document** |
 * | `_` | lodash | `window.parent._` |
 * | `z` | zod | `window.parent.z` |
 * | `YAML` | YAML parser | `window.parent.YAML` |
 * | `showdown` | Markdown renderer | `window.parent.showdown` |
 * | `toastr` | notifications | `window.parent.toastr` |
 * | `EjsTemplate` | the extension's own EJS wrapper | `window.parent.EjsTemplate` |
 *
 * The same list can be read from the other side, which is the better check:
 * MVU's webpack config declares its externals as `$`, `_`, `showdown`, `toastr`,
 * `Vue`, `VueRouter`, `YAML`, `z` — the consumer's own statement of what it
 * expects the host to have already put there.
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
  '$',
  'jQuery',
  '_',
  'z',
  'YAML',
  'showdown',
  'toastr',
  'EjsTemplate',
]
