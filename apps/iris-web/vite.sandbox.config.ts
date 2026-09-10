import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * The card-sandbox bootstrap, built on its own.
 *
 * A second config rather than a second input on the main build, because the
 * output format has to differ: this one is a **classic IIFE** with no imports at
 * run time, and the app is an ES module graph.
 *
 * Why classic, in the order the reasons now matter (2026-09-10, §91):
 *
 * - **A module script is deferred by definition.** The frame loads this with a
 *   blocking `<script src>` because a card's markup reads bridged names while
 *   the document is still parsing, so the bootstrap has to finish first. A
 *   module would run after the whole document — the one ordering this frame
 *   cannot survive.
 * - **A module from an opaque origin is CORS-checked** and a classic script is
 *   not. This used to be the leading reason and is now the second one.
 *
 * The host **does** serve it at a URL, and until 2026-09-10 it did not: the
 * shell read the text and inlined it into every frame's `srcdoc`, on the
 * reasoning that inlined code cannot be swapped by anything that can answer a
 * path. What that cost was 53 KB per frame with no cache, charged against the
 * reading window's byte budget; the substitution worry it answered is covered by
 * the content hash (a name whose bytes changed is a different name) and by the
 * frame's CSP, which admits Iris's own origin and nothing else for this.
 *
 * The result is still one self-contained file, now at a content-addressed name,
 * which is the whole contract with the host half.
 */
export default defineConfig({
  configFile: false,
  build: {
    /*
     * Emitted into `public/`, and that is the whole fix for a real failure.
     *
     * It used to go to `dist-sandbox/`, which sits inside the Vite project root —
     * so a `fetch('/dist-sandbox/bootstrap.js')` in dev came back **transformed
     * into an ES module**, with `import … from "/@vite/client"` prepended. Injected
     * into a `srcdoc` classic script that is a parse error, the block never runs,
     * and the frame's own runtime reporter never exists to say so. The symptom was
     * a frame that sent nothing at all.
     *
     * `public/` is the one directory Vite serves verbatim and copies untouched,
     * which is exactly the guarantee this file needs — and it is now load-bearing
     * for a second reason: the frame fetches this file by URL, so "served
     * verbatim" is no longer a property of a build step but of every request a
     * frame makes.
     */
    outDir: 'public/sandbox',
    // NOT emptied: `public/` is a served directory, and emptying a slice of it on
    // every build is a footgun aimed at whatever else ends up there.
    emptyOutDir: false,
    target: 'es2022',
    // No sourcemap: the comment would point at a file the build does not emit,
    // and every frame would log a fetch failure for it. (Written when this was
    // inlined into markup; still true now that it is fetched, for the plainer
    // reason that the `.map` is not there.)
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/frame-entry.ts', import.meta.url)),
      formats: ['iife'],
      name: 'IrisSandbox',
      fileName: () => 'bootstrap.js',
    },
  },
})
