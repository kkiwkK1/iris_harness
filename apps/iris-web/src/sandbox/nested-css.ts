/**
 * Re-pointing a nested frame's CSS at the elements standing in for its document.
 *
 * A card that builds an overlay iframe writes CSS for a **document**: `html`,
 * `body`, `:root`, and the height chain `html,body,#app{height:100%}` that makes
 * a full-screen panel fill its frame. Iris cannot give it a document — a nested
 * frame in an opaque origin is unreachable, `contentDocument` is `null`, and
 * that is a browser fact rather than a policy choice (measured: a control frame
 * with no CSP at all answers `null` the same four ways). So the frame is
 * virtualised: the content lives in elements inside the *same* document.
 *
 * Which breaks those selectors twice over, in opposite directions:
 *
 * - **Unconfined**, `html,body{height:100%}` copied out of a card's sheet
 *   applies to the *real* `html` and `body` of the script frame — the card's
 *   overlay surface — and `*{box-sizing:border-box}` lands on the shell's own
 *   nodes. `card-css.ts`'s `@scope` closes that.
 * - **Confined**, they match nothing at all: inside `@scope (#root)`, a `body`
 *   selector looks for a `<body>` *within* that subtree, and there is none. The
 *   height chain silently resolves to `auto`, and the panel is a zero-height
 *   nothing that reports no error.
 *
 * `@scope` cannot fix the second, because the problem is the selector's *name*
 * rather than its reach. So the names are rewritten to the two wrappers that
 * stand for `html` and `body`, and the result is then confined by `card-css.ts`.
 * Both halves are needed; either alone leaves a card that mounts and shows
 * nothing, which is the failure this file exists to make impossible.
 *
 * @module iris-web/sandbox/nested-css
 */

import { scopeCardCss, type ScopedCss } from '../app/card-css.ts'

/** The elements standing in for a nested frame's document. */
export interface FrameStandInIds {
  /** Id of the element standing in for `html`, which is also the scope root. */
  html: string
  /** Id of the element standing in for `body`. */
  body: string
}

/**
 * Whether the character before a match lets it be a type selector.
 *
 * `.body`, `#body`, `--body` and `x-body` are all names that merely *contain*
 * the word; only a boundary makes `body` the element.
 * @param before - the character immediately before the match, or undefined at
 *   the start of the text.
 * @returns true when the match starts a selector token.
 */
