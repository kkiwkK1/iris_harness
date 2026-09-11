/**
 * Faithfulness to ST-Prompt-Template's EJS, including the parts that are bugs.
 *
 * The extension does not run stock EJS. It vendors 3.1.9 and patches it — six
 * hunks, ninety-two lines, measured by extracting the ejs module out of its
 * browserify bundle and diffing against npm's 3.1.9. This module carries the
 * patches that change behaviour, as named, tested transformations rather than as
 * an opaque vendored blob: the license stays clean, each delta stays visible,
 * and re-checking after an upstream release is a diff instead of an audit.
 *
 * **The pin is 3.1.10, one release ahead of what the extension vendors** (moved
 * 2026-09-11). 3.1.10 is 3.1.9 plus CVE-2024-33883 — `hasOwnOnlyObject` and
 * `createNullProtoObjWherePossible` on the options and data objects. Both
 * preamble patches below still apply to it byte for byte, asserted by
 * `tests/upstream.test.ts`, and the bump *narrows* the distance to upstream:
 * `hasOwnOnlyObject` is one of the two hunks listed at the bottom of this file's
 * ledger entry as carried by the extension and not by stock, and stock has it
 * now.
 *
 * The extension has `auto_update: true`. This is a snapshot of **v1.17.4.1**.
 * To re-check: extract the ejs module from
 * `src/3rdparty/ejs.js` (it is browserify module 1, ending at the
 * `"../package.json":6` boundary), dedent it, and diff against
 * `node_modules/ejs/lib/ejs.js`.
 *
 * Every patch here has **zero sites in the local corpus**. That is stated rather
 * than hidden: `docs/ARCHITECTURE.md` says the corpus is the oracle for
 * compatibility work, and when the corpus is silent the honest substitute is a
 * test pinned to upstream's source, not a guess dressed as a measurement.
 *
 * @module @iris/compat-prompt-template/upstream
 */

/**
 * Raised when a patch could not be applied.
 *
 * Loudly, because a patch that silently no-ops is worse than an absent one: the
 * package would claim upstream's semantics while running stock EJS's. This
 * happens if the pinned `ejs` version drifts and its emitted preamble changes.
 */
export class UpstreamPatchError extends Error {
  override name = 'UpstreamPatchError'
}

/**
 * The five options the extension defaults every compile to.
 *
 * `client: true` is why the compiled template can be moved across a realm at
 * all: it makes EJS emit a self-contained function source instead of one that
 * closes over the engine.
 */
export const UPSTREAM_COMPILE_OPTIONS = {
  async: true,
  outputFunctionName: 'print',
  _with: true,
  localsName: 'locals',
  client: true,
} as const

/**
 * Upstream's short-circuit: text with no opening delimiter is returned untouched.
 *
 * Not an optimisation. It is the reason a card's prose never has to be escaped:
 * a field that contains no `<%` is never handed to a compiler, so nothing in it
 * can be a syntax error.
 * @param text - the candidate.
 * @param openDelimiter - EJS's `openDelimiter` option.
 * @param delimiter - EJS's `delimiter` option.
 * @returns whether upstream would evaluate this text.
 */
export function hasTemplate(text: string, openDelimiter = '<', delimiter = '%'): boolean {
  return text.includes(`${openDelimiter}${delimiter}`)
}

/**
 * The extension's escape function, which does not escape.
 *
 * ```js
 * export function escape(markup: string): string {
 *   // don't escape any XML tags
 *   return markup;
 * }
 * ```
 *
 * So `<%=` and `<%-` are **the same tag** in this dialect. The corpus has 289
 * `<%=` sites; restoring EJS's HTML escaping changes what **3** of them render,
 * measured by `scripts/template-differential.mjs --self-check`. Small, and not
 * cosmetic: the three interpolate variable text containing apostrophes, which
 * would reach the model as `&#39;`. The tag count is not the dependency count —
 * escaping only shows where an output actually carries `& < > " '`.
 * @param markup - the value EJS is about to append.
 * @returns it, unchanged.
 */
export function identityEscape(markup: string): string {
  return markup
}

/** What EJS's includer must return. */
export interface IncluderResult {
  filename: string
  template: string
}

/**
 * The extension's `include`, which is a stub.
 *
 * It warns and returns an empty template, so `<% include('x') %>` silently
 * contributes nothing upstream. Copied rather than implemented: the corpus has
 * zero `include` sites, and building a working one would make Iris render a
 * template that renders as empty in the user's SillyTavern.
 * @param originalPath - the path as written in the template.
 * @returns an empty template, named after the requested path.
 */
export function stubInclude(originalPath: string): IncluderResult {
  return { filename: originalPath, template: '' }
}

