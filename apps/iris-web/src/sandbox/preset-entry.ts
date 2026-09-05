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
import * as vueRouter from 'vue-router'
import showdown from 'showdown'

import { PRESET_MARKER } from './preset-globals.ts'
import * as lodashModule from 'lodash-es'
import * as YAML from 'yaml'
/*
 * The **namespace**, not the named export, and a real card decided this.
 *
 * A remote bundle (`gh:StageDog/tavern_resource/dist/util/mvu_zod.js`, cached
 * under `script-bundles/`) does:
 *
 *   const r = z                                    // the bare global
 *   … t instanceof r.z.ZodObject ? r.z.looseObject(t.shape) : t
 *
 * So it dereferences `z` → `.z` → `.ZodObject`. Seeding the named export gave
 * a `z` with `ZodObject` on it but **no `.z`**, so that line read a property of
 * `undefined` and the card's variable schema never registered.
 *
 * The measurement that chose this: on the installed zod (4.5.4) the namespace
 * carries **both** spellings — `ns.z.ZodObject` and `ns.ZodObject`, `ns.z.looseObject`
 * and `ns.looseObject` — while the named export carries only one. So the
 * namespace is not a guess about what upstream exposes; it is the shape that
 * satisfies every spelling a card has been observed to use.
 */
import * as z from 'zod'

import { installPrefaultCompat } from './zod-compat.ts'

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
/*
 * The **default** export, not the namespace, and the difference is a whole
 * verification round.
 *
 * This was `import * as lodash from 'lodash-es'`, which produces a module
 * namespace object: every lodash method present and correct, and the object
 * itself **not callable**. Cards use both forms. MagVarUpdate's unique-script
 * election is written in the wrapper form —
 * `_($('#tavern_helper').find(...).toArray()).map(...).last()` — eleven such calls
 * across that bundle — and it failed with `TypeError: _ is not a function` at the
 * one line that needed the callable, having sailed past every method access
 * before it.
 *
 * Upstream never meets this: its `predefine.js` takes `window.parent._`, the host
 * page's lodash UMD, which is the callable wrapper factory.
 *
 * The shape of the mistake is worth more than the fix. Nothing was missing and
 * nothing was wrong — a check for `typeof _.get === 'function'` passed happily,
 * because a namespace has `get`. Only the *form* differed, and only the one call
 * that used the form could tell. The preset check now calls `_()` rather than
 * inspecting it.
 */
/*
 * Reached through the namespace because `@types/lodash-es` does not declare the
 * default the package actually ships — the types are incomplete here, not the
 * package. Deliberately **no fallback to the namespace**: if this export ever
 * disappears, `_` becomes undefined and the preset check says so, which is far
 * better than silently restoring the very object whose uncallability cost a
 * round.
 */
const lodash: unknown = (lodashModule as unknown as { default?: unknown }).default

host['_'] = lodash
/*
 * The prefault-chaining compat **before** the namespace is published: a card
 * reading `z` must never see the broken chain. Runs once — the preset bundle is
 * evaluated once per origin — and the prototype set inside is deduplicated, so
 * the install is idempotent by construction. See `zod-compat.ts` for the
 * measured break and the semantics the forwarding preserves.
 */
installPrefaultCompat(z)
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
 * `showdown`, upstream's markdown converter.
 *
 * Two cards in the corpus use it. That number is not why it is here — a corpus
 * count of two and a corpus count of zero are the same instruction under the
 * standing discipline, because a zero means "not reached yet" and never "not
 * needed". Upstream's `predefine.js` seeds it for every script frame, so a card
 * may assume it the way it assumes `_`.
 *
 * **Ships with an open advisory**, and that is recorded rather than accepted
 * quietly: 2.1.0 is the last release, it carries a moderate ReDoS in link and
 * anchor parsing, and `npm audit` reports "no fix available". This is the first
 * dependency Iris ships with a known unfixed vulnerability. What makes it
 * tolerable is where it runs: inside a card frame, on text that frame already
 * had, so a pathological input costs that frame its own main thread and reaches
 * neither the shell nor another card. That is the frame isolation earning its
 * keep, not a reason the advisory does not apply — it belongs in the ledger.
 *
 * The default export, not the namespace, for the reason lodash is: cards write
 * `new showdown.Converter()`, and upstream's global is the UMD object.
 */
host['showdown'] = showdown

/*
 * `vue-router`, and the version is a deliberate divergence.
 *
 * This comment used to say vue-router was "deliberately not here", on two
 * measurements: no card source in the corpus names `VueRouter`, and the
 * MagVarUpdate bundle declares it as a webpack external and references it zero
 * times. Both measurements still hold. The reasoning built on them does not —
 * under "every family must run as it does in ST" a corpus zero says a family
 * has not been reached, so upstream's mechanism is what to implement, and
 * upstream loads this beside Vue for every script frame.
 *
 * **4.6.4, where upstream's unpinned tag resolves to 5.3.x.** Recorded here
 * because it is a fidelity gap a card can observe, and because the reason is
 * not incompatibility: 5.3.1's `vue` peer is `^3.5.34 || ^4.0.0`, which our
 * pinned `vue@3.5.42` satisfies. What objects is its **peerOptional `vite`**
 * (`^7.3.0 || ^8.0.0`, for its own `unplugin` typed-router plugin) against this
 * app's vite 6 — tooling we do not use to bundle a runtime router.
 *
 * Taking 5.3.1 anyway was tried and rolled back, on a measurement rather than a
 * feeling: `--legacy-peer-deps` is tree-wide, and the lockfile diff added 28
 * build-tool packages, moved `@vue/devtools-api` 6.6.4 → 8.2.1, and **dropped
 * `@deepseek-ai/dsh-host-webserver` entirely** — a dependency this session does
 * not own, in a tree four sessions share. A router that costs someone else's
 * package is the wrong trade, so 4.6.4 stands and the gap is written down.
 *
 * The namespace, matching upstream's UMD global: cards reach
 * `VueRouter.createRouter` and `VueRouter.createWebHashHistory`.
 */
host['VueRouter'] = vueRouter

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
