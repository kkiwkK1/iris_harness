import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The message frame's library bundle, built on its own.
 *
 * A fourth config, and the reason is the same one that made the third: the
 * output format has to be a **classic IIFE**, because a card's frame is an
 * opaque origin where a module script is CORS-checked and a classic one is not.
 *
 * Separate from `preset.js` rather than folded into it because the two frame
 * kinds need different things — upstream injects two libraries into a script
 * frame and eight into a message frame — and a script frame carrying Tailwind
 * and jQuery UI would be a megabyte spent on nothing. The provenance and version
 * of every library, and why each pin differs from upstream's CDN tag, is in
 * `src/sandbox/message-preset-entry.ts`.
 */

/**
 * Drop FontAwesome's TrueType fallbacks before any asset is resolved.
 *
 * Measured, because the first build was 5.49 MB against a 1.2 MB estimate: the
 * combined `all.min.css` redeclares each `@font-face` in several of its
 * sub-sheets, and every declaration lists **both** a `.woff2` and a `.ttf`
 * source. Inlining them all produced **20 data URIs totalling 4.0 MB** against
 * 1.45 MB of actual code.
 *
 * The `.ttf` sources are 708 KB of the 1,012 KB on disk and buy nothing here:
 * every browser that can run this frame at all — opaque-origin `srcdoc`, CSP
 * level 3, `ResizeObserver` — has supported woff2 for years. Dropping them is a
 * deliberate, documented reduction rather than an optimisation, so it is done
 * with a named transform instead of a tuned inline limit; a limit would have
 * decided by *size*, which is not the reason.
 *
 * String operations rather than a pattern, per this package's standing reason:
 * escapes here have been eaten in transit repeatedly, and a collapsed one still
 * parses while matching nothing.
 * @returns the Vite plugin.
 */
function dropTruetypeSources() {
  return {
    name: 'iris-drop-truetype',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      // The query has to be stripped before the extension check: with
      // `?inline` the module id ends in the query, not in `.css`, so the first
      // version of this guard never matched and the build came out byte-identical
      // — which is why the measurement below counts `format("truetype")` in the
      // output rather than looking for a `.ttf` path that inlining removes anyway.
      const path = id.split('?')[0] ?? id
      if (!path.includes('fontawesome') || !path.endsWith('.css')) return null

      const MARK = ',url('
      const parts = code.split(MARK)
      let out = parts[0] ?? ''
      for (let index = 1; index < parts.length; index += 1) {
        const segment = parts[index] ?? ''
        const close = segment.indexOf(')')
        const url = close === -1 ? '' : segment.slice(0, close)
        if (url.endsWith('.ttf')) {
          // Skip this whole `src` entry, including its `format("truetype")`.
          const after = segment.slice(close + 1)
          const formatEnd = after.indexOf(')')
          out += formatEnd === -1 ? after : after.slice(formatEnd + 1)
          continue
        }
        out += MARK + segment
      }
      return { code: out, map: null }
    },
  }
}

export default defineConfig({
  configFile: false,
  plugins: [dropTruetypeSources()],
  define: {
    /*
     * The same flags the script preset defines, for the same reason: Vue's
     * esm-bundler build reads `process.env.NODE_ENV` unguarded and its feature
     * flags as bare identifiers, and a config with `configFile: false` inherits
     * no defaults. Leaving them out threw `ReferenceError: process is not
     * defined` on line 19 of the other bundle and cost a verification round.
     */
    'process.env.NODE_ENV': '"production"',
    __VUE_PROD_DEVTOOLS__: 'true',
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: 'public/sandbox',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    /*
     * Above the largest font face, so FontAwesome's `.woff2` files are inlined
     * as data URIs instead of emitted as separate assets.
     *
     * This is the build flag behind a design property: a frame that fetches its
     * fonts separately has a state where the CSS arrived and the fonts did not,
     * and that state renders every icon as blank space with no error anywhere.
     * Inlining removes the state rather than instrumenting it. The cost is about
     * 91 KB of base64 overhead, and the property is asserted in
     * `tests/message-preset.test.ts` — which checks the *output*, not this
     * number, because a later change to the fonts could outgrow a literal.
     */
    assetsInlineLimit: 4_000_000,
    rollupOptions: {
      output: {
        /*
         * The same whole-bundle try/catch the script preset uses. A frame is an
         * opaque origin, so a throw in here reaches `window.onerror` redacted to
         * `Script error.`; recorded on the frame's own window instead, it is
         * just a value the frame can report verbatim.
         *
         * Deliberately not rethrown: the missing end-of-file marker already
         * tells the frame this bundle failed, and a second nameless error beside
         * the named one invites a reader to treat them as two findings.
         */
        banner: 'try{',
        footer:
          '}catch(irisPresetError){try{window.__iris_preset_error__=' +
          '(irisPresetError&&irisPresetError.stack)||String(irisPresetError)}catch(ignored){}}',
      },
    },
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/message-preset-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisMessageLibraries',
      fileName: () => 'message-preset.js',
    },
  },
})
