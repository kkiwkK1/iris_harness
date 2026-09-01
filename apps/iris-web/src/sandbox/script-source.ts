/**
 * Preparing a card's script body for execution.
 *
 * Both rules here are copied from upstream rather than decided: Tavern Helper
 * builds every script iframe with `<script type="module">` — unconditionally, no
 * per-script branch — and strips a Markdown fence off the content first. Read
 * from `panel/script/iframe.ts` in the installed extension, not inferred.
 *
 * Copying matters more than agreeing. A card that works today works against
 * these exact semantics, and a compatibility layer that improves on them is
 * compatible with something else.
 *
 * @module iris-web/sandbox/script-source
 */
import { fromProxied } from './bundle-proxy.ts'

/** How a body is executed. */
export type ScriptMode = 'classic' | 'module'

/**
 * Remove a Markdown code fence wrapping the whole body.
 *
 * Card scripts are edited in fields that show Markdown, so authors fence them and
 * the fence is stored. Upstream's own pattern anchors to the whole string and
 * takes the inner text, which means a fence in the *middle* of a script is left
 * alone — only a wrapper is removed. That distinction is deliberate here too: a
 * body containing a fenced example is not a fenced body.
 * @param content - the stored script body.
 * @returns the body without its wrapper fence.
 */
export function stripCodeFence(content: string): string {
  // Mirrors upstream: `/^\s*```[^\n]*\n(.*)\n```\s*$/is`. Dot-matches-newline and
  // anchored, so it either consumes the entire body or does nothing.
  const fenced = /^\s*```[^\n]*\n([\s\S]*)\n```\s*$/.exec(content)
  return fenced?.[1] ?? content
}

/**
 * Whether a body needs module semantics.
 *
 * Not a heuristic over the source — upstream does not have one, and inventing a
 * sniffer would mean cards behaving differently here for reasons no card author
 * could predict. Card scripts are modules because that is what upstream runs
 * them as; the classic path exists for Iris's own probe, which deliberately
 * exercises the shadowed globals a module cannot receive.
 * @param kind - what is being run.
 * @returns the execution mode.
 */
export function modeFor(kind: 'card-script' | 'probe'): ScriptMode {
  return kind === 'card-script' ? 'module' : 'classic'
}

/**
 * The remote modules a body will try to load.
 *
 * Extracted only to name them in a timeout message. A module import that never
 * settles is the one failure in this sandbox that cannot report itself — it does
 * not throw, so there is nothing to catch, and the frame simply stops. Saying
 * "the import timed out" is useful; saying which host it was waiting on is what
 * turns it into an action.
 *
 * Deliberately shallow: `from '…'` and bare `import '…'` at a line start, http(s)
 * only. It is a diagnostic, so a missed specifier costs a vaguer message and
 * nothing else.
 * Two callers want two different answers, and conflating them broke a
 * diagnostic for a whole round — see `requestedImports` below.
 * @param source - the card body.
 * @returns the remote specifiers as the card wrote them, in order, without
 *   duplicates.
 */
export function remoteImports(source: string): string[] {
  return scanImports(source, true)
}

/**
 * The remote specifiers **as the browser will request them**.
 *
 * The same scan without the unwrapping, and it exists because the unwrapping is
 * right for one caller and wrong for the other:
 *
 * - *Naming a stalled import* wants the card's own URL. A reader asking which
 *   bundle is missing does not care that Iris routes it, and our proxy in that
 *   sentence sends them to the wrong resource.
 * - *Checking whether the request was sent* wants the URL that was actually
 *   requested. Resource timing records what the browser fetched, which after
 *   rewriting is the proxy URL.
 *
 * The stalled-import report used the unwrapped list for both. It therefore asked
 * resource timing for an entry under a URL the browser was never going to
 * request, found none, and concluded "the browser never sent the request" —
 * **a verdict that was structurally true no matter what had happened**. It
 * reported a healthy, cache-warm proxy fetch as a refusal before the wire, and
 * an instrument that cannot return the other answer is not evidence.
 *
 * @param source - the card body, after any rewriting.
 * @returns the specifiers exactly as written, in order, without duplicates.
 */
export function requestedImports(source: string): string[] {
  return scanImports(source, false)
}

/**
 * Scan a body for http(s) import specifiers.
 * @param source - the card body.
 * @param unwrap - whether to report a proxied URL as the card's original.
 * @returns the specifiers, in order, without duplicates.
 */
function scanImports(source: string, unwrap: boolean): string[] {
  const found = new Set<string>()

  // Scanned line by line with string operations rather than matched with a
  // pattern. Every escape sequence this file could need has been eaten in transit
  // at least four times in this project, each time producing something that still
  // parsed and silently matched nothing. Where a literal will do, a literal is
  // safer than a pattern that has to survive being written down.
  // The newline is built from its code point. Writing it as an escape has been
  // eaten in transit four times in this project, and a collapsed escape still
  // parses — the last one turned this very split into a split on a literal
  // newline character inside the source string.
  const NEWLINE = String.fromCharCode(10)
  for (const raw of source.split(NEWLINE)) {
    const line = raw.trim()
    if (!line.startsWith('import ') && !line.startsWith('import"') && !line.startsWith("import'")) continue

    for (const quote of ['"', "'"]) {
      let at = line.indexOf(quote)
      while (at !== -1) {
        const end = line.indexOf(quote, at + 1)
        if (end === -1) break
        const value = line.slice(at + 1, end)
        if (value.startsWith('http://') || value.startsWith('https://')) {
          found.add(unwrap ? fromProxied(value) ?? value : value)
        }
        at = line.indexOf(quote, end + 1)
      }
    }
  }

  return [...found]
}
