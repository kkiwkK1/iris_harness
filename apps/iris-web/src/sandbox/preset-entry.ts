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
 * Vue's runtime flags, copied verbatim including the values.
 *
 * Upstream's comment records that pinia 4.0.0+ requires them and that leaving
 * them unset broke a great many scripts — which makes these a compatibility fact
 * rather than a preference, and not ours to tune.
 */
host['__VUE_PROD_DEVTOOLS__'] = true
host['__VUE_OPTIONS_API__'] = true
host['__VUE_PROD_HYDRATION_MISMATCH_DETAILS__'] = false