/**
 * EJS's error decorator, passed in as the compiled function's fourth argument.
 *
 * Identical to the copy the extension passes, which is itself a copy of EJS's
 * own. It is supplied explicitly rather than left to the compiled source's
 * `rethrow = rethrow || …` fallback so that the frame the template sees comes
 * from this package and can be reasoned about here.
 * @param err - the error thrown inside the template.
 * @param str - the template source.
 * @param flnm - the filename.
 * @param lineno - the line the error occurred on.
 * @param esc - the escape function, applied to the filename.
 * @returns never; always throws.
 */
export function rethrow(
  err: Error,
  str: string,
  flnm: string,
  lineno: number,
  esc: (markup: string) => string = identityEscape,
): never {
  const lines = str.split('\n')
  const start = Math.max(lineno - 3, 0)
  const end = Math.min(lines.length, lineno + 3)
  const filename = esc(flnm)
  const context = lines.slice(start, end).map((line, i) => {
    const curr = i + start + 1
    return `${curr === lineno ? ' >> ' : '    '}${curr}| ${line}`
  }).join('\n')

  err.message = `${filename || 'ejs'}:${lineno}\n${context}\n\n${err.message}`
  throw err
}

// --- the source patches -----------------------------------------------------
// Both act on the preamble EJS emits under `client: true`. Exact-match, and a
// miss throws: see `UpstreamPatchError`.

/** Stock EJS's single-argument appender. Identical in 3.1.9 and the pinned 3.1.10. */
const STOCK_APPEND = '  function __append(s) { if (s !== undefined && s !== null) __output += s }'

/**
 * The extension's variadic appender.
 *
 * Consequence: `print(a, b, c)` appends all three upstream and only `a` under
 * stock EJS. Zero corpus sites — `print` is never called — so this is carried
 * for fidelity and pinned by test, not validated by measurement.
 */
const PATCHED_APPEND = '  function __append(...args) { args.filter(x => x !== undefined && x !== null).forEach(s => __output += s) }'

/** Stock EJS's binding of `outputFunctionName`. Identical in 3.1.9 and the pinned 3.1.10. */
const STOCK_PRINT_BINDING = `  var ${UPSTREAM_COMPILE_OPTIONS.outputFunctionName} = __append;`

/**
 * The extension's binding, which is a `const`.
 *
 * Consequence: a template that declares its own `var print` throws upstream and
 * quietly shadows under stock EJS. Zero corpus sites.
 */
const PATCHED_PRINT_BINDING = `  const ${UPSTREAM_COMPILE_OPTIONS.outputFunctionName} = __append;`

/**
 * Apply the two preamble patches to a compiled client source.
 * @param source - `String(ejs.compile(text, { client: true, … }))`.
 * @returns the source with upstream's preamble.
 * @throws UpstreamPatchError when the pinned engine's preamble has drifted.
 */
export function applySourcePatches(source: string): string {
  let patched = source
  for (const [stock, replacement] of [
    [STOCK_APPEND, PATCHED_APPEND],
    [STOCK_PRINT_BINDING, PATCHED_PRINT_BINDING],
  ] as const) {
    if (!patched.includes(stock)) {
      throw new UpstreamPatchError(
        `cannot apply upstream's preamble patch: stock ejs no longer emits ${JSON.stringify(stock)}. ` +
        'Re-diff against the extension before changing the pin.',
      )
    }
    patched = patched.replace(stock, replacement)
  }
  return patched
}

/**
 * EJS's suggestion to go and run EJS-Lint, which upstream comments out.
 *
 * Worth porting rather than filing as cosmetic: the text tells the reader to
 * reach for a tool that is no part of Iris, and this message is the one a card
 * author actually sees when their template does not compile. Upstream's
 * replacement is to attach the generated source to the error instead, which
 * `describeFailure` in `child.ts` does by reporting the origin.
 */
const EJS_LINT_HINT = /\n*If the above error is not helpful, you may want to try EJS-Lint:\nhttps:\/\/github\.com\/RyanZim\/EJS-Lint(\n+Or, if you meant to create an async function, pass `async: true` as an option\.)?/

/**
 * Strip the parts of an EJS compile error upstream removed.
 * @param message - the error's message.
 * @returns the message upstream would have shown.
 */
export function stripLintHint(message: string): string {
  return message.replace(EJS_LINT_HINT, '')
}

// --- the scanner patch ------------------------------------------------------

/** The shape of EJS's `Template` prototype that the patch needs. */
interface TemplatePrototype {
  opts: { delimiter?: string, openDelimiter?: string, closeDelimiter?: string, rmWhitespace?: boolean }
  templateText: string
  parseTemplateText: () => string[]
  scanLine: (line: string) => void
  generateSource: () => void
}

/** Set once the prototype has been patched, so installing twice is a no-op. */
const INSTALLED = Symbol.for('@iris/compat-prompt-template.nestedDelimiters')

