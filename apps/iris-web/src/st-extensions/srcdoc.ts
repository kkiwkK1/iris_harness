/**
 * The extension frame's srcdoc.
 *
 * Much smaller than a card frame's: no seed, no members table, no card markup.
 * The document carries the identity metas the kernel reads, the vendor globals
 * the upstream self-start requires (`$`, `_`), and ONE module tag — the
 * upstream bundle itself, served from the mirrored URL layout so its seventeen
 * relative imports land on the Iris facades. The kernel is the shared chunk
 * behind those facades, so it initializes inside the same module graph, builds
 * the fixture DOM, and posts `ready` once the globals and the graph are up.
 *
 * **The CSP is the card frame's, with one deliberate difference: connect-src
 * names the shell origin explicitly instead of 'self'/'none'.** A srcdoc frame
 * with `allow-scripts` is an OPAQUE origin (its own origin is the string
 * "null"), and a CSP source of `'self'` matches the DOCUMENT's origin — which
 * is no origin at all here — so the card policy's `connect-src 'none'`-or-
 * `'self'` bans every fetch the kernel must make: the extension's
 * settings.html, its locale tables, its own artifact bytes. CSP matching is
 * against the REQUEST's URL, so naming the origin explicitly works; the
 * request is still CORS (`Origin: null` against `Access-Control-Allow-Origin:
 * *` from the route) and still confined to this host's own bytes. No remote
 * network is granted — the same lines the card policy draws, minus the one
 * that starves this frame.
 */

import { framePolicy } from '../sandbox/srcdoc.ts'

export interface ExtensionSrcdocOptions {
  /** The frame's channel token; envelopes without it are ignored by both ends. */
  token: string
  /** The shell's origin (the frame computes a null origin from srcdoc). */
  origin: string
  /** The mirrored URL root, e.g. `/iris-st-ext/st-prompt-template/<rev>`. */
  artifactBase: string
  /** The extension's directory name under `scripts/extensions/third-party/`. */
  dirName: string
  /** The upstream module entry, relative to the extension directory (`dist/index.js`). */
  entry?: string
  /**
   * The app-build stamp. Appended to the module tag's URL as ?build=…, it
   * re-keys the whole module graph per app build: the relative imports
   * inherit the query, so a rebuilt facade set is a different URL set — a
   * poisoned immutable cache entry from an older build can never be served
   * to a newer frame.
   */
  buildStamp?: string
}

export function buildExtensionSrcdoc(options: ExtensionSrcdocOptions): string {
  const { token, origin, artifactBase, dirName } = options
  const entry = options.entry ?? 'dist/index.js'
  if (token === '' || origin === '' || artifactBase === '' || dirName === '') {
    throw new TypeError('buildExtensionSrcdoc: token, origin, artifactBase and dirName are all required')
  }
  if (!artifactBase.startsWith('/iris-st-ext/')) {
    throw new TypeError(`buildExtensionSrcdoc: artifactBase "${artifactBase}" is not under the /iris-st-ext/ mount`)
  }
  if (/[<>"'\\/]/u.test(dirName)) {
    throw new TypeError(`buildExtensionSrcdoc: dirName "${dirName}" contains markup or path characters`)
  }

  // The card policy's own body, then connect-src swapped from its no-network
  // default to this host's explicit origin. The appending (not replacing) is
  // why this is a string splice on the policy the sandbox actually ships: if
  // the card policy tightens, the extension frame tightens with it.
  const base = framePolicy(false, origin)
  const policy = base.replace(/connect-src[^;]*/u, `connect-src ${origin}`)

  const parts: string[] = []
  parts.push('<!doctype html>')
  parts.push('<html>')
  parts.push('<head>')
  parts.push(`<meta http-equiv="Content-Security-Policy" content="${policy}; worker-src ${origin} blob:">`)
  parts.push(`<meta name="iris-st-ext-token" content="${token}">`)
  parts.push(`<meta name="iris-st-ext-base" content="${artifactBase}">`)
  parts.push(`<meta name="iris-st-ext-dir" content="${dirName}">`)
  // Vendor globals: the upstream bundle self-starts through jQuery's ready
  // queue and reads lodash and toastr as globals. Loaded as blocking classic
  // scripts so they exist before the module graph evaluates.
  parts.push(`<script src="${origin}${artifactBase}/vendor/jquery.min.js" crossorigin="anonymous"></script>`)
  parts.push(`<script src="${origin}${artifactBase}/vendor/lodash.min.js" crossorigin="anonymous"></script>`)
  parts.push('</head>')
  parts.push('<body></body>')
  // The upstream bundle, one byte changed by no one. Its relative imports
  // resolve against this URL, which is what makes the facade mirror work.
  const buildQuery = options.buildStamp === undefined ? '' : `?build=${options.buildStamp}`
  parts.push(`<script type="module" src="${origin}${artifactBase}/scripts/extensions/third-party/${dirName}/${entry}${buildQuery}" crossorigin="anonymous"></script>`)
  parts.push('</html>')
  return parts.join('\n')
}
