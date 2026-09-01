/**
 * The card's library globals, as a separate cached script.
 *
 * Split out of the bootstrap deliberately. Bundling lodash and zod into the
 * bootstrap worked, and took it from 9 KB to 439 KB — inlined into the `srcdoc`
 * of **every** frame, where nothing is cached and each frame re-parses the whole
 * thing. Loaded as a script instead, the browser fetches and parses it once for
 * the origin no matter how many cards are running.
 *
 * That split also happens to be the right seam: the bootstrap is policy — the
 * channel, the bridge, the refusals — and belongs inline where nothing can
 * substitute it. These are just libraries, and libraries are what a `<script src>`
 * is for. Upstream reaches the same arrangement from the other direction: it loads
 * Vue by tag and takes the rest from its host page.
 *
 * Served from Iris's own origin rather than a CDN: this repository then controls
 * the version, and a card keeps working with the network down.
 *
 * @module iris-web/sandbox/preset-entry
 */

import jquery from 'jquery'
import * as vue from 'vue'

import { PRESET_MARKER } from './preset-globals.ts'
import * as lodash from 'lodash-es'
import * as YAML from 'yaml'
import { z } from 'zod'

const host = window as unknown as Record<string, unknown>

/*
 * The `predefine.js` seeds Iris can supply, assigned rather than defined so a
 * card may still overwrite them — which upstream also allows.
 *
 * Added when a real card reached for them, not in advance. `YAML` arrived that
 * way: the missing-globals banner had named it for three runs before MVU got far
 * enough to call it, so by the time it threw, the answer was already on screen.
 *
 * The version tracks upstream's declaration (`yaml: ^2.8.0` in Tavern Helper's
 * manifest) rather than whatever npm resolves today, because a card is written
 * against the library its author had.
 */
host['_'] = lodash
host['z'] = z
host['YAML'] = YAML

/*
 * jQuery, and the one place Iris deliberately differs from upstream.
 *
 * Upstream's `parent_jquery.js` is two lines — `window.$ = window.parent.$` —
 * so a card's `$` upstream is SillyTavern's own instance, and its selectors run
 * against the **parent** document. Iris cannot do that: the frame is cross-origin
 * by design, and reaching the real page is the thing the per-card document grant
 * exists to gate.
 *
 * So this is a real jQuery bound to the frame's own document. A card building its
 * own UI — which is what almost all of them do — behaves identically. A card
 * reaching for SillyTavern's chrome finds nothing, and reaching it through
 * `parent.$` is refused by name like any other unbridged parent member.
 *
 * Version pinned exactly, and to what SillyTavern *serves* (`lib/jquery-3.5.1.min.js`
 * in `public/index.html`) rather than what a card's manifest declares. MVU's
 * `package.json` says `jquery: ^4.0.0`, but that is a devDependency for types and
 * tests — its webpack config maps `jquery` to the ambient `$`, so the version a
 * card actually ran against is the host page's, and 4.x is not 3.x.
 */
host['$'] = jquery
host['jQuery'] = jquery

/*
 * Vue's runtime flags, copied verbatim including the values.
 *
 * Upstream's comment records that pinia 4.0.0+ requires them and that leaving
 * them unset broke a great many scripts — which makes these a compatibility fact
 * rather than a preference, and not ours to tune.
 */
/*
 * Vue itself, which upstream loads by CDN tag and Iris now bundles.
 *
 * This is the entry that moved. Upstream's script frames pull
 * `vue.runtime.global.prod.min.js` from jsdelivr, and Iris copied that verbatim
 * for eleven runs — the same URL, but not the same conditions. Upstream's frames
 * are same-origin with the SillyTavern page and share its HTTP cache, so the tag
 * is a warm hit; Iris opens every chat in a fresh opaque origin, where the cache
 * is partitioned and the same tag is a cold cross-origin fetch every time.
 *
 * What made that expensive rather than merely slow is how a classic `<script
 * src>` fails: **silently**. No exception, nothing the parent can see, the
 * global simply never appears. MagVarUpdate gates its publish on `Vue.watch`, so
 * a dropped tag meant `Mvu` was never published and every consumer waited
 * forever, while the frame reported a missing-libraries list that did not
 * contain Vue at all.
 *
 * Bundled here, a frame's startup has no network dependency left.
 *
 * The runtime build, matching upstream's choice of file: cards do not ship
 * templates for Vue to compile, and the compiler is the larger half.
 */
host['Vue'] = vue

/*
 * `vue-router` is deliberately **not** here, and its absence is reported rather
 * than hidden — it is in `EXPECTED_GLOBALS`, so a frame that lacks it says so.
 *
 * Upstream loads it beside Vue, so parity argues for it. Two measurements argue
 * against, and they were taken before deciding: across the 19 local cards (14
 * with scripts, 41 runnable) **no card source names `VueRouter`**, and the
 * MagVarUpdate bundle — which declares it as a webpack external — references it
 * **zero** times. Meanwhile the version upstream's unpinned tag resolves to,
 * `vue-router@5.3.0`, cannot be installed here without a peer conflict: it wants
 * `vite@^7 || ^8` and this app is on an older one.
 *
 * So the choice was between forcing a resolution, or vendoring a prebuilt file,
 * for a global nothing measured uses. Neither is worth doing silently, and the
 * banner now names the gap the moment a card needs it — which is the outcome the
 * missing-libraries reporting exists to produce.
 */

host['__VUE_PROD_DEVTOOLS__'] = true
host['__VUE_OPTIONS_API__'] = true
host['__VUE_PROD_HYDRATION_MISMATCH_DETAILS__'] = false

/*
 * These three are also replaced at build time (`vite.preset.config.ts`), and
 * both are needed. The assignments above serve pinia and any card that reads the
 * flags off `window`; the build-time definition serves Vue itself, whose module
 * body is hoisted above every statement in this file and would otherwise look
 * for them before they exist.
 */

/*
 * Last statement in the file, and that position is the whole point.
 *
 * A frame can see which globals are absent, but not *why*, and the two causes
 * need opposite responses: a library this bundle does not carry is a gap to
 * fill, while a bundle that never ran is a request to go and look at. Reading
 * one from the other is guesswork — nine missing names could be nine gaps or one
 * blocked script, and the frame once reported the second as the first.
 *
 * Setting this at the end makes the answer first-hand. Present means every
 * assignment above it completed; absent means the script was blocked, failed to
 * parse, or threw partway, and the frame says so instead of listing consequences.
 */
host[PRESET_MARKER] = true
