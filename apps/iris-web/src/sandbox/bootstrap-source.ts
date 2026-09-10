/**
 * Checking that the bootstrap is still the bootstrap.
 *
 * A dev server transformed it once. `dist-sandbox/bootstrap.js` sat inside the
 * Vite project root, so a plain `fetch` of it came back with
 * `import { injectQuery } from "/@vite/client"` prepended — the file on disk was
 * a self-contained IIFE, and the bytes the shell received were an ES module.
 *
 * Injected into a `srcdoc` classic script, that `import` is a **parse-time**
 * syntax error: the whole script block never executes, so the frame's own
 * try/catch reporter — which is runtime — cannot exist yet to report it. The
 * frame simply says nothing, which is the most expensive answer a sandbox can
 * give and the one thing all the diagnostics were built to eliminate.
 *
 * So the check happens on the outside, where a parse error is still
 * preventable. This is the layer the frame cannot defend for itself.
 *
 * **Its one caller is now the build** (`tools/check-bootstrap.mjs`), and that is
 * a narrowing worth recording. Until 2026-09-10 the shell fetched the
 * bootstrap's source, ran this over it, and inlined the text into every frame;
 * three call sites did so. The frame loads the file itself now (§91), so there
 * is no text on the shell side to check — and the failure this function was
 * written for became visible from inside the frame for the first time: a
 * transformed file is a `<script src>` that parses to nothing, sets no marker,
 * and is reported by name by the guard in `bootstrap-contract.ts`.
 *
 * The two are not redundant and neither replaces the other. This one reads the
 * **emitted** bytes and can say *what* is wrong with them in a sentence a
 * developer can act on, at the moment the build produced them; the guard reads
 * the **served** bytes, cannot see them at all, and can only say that nothing
 * installed. A dev server that rewrites on the way out is invisible to this
 * function and visible to the guard; a bundler misconfiguration is the reverse.
 *
 * @module iris-web/sandbox/bootstrap-source
 */

/** What a correct bootstrap starts with: an IIFE, in one of the two shapes a bundler emits. */
const IIFE_START = /^\s*[!;(]?\s*function\s*\(|^\s*\(\s*function\s*\(|^\s*\(\s*\(\s*\)\s*=>/

/** Markers that mean something rewrote the file on its way here. */
const TRANSFORMED = ['/@vite/client', 'import.meta.hot', '__vite__injectQuery']

/**
 * Verify a fetched bootstrap is still a classic self-contained script.
 *
 * @param source - the text about to be injected into a frame.
 * @returns undefined when it is usable, or a sentence explaining what is wrong.
 */
export function checkBootstrap(source: string): string | undefined {
  if (source.trim() === '') return 'the bootstrap is empty'

  // First, because it is the most actionable and the easiest to hit: a dev server
  // answers an unknown path with the SPA fallback at **status 200**, so
  // `response.ok` is no protection at all. A wrong or stale path yields the index
  // page, and the index page happens to mention `/@vite/client` — which would
  // otherwise be diagnosed as a transform and send the reader to the wrong fix.
  if (/^\s*<!doctype html|^\s*<html/i.test(source)) {
    return 'the bootstrap path returned an HTML page — the dev server answered an unknown path with its index'
  }

  for (const marker of TRANSFORMED) {
    if (source.includes(marker)) {
      return `the bootstrap was transformed by the dev server (found "${marker}") — it must be served verbatim, not as a module`
    }
  }

  // Ordered most specific first, because the message is the product here. A named
  // transform beats "has module syntax", which in turn beats "is not an IIFE" —
  // all three can be true of the same file, and only the first tells the reader
  // what to change.
  if (/^\s*(?:import|export)\s/m.test(source)) {
    // Anchored to line starts so an `import(` expression — which the module
    // execution path legitimately uses — and the word inside a string do not trip.
    return 'the bootstrap contains module syntax, which is a parse error in a classic script'
  }

  if (!IIFE_START.test(source)) {
    return 'the bootstrap does not begin with an IIFE — it is not the built classic bundle'
  }

  return undefined
}