function startsToken(before: string | undefined): boolean {
  if (before === undefined) return true
  return !/[A-Za-z0-9_\-.#[]/.test(before)
}

/**
 * Whether the character after a match lets it be a type selector.
 *
 * `bodybuilder` and `html-ish` continue the identifier; `body.dark`, `body>x`
 * and `body ` do not. A `(` would make it a function name, which `:root(` is
 * not but a card's `body(` could be in a `content:` string.
 * @param after - the character immediately after the match, or undefined at the
 *   end of the text.
 * @returns true when the match ends a selector token.
 */
function endsToken(after: string | undefined): boolean {
  if (after === undefined) return true
  return !/[A-Za-z0-9_\-(]/.test(after)
}

/**
 * Rewrite the document-level selectors in one selector list.
 *
 * Walks the text so quoted strings and attribute selectors are skipped: a rule
 * like `[data-role="body"]` or `content: "html"` names no element, and a
 * pattern that rewrote inside them would corrupt the card's own data.
 * @param selector - one selector list, as written.
 * @param ids - the stand-in element ids.
 * @returns the selector list with `html`, `:root` and `body` re-pointed.
 */
function repointSelector(selector: string, ids: FrameStandInIds): string {
  const out: string[] = []
  let index = 0
  let quote: string | undefined
  let inAttribute = false

  while (index < selector.length) {
    const char = selector[index] as string

    if (quote !== undefined) {
      out.push(char)
      if (char === '\\') {
        // An escape inside a string: the next character is data whatever it is.
        index += 1
        if (index < selector.length) out.push(selector[index] as string)
      } else if (char === quote) {
        quote = undefined
      }
      index += 1
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      out.push(char)
      index += 1
      continue
    }

    if (char === '[') inAttribute = true
    if (char === ']') inAttribute = false

    if (!inAttribute) {
      const rest = selector.slice(index)
      const found = (['html', ':root', 'body'] as const).find(name => rest.startsWith(name))
      if (
        found !== undefined
        && startsToken(index === 0 ? undefined : selector[index - 1])
        && endsToken(selector[index + found.length])
      ) {
        /*
         * **`html` and `:root` become `:scope`, not `#id`** — measured, and it
         * is the difference between the height chain working and silently not.
         *
         * The sheet is wrapped in `@scope (#<html id>)`, and inside a scope
         * every compound gets an implicit `:scope ` **descendant** prefix. So
         * `#nf-html` there means "a descendant of #nf-html that is also
         * #nf-html" and matches nothing at all — while `#nf-body`, a real
         * descendant, matches fine. The root term is the one that fails, and it
         * is the top of the chain, so everything under it resolves against
         * `auto`.
         *
         * Measured in a laid-out page, one host 300px tall, content 900px:
         *
         * | root selector | html | body | #app | scrollable |
         * | --- | --- | --- | --- | --- |
         * | `#nf-html` | 900 | 900 | 900 | no |
         * | `:scope`   | 300 | 300 | 300 | **yes** |
         * | `&`        | 300 | 300 | 300 | yes |
         * | no `@scope` (control) | 300 | 300 | 300 | yes |
         *
         * `:scope` over `&` because `&` inside `@scope` is newer and reads as
         * nesting to anyone skimming; both measured identical.
         *
         * The failure had no error and no warning: the rules parse, `#app`'s
         * background applies, and the panel is simply the wrong height. Without
         * the control row it would have looked like a percentage-height problem
         * rather than a selector-matching one.
         */
        out.push(found === 'body' ? `#${ids.body}` : ':scope')
        index += found.length
        continue
      }
    }

    out.push(char)
    index += 1
  }

  return out.join('')
}

/**
 * Re-point every selector in a sheet, leaving at-rule preludes alone.
 *
 * One walk, at every depth: the text before a `{` is a selector list unless it
 * starts with `@`, and the text inside a declaration block is never one.
 * @param css - the sheet text.
 * @param ids - the stand-in element ids.
 * @returns the sheet with document-level selectors re-pointed.
 */
function repointSheet(css: string, ids: FrameStandInIds): string {
  const out: string[] = []
  let selectorStart = 0
  let index = 0
  let quote: string | undefined

  while (index < css.length) {
    const char = css[index] as string

    if (quote !== undefined) {
      if (char === '\\') index += 1
      else if (char === quote) quote = undefined
      index += 1
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      index += 1
      continue
    }
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      index = end === -1 ? css.length : end + 2
      continue
    }

    if (char === '{') {
      const prelude = css.slice(selectorStart, index)
      /*
       * An at-rule prelude is copied verbatim, everything else is re-pointed.
       *
       * `@media (min-width: 40em)` has no selectors in it, and `@supports
       * (display: grid)` can contain the word `body` inside a property value —
       * rewriting either produces CSS the browser drops silently, which is the
       * same outcome as the bug this function exists to fix.
       *
       * **The leading `@` decides, not the nesting depth.** The first version
       * gated on `depth === 0`, which left every selector inside a `@media`
       * block un-re-pointed — so a responsive card lost its layout on exactly
       * the screens the query was written for, silently, because an unmatched
       * selector is not an error. Worse, the comment beside it claimed a
       * recursive pass handled them and there was no such pass.
       */
      out.push(prelude.trimStart().startsWith('@') ? prelude : repointSelector(prelude, ids))
      out.push('{')
      index += 1
      selectorStart = index
      continue
    }

    if (char === '}') {
      // A declaration block's contents are never a prelude, so they reach here
      // verbatim — only the text *before* a `{` is ever treated as selectors.
      out.push(css.slice(selectorStart, index))
      out.push('}')
      index += 1
      selectorStart = index
      continue
    }

    index += 1
  }

  out.push(css.slice(selectorStart))
  return out.join('')
}

/**
 * Prepare a nested frame's CSS for the elements standing in for its document.
 *
 * @param css - the sheet the card wants installed, as it wrote it.
 * @param ids - the stand-in element ids. `ids.html` is also the scope root, so
 *   a rule that survives applies to the whole stand-in subtree and nothing else.
 * @param seq - a stable identity for this frame, used for keyframe renaming so
 *   two frames' `@keyframes spin` do not collide.
 * @returns the confined, re-pointed CSS and what was refused.
 */
export function repointFrameCss(
  css: string,
  ids: FrameStandInIds,
  seq: string,
): ScopedCss {
  /*
   * Re-point first, confine second, and the order is load-bearing. `@scope`
   * is applied by wrapping the whole sheet; rewriting names afterwards would
   * have to reach inside that wrapper and would also rewrite the scope root's
   * own selector if it happened to be spelled the same way.
   */
  return scopeCardCss(repointSheet(css, ids), seq, `#${ids.html}`)
}

/**
 * The at-rules a nested frame's sheet loses, for a card author reading a report.
 *
 * Re-exported rather than re-derived: the list lives in `card-css.ts`, and the
 * point of routing through it is that there is one list.
 * @param scoped - the result of `repointFrameCss`.
 * @returns a sentence, or undefined when nothing was refused.
 */
export function describeFrameCssRefusals(scoped: ScopedCss): string | undefined {
  if (scoped.refused.length === 0) return undefined
  return `overlay frame CSS: ${scoped.refused.join(', ')} refused`
}
