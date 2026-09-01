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
    rollupOptions: {
      output: {
        /*
         * The whole bundle, wrapped in one try/catch at build time.
         *
         * This cannot be written in `preset-entry.ts`, and that is the reason it
         * is here: ES imports are hoisted, so a throw inside a dependency's
         * module body — Vue's, jQuery's — happens before the entry's first
         * statement, where no try/catch of the entry's could ever reach it. Only
         * something wrapping the emitted IIFE catches those.
         *
         * What it buys is the error's name. A frame is an opaque origin and the
         * preset is cross-origin to it, so a throw here reaches `window.onerror`
         * redacted to `Script error.` — real, and carrying nothing. Recorded on
         * the frame's own window instead, it is just a value, and the frame
         * reports it verbatim.
         *
         * Deliberately not rethrown. The frame already knows the bundle failed,
         * because the end-of-file marker is missing; rethrowing would add a
         * masked, nameless `Script error.` next to the named one and invite a
         * reader to treat them as two findings.
         *
         * The inner try/catch is not defensive habit: this runs while the frame
         * is in an unknown state, and an assignment that throws would replace a
         * diagnosable failure with a silent one.
         */
        banner: 'try{',
        footer:
          '}catch(irisPresetError){try{window.__iris_preset_error__=' +
          '(irisPresetError&&irisPresetError.stack)||String(irisPresetError)}catch(ignored){}}',
      },
    },
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/preset-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisCardLibraries',
      fileName: () => 'preset.js',
    },
  },
})