/**
 * Replace EJS's scanner with the extension's nesting-aware one.
 *
 * Upstream counts nesting levels while pairing tokens instead of demanding that
 * a tag's third token be its close. The mechanism is nesting; the **observable**
 * effect is that a delimiter appearing inside a tag's own code no longer breaks
 * the tag. Measured, stock EJS and the extension diverge on exactly this:
 *
 * ```js
 * <% var s = "<% x %>"; print(s); %>       // stock: "Could not find matching
 * <% var re = /<%.*?%>/g; print(re); %>    //         close tag"; upstream: fine
 * ```
 *
 * The second is not hypothetical — a card in the corpus ships a script built
 * around `/<%[\s\S]*?%>/g` to strip EJS from message text, so authors do write
 * that pattern. What stock EJS already handles, and what therefore does *not*
 * need this patch: sequential tags (`<% if (x) { %>A<% } %>`) and upstream's own
 * `@@private` wrapper (`<% (()=>{ %>…<% })(); %>`), which are separate tags
 * rather than one tag containing a delimiter.
 *
 * Zero corpus sites in template text today, which is why it is carried on
 * fidelity grounds: the failure mode without it is a whole world-info entry
 * silently reverting to its unevaluated text.
 *
 * Transcribed from `src/3rdparty/ejs.js` at v1.17.4.1, structure preserved
 * including the redundant final `processedTokens.length` guard. Whitespace
 * slurping is left where upstream has it — before parsing, and hardcoded to
 * `<%_`/`_%>` rather than built from the configured delimiters, which is stock
 * EJS's own behaviour and therefore not a patch.
 * @param ejsModule - the `ejs` module object, whose `Template` is patched in place.
 */
export function installNestedDelimiters(ejsModule: unknown): void {
  const holder = ejsModule as { Template?: { prototype: TemplatePrototype } } & Record<symbol, unknown>
  const template = holder.Template
  if (!template) {
    throw new UpstreamPatchError(
      'the pinned ejs does not expose `Template`, so the nested-delimiter patch cannot be installed',
    )
  }
  if (holder[INSTALLED] === true) return

  template.prototype.generateSource = function generateSource(this: TemplatePrototype): void {
    const opts = this.opts
    const d = opts.delimiter ?? '%'
    const o = opts.openDelimiter ?? '<'
    const c = opts.closeDelimiter ?? '>'

    if (opts.rmWhitespace) {
      this.templateText = this.templateText.replace(/[\r\n]+/g, '\n').replace(/^\s+|\s+$/gm, '')
    }
    this.templateText = this.templateText.replace(/[ \t]*<%_/gm, '<%_').replace(/_%>[ \t]*/gm, '_%>')

    const allTokens = this.parseTemplateText()
    const processedTokens: string[] = []
    let i = 0

    while (i < allTokens.length) {
      const token = allTokens[i] as string

      if (token.startsWith(o + d) && token !== o + d + d) {
        let nestingLevel = 1
        const contentBuffer: string[] = []
        let j = i + 1

        while (j < allTokens.length) {
          const innerToken = allTokens[j] as string

          if (innerToken.startsWith(o + d) && innerToken !== o + d + d) {
            nestingLevel++
          } else if (innerToken.endsWith(d + c) && innerToken !== d + d + c) {
            nestingLevel--

            if (nestingLevel === 0) {
              processedTokens.push(token)
              processedTokens.push(contentBuffer.join(''))
              processedTokens.push(innerToken)

              i = j
              break
            }
          }

          contentBuffer.push(innerToken)
          j++
        }

        if (nestingLevel !== 0) {
          throw new Error(`Could not find matching close tag for "${token}".`)
        }
      } else {
        processedTokens.push(token)
      }

      i++
    }

    for (const line of processedTokens) this.scanLine(line)
  }

  holder[INSTALLED] = true
}

/**
 * Patches measured but deliberately **not** installed, and why.
 *
 * Both are only reachable through EJS's `destructuredLocals` / `_with: false`
 * path, which upstream takes only when its `with_context_disabled` setting is
 * on. That setting is off in the user's live configuration and this package does
 * not implement it, so installing these would be untested code guarding an
 * unreachable branch. Whoever implements `with_context_disabled` must bring them
 * along — that is the point of writing them down here rather than dropping them.
 *
 * - `_JS_IDENTIFIER` is widened from `/^[a-zA-Z_$][0-9a-zA-Z_$]*$/` to
 *   `/^[\p{ID_Start}$_][\p{ID_Continue}$_]*$/u`, making non-ASCII locals legal.
 * - The block restructuring around `with`: upstream wraps `destructuredLocals`
 *   in its own block with `const __locals` instead of a bare `var`, and emits a
 *   block even when `_with` is false, where stock emits none. With `with` on and
 *   no destructured locals — this package's only configuration — the same hunk
 *   produces nothing but one extra space in `with (locals || {})  {`, which is
 *   why the reachable part of it is deferred rather than ported.
 */
export const DEFERRED_PATCHES = ['_JS_IDENTIFIER', 'destructuredLocals scoping'] as const
