import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The card-facing member table, built on its own.
 *
 * Same output shape as the bootstrap — classic IIFE, no run-time imports, served
 * verbatim out of `public/` — for the reasons `vite.sandbox.config.ts` records:
 * a frame's opaque origin makes a module script a CORS fetch, and a classic one
 * is not.
 *
 * It differs in the one way the split is for: this is fetched by URL and cached
 * once per page, where the bootstrap is inlined into every frame's `srcdoc` and
 * paid per frame. At twelve live frames that difference is the larger part of
 * the byte budget.
 */
export default defineConfig({
  configFile: false,
  build: {
    outDir: 'public/sandbox',
    // NOT emptied, for the same reason the bootstrap build does not empty it:
    // `public/` is a served directory shared with everything else in it.
    emptyOutDir: false,
    target: 'es2022',
    // Fetched by URL rather than inlined, so unlike the bootstrap a sourcemap
    // would resolve — but it is still card-facing code in an opaque origin, and
    // shipping one buys a reader nothing they cannot get from the source tree.
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/members-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisMembers',
      fileName: () => 'members.js',
    },
  },
})
