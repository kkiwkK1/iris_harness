import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The card-sandbox bootstrap, built on its own.
 *
 * A second config rather than a second input on the main build, because the
 * output format has to differ: this one is a **classic IIFE** with no imports at
 * run time, and the app is an ES module graph.
 *
 * Why classic: a card's frame has an opaque origin (`sandbox="allow-scripts"`
 * with no `allow-same-origin`). A module script fetched from there is
 * CORS-checked; a classic script is not. And the host does not serve this at a
 * URL at all — it reads the text and inlines it into the frame's `srcdoc`, which
 * has no module graph to resolve against. Inlining also means the code inside a
 * frame cannot be swapped by anything that can answer a path.
 *
 * The result is one self-contained file at a stable name, which is the whole
 * contract with the host half.
 */
export default defineConfig({
  configFile: false,
  build: {
    // Written beside the app's own output, not into it: `emptyOutDir` would
    // otherwise have to be reasoned about every time either build runs.
    outDir: 'dist-sandbox',
    emptyOutDir: true,
    target: 'es2022',
    // Inlined into markup, so a sourcemap comment would point at a file that is
    // not served and the frame would log a fetch failure for every card.
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/frame-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisSandbox',
      fileName: () => 'bootstrap.js',
    },
  },
})
