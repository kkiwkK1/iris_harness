import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The card-library bundle, built on its own.
 *
 * A third config rather than a second entry on the sandbox build, because IIFE
 * output takes exactly one entry — and IIFE is required for the same reason it is
 * required of the bootstrap: a card's frame is an opaque origin, where a classic
 * script loads and a module script is CORS-checked.
 *
 * It is emitted beside the bootstrap in `public/`, the one directory Vite serves
 * byte-for-byte, and loaded by tag rather than inlined so the browser parses it
 * once per origin instead of once per frame.
 */
export default defineConfig({
  configFile: false,
  /*
   * Vue's feature flags, as build-time constants rather than globals.
   *
   * `preset-entry.ts` also assigns these on `window`, because pinia and cards
   * read them there, and that assignment is not enough on its own: ES module
   * imports are hoisted, so Vue's own module body evaluates *before* any
   * statement of the entry runs. A flag Vue reads during its initialisation
   * would be missing at exactly the moment it is wanted, and the symptom would
   * be a warning or a dead branch inside a minified library — not a line anyone
   * could trace back to here.
   *
   * The values match upstream's `predefine.js` verbatim, including
   * `__VUE_PROD_DEVTOOLS__: true`, which is not the value a build tool would
   * choose. Upstream's comment records that pinia 4.0.0+ requires these and that
   * leaving them unset broke a great many scripts, so they are a compatibility
   * fact rather than a preference.
   */
  define: {
    __VUE_PROD_DEVTOOLS__: 'true',
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: 'public/sandbox',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/preset-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisCardLibraries',
      fileName: () => 'preset.js',
    },
  },
})
