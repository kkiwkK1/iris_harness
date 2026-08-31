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

import * as lodash from 'lodash-es'
import { z } from 'zod'

const host = window as unknown as Record<string, unknown>

// The two upstream's `predefine.js` seeds that Iris can supply. Assigned rather
// than defined so a card may still overwrite them, which upstream also allows.
host['_'] = lodash
host['z'] = z

/*
 * Vue's runtime flags, copied verbatim including the values.
 *
 * Upstream's comment records that pinia 4.0.0+ requires them and that leaving
 * them unset broke a great many scripts — which makes these a compatibility fact
 * rather than a preference, and not ours to tune.
 */
host['__VUE_PROD_DEVTOOLS__'] = true
host['__VUE_OPTIONS_API__'] = true
host['__VUE_PROD_HYDRATION_MISMATCH_DETAILS__'] = false
