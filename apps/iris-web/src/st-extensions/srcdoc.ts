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
 * The CSP reuses the card frame's policy on purpose: the extension compiles
 * EJS templates client-side (`new Function`), Monaco's worker may fall back to
 * a blob URL, and the card policy already draws exactly those lines.
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

  const parts: string[] = []
  parts.push('<!doctype html>')
  parts.push('<html>')
  parts.push('<head>')
  parts.push(`<meta http-equiv="Content-Security-Policy" content="${framePolicy(false, origin)}; worker-src ${origin} blob:">`)
  parts.push(`<meta name="iris-st-ext-token" content="${token}">`)
  parts.push(`<meta name="iris-st-ext-base" content="${artifactBase}">`)
  parts.push(`<meta name="iris-st-ext-dir" content="${dirName}">`)
  // Vendor globals: the upstream bundle self-starts through jQuery's ready
  // queue and reads lodash and toastr as globals. Loaded as blocking classic
  // scripts so they exist before the module graph evaluates.
  parts.push(`<script src="${origin}/st-ext/vendor/jquery.min.js" crossorigin="anonymous"></script>`)
  parts.push(`<script src="${origin}/st-ext/vendor/lodash.min.js" crossorigin="anonymous"></script>`)
  parts.push('</head>')
  parts.push('<body></body>')
  // The upstream bundle, one byte changed by no one. Its relative imports
  // resolve against this URL, which is what makes the facade mirror work.
  parts.push(`<script type="module" src="${origin}${artifactBase}/scripts/extensions/third-party/${dirName}/${entry}" crossorigin="anonymous"></script>`)
  parts.push('</html>')
  return parts.join('\n')
}
