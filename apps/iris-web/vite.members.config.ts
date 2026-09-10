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
 * It differed in the one way the split was for: this was fetched by URL where
 * the bootstrap was inlined into every frame's `srcdoc` and paid per frame, and
 * at twelve live frames that difference was the larger part of the byte budget.
 * **Both are fetched by hashed URL as of 2026-09-10** (§91), so the two configs
 * now differ only in which entry they build and whether they are card-facing.
 * Whether they should still be two artifacts is an open question recorded
 * there, not one this file answers.
 */
export default defineConfig({
  configFile: false,
  build: {
    outDir: 'public/sandbox',
    // NOT emptied, for the same reason the bootstrap build does not empty it:
    // `public/` is a served directory shared with everything else in it.
    emptyOutDir: false,
    target: 'es2022',
    // Fetched by URL, so a sourcemap comment would resolve — but this is
    // card-facing code in an opaque origin, and shipping one buys a reader
    // nothing they cannot get from the source tree. (The sandbox build says the
    // same for the same reason now that it is fetched too.)
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/members-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisMembers',
      fileName: () => 'members.js',
    },
  },
})
