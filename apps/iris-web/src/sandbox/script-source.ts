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
