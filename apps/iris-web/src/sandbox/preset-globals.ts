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
 *
 * What each name means at present, since "expected" and "provided" have come
 * apart in three different ways and conflating them has cost real runs:
 *
 * - `$`, `jQuery`, `_`, `z`, `YAML`, `Vue` — **provided**, bundled into
 *   `preset.js` and served from Iris's own origin. Vue is the newest of these
 *   and the reason the distinction is now written down; it used to arrive by CDN
 *   tag, and a tag that fails to load fails silently.
 * - `toastr` — **answered, not provided**. `toastr-report.ts` supplies an object
 *   that forwards each call into the card's report list instead of showing a
 *   toast. It is on this list so the name stays accounted for, and the frame's
 *   own first line to the panel says plainly that this is not the real library.
 * - `showdown`, `VueRouter`, `EjsTemplate` — **absent and reported**. Measured
 *   across the 19 local cards: `EjsTemplate` is named by one card's source,
 *   `showdown` and `VueRouter` by none, and MagVarUpdate's bundle references
 *   none of the three. They stay listed precisely because the banner is the only
 *   thing that will speak when that changes.
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
  /*
   * Vue and vue-router were missing from this list while the documentation
   * directly above named them twice — as injected script #1 and in MVU's own
   * externals. The list had been read off the table, and the table is organised
   * by *where upstream gets each one*: seven are borrowed from the parent
   * window, and these two are the only pair upstream loads by CDN tag.
   * Following the table meant inheriting a distinction that was never about
   * whether a card needs the library.
   *
   * The cost was not the absence — it was that the absence became unsayable.
   * The frame reports the missing names from this array, so leaving them out
   * did not merely fail to provide Vue, it made the banner's silence about Vue
   * mean nothing, while reading exactly like a clean bill of health. A card
   * whose provider died on `Vue` was reported as missing `showdown, toastr,
   * EjsTemplate` — three names, none of which that bundle references at all.
   *
   * That is the same unfalsifiable silence written about in
   * `import-attempts.ts`, rebuilt in a second place: an instrument whose quiet
   * cannot be distinguished from a passing result. A checklist has it by
   * construction, because anything absent from the list is also absent from
   * every report the list produces.
   */
  'Vue',
  'VueRouter',
]

/**
 * The name the preset sets once it has finished running.
 *
 * Set as the bundle's **final** statement, so its presence proves the whole body
 * evaluated rather than merely that the file arrived. That is the distinction
 * this exists for: "the script did not execute" and "the script ran and this
 * library is not in it" are different findings with different next steps, and
 * from a list of missing names alone they are indistinguishable.
 *
 * They were confused exactly once, expensively. A `crossorigin` attribute made
 * the browser block the preset outright, and the frame reported nine missing
 * libraries — one line that read as nine independent gaps and was in fact one
 * blocked request.
 */
export const PRESET_MARKER = '__iris_preset_loaded__'
