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
