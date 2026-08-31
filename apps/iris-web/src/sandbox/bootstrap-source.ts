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
 * So the check happens before injection, on the outside, where a parse error is
 * still preventable. This is the layer the frame cannot defend for itself.
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
