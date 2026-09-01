/**
 * The libraries a **message** frame gets, which are not the ones a script frame gets.
 *
 * Upstream injects two things into a script frame and **eight** into a message
 * frame (`src/iframe/third_party_message.html` against
 * `third_party_script.html`). That asymmetry is why this is a second bundle
 * rather than an addition to `preset.js`: a script frame has no interface to
 * draw, and making every card's script frame carry Tailwind and jQuery UI would
 * be a megabyte spent on nothing.
 *
 * ## Where the bytes come from, and why not from a CDN
 *
 * Every version here is pinned to **what is installed on the user's own
 * machine**, not to what upstream's unversioned CDN tags resolve to today. The
 * two differ, and the difference is not small:
 *
 * | library | upstream's tag resolves to | pinned here | source of the pin |
 * | --- | --- | --- | --- |
 * | jQuery | 4.0.0 | **3.5.1** | `SillyTavern/public/lib/jquery-3.5.1.min.js` |
 * | jQuery UI | 1.14.2 | **1.13.2** | `SillyTavern/public/lib/jquery-ui.min.js` |
 * | jQuery UI touch-punch | 0.2.3 | **0.2.3** | `SillyTavern/public/lib/jquery.ui.touch-punch.min.js` |
 * | FontAwesome Free | 7.x | **6.5.2** | `SillyTavern/public/css/fontawesome.min.css` banner |
 * | Tailwind (browser) | — | **4.1.12** | `JS-Slash-Runner/lib/tailwindcss.min.js`, a local copy |
 *
 * Upstream's *message* frames therefore run a **different major jQuery** from
 * its *script* frames, which borrow the host page's `window.parent.$` and so get
 * SillyTavern's 3.5.1. That is drift between two injection mechanisms rather than
 * a decision, and it is not copied: one jQuery across both frame kinds means a
 * card's code behaves the same in either.
 *
 * 3.5.1 rather than 4.0.0 because the risk is asymmetric. jQuery 4 removed the
 * legacy API that old cards use daily (`$.trim`, `$.isArray`, `.bind()`); cards
 * written *for* 4.x were measured at zero. Choosing the newer breaks cards the
 * older one runs. Reopen this if a real card is found needing 4.x semantics.
 *
 * Tailwind is the one library upstream keeps a local copy of rather than
 * fetching, and `@tailwindcss/browser@4.1.12` is that same artifact — so there is
 * no judgement in that row, only a pin.
 *
 * Taken from npm rather than vendored into the repository because `public/` is
 * build output and CI has no SillyTavern install: vendored bytes would make the
 * build depend on one machine. npm with exact pins and a lockfile is a
 * build-time source, not the runtime CDN dependency this frame refuses to have.
 *
 * ## Fonts
 *
 * FontAwesome's CSS references `.woff2` files by URL. Those are **inlined as
 * data URIs** (`vite.message-preset.config.ts` raises `assetsInlineLimit` above
 * the largest face) rather than served as separate hashed assets.
 *
 * That is a deliberate trade of ~91 KB of base64 for the removal of a failure
 * *state*: "the CSS arrived and the fonts did not" renders every icon as blank
 * space with no error anywhere. Detecting that would need an instrument; making
 * it impossible needs a build flag. `tests/message-preset.test.ts` asserts the
 * property rather than the flag — no `url()` in the built bundle points outside
 * itself.
 *
 * @module iris-web/sandbox/message-preset-entry
 */

/*
 * The script frame's seeds first, by importing the module that does them.
 *
 * Shared in source and duplicated in bytes, which is the right way round: the
 * two bundles are fetched by different frames and must each stand alone, but
 * `_`, `z`, `YAML`, `$` and Vue are seeded by one piece of code with one set of
 * reasons attached to it. Upstream reaches the same arrangement — `predefine.js`
 * goes into both frame kinds.
 */
import './preset-entry.ts'

import { reportMissingJQueryPlugins } from './jquery-plugin-gap.ts'

/*
 * jQuery UI and touch-punch are **not** shipped, and the absence is announced
 * rather than left to a `TypeError`.
 *
 * Measured: zero uses across the corpus, by two independent probes (method calls
 * and theme class names). They cost 316 KB of a bundle every message frame
 * fetches cold, because the HTTP cache is partitioned per origin and every one
 * of these frames is its own opaque origin.
 *
 * What replaces them is not a stub set. See `jquery-plugin-gap.ts`: a card
 * reading any method jQuery does not have gets `undefined` — exactly what it
 * would get on a SillyTavern install without the plugin — and Iris reports which
 * name it asked for.
 */
reportMissingJQueryPlugins()

/*
 * The stylesheets, in their own module so they land **before** Tailwind.
 *
 * Import bodies evaluate in declaration order, so this line placed above the
 * Tailwind import is the whole mechanism for upstream's sheet order. As
 * statements in this file they would have run after Tailwind, because Tailwind's
 * import would have been hoisted above them — which reverses who wins a
 * specificity tie.
 */
import './message-preset-styles.ts'

/*
 * Tailwind's browser build last, and imported for its side effect rather than
 * awaited: an IIFE bundle cannot contain top-level `await`, which is what the
 * first version of this file tried. It scans the document for class names and
 * watches for more, so running in the head before the card's markup is parsed is
 * correct — it picks up what arrives afterwards.
 */
import '@tailwindcss/browser'

const host = window as unknown as Record<string, unknown>

host['__iris_message_preset_loaded__'] = true
