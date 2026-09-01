/**
 * Tavern Helper's own macros: `{{get_*_variable::}}` and `{{format_*_variable::}}`.
 *
 * These are implemented by the extension, not by any card script and not by
 * SillyTavern's own macro engine, so a host that expands ST's `{{user}}` and
 * stops there sends the braces to the model verbatim. That is not cosmetic:
 * MVU's prompt asks the model to patch each variable "according to its `check`",
 * and `{{format_message_variable::stat_data}}` is where the current values were
 * supposed to be. Unexpanded, the model is asked to update a state it cannot
 * see, and it answers with nothing — which looks exactly like a model that will
 * not follow the format.
 *
 * Transcribed from `JS-Slash-Runner/src/function/macro_like.ts`, because the
 * details are all load-bearing and none of them are guessable:
 *
 * - **`get_` emits one line, `format_` emits a YAML block.** A string value is
 *   substituted raw by both — `{{get_message_variable::世界.时间阶段}}` yields
 *   `早上`, not `"早上"` (CHANGELOG 3.3.1).
 * - **Keys beginning with `$` are dropped, at every depth** (CHANGELOG, the
 *   `$meta` example). They are the framework's own bookkeeping.
 * - **A missing path is `null`**, not empty: upstream passes `null` as `_.get`'s
 *   default, so `get_` renders the four characters `null`. Rendering nothing
 *   would tell the model the variable does not exist, which is a different
 *   claim from "it has no value yet".
 * - **`format_` indents its block under whatever precedes it on the line.**
 *   Upstream pads every newline by the length of the text before the macro, so
 *   `状态: {{format_...}}` produces a block aligned under `状态: `. Without it
 *   the second line lands at column 0 and the YAML means something else.
 *
 * @module @iris/compat-tavernhelper/macros
 */

/**
 * The five scopes upstream's variable macros name.
 *
 * One list, and everything that needs to know the set is derived from it: the
 * two matching patterns, the type, and the predicate the host uses to decide
 * whether an unexpanded macro is one of ours. Four hand-written copies of this
 * set existed before, in two packages, and the one furthest from here decided
 * **attribution** — so adding a sixth scope would have left it quietly reporting
 * a macro of ours as the card's own. Duplicated logic where only one copy
 * carries its reason is the copy that gets changed alone.
 */
export const MACRO_SCOPES = ['message', 'chat', 'character', 'preset', 'global'] as const

/** Which variable scope a macro names. */
export type MacroScope = typeof MACRO_SCOPES[number]

/** The scopes as a regex alternation, so no pattern spells them out again. */
const SCOPES = MACRO_SCOPES.join('|')

/** What the macros are allowed to read. */
export interface MacroSources {
  /**
   * One tree per scope. A scope with no tree reads as an empty one.
   *
   * Passed in rather than fetched, because which message the `message` scope
   * refers to is the caller's decision — upstream resolves it to the newest
   * message whose selected swipe carries variables, and only the host knows
   * that.
   */
  variables: Partial<Record<MacroScope, unknown>>
  /**
   * Renders a value as a YAML block, for `format_`.
   *
   * Injected because this package declares no YAML library and adding one needs
   * an install. `@iris/mvu` exports `formatYamlBlock`, which is the intended
   * argument; when this package can declare `js-yaml` directly the parameter
   * should go away.
   */
  formatBlock: (value: unknown) => string
  /**
   * Called when a macro names a scope this host has no store for.
   *
   * Without it the gap is invisible in the worst way: an unimplemented scope
   * reads as `null`, which is exactly what an implemented-but-empty scope reads
   * as, so a card author debugging a blank status panel is told their variable
   * is unset when the truth is that Iris never built the shelf. Reporting turns
   * "empty" back into "not built".
   *
   * Measured before it was wired: across the 19 cards on this machine, all 42
   * variable-macro uses name the `message` scope and none names `character` or
   * `preset`. So this costs nothing today — it exists so that the day it does
   * cost something, the cost is named instead of guessed at.
   */
  onUnsupportedScope?: (scope: MacroScope) => void
}

/** The five entities `_.unescape` reverses, which upstream applies to the path. */
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/**
 * Reverse the HTML entities a path may have picked up.
 *
 * Upstream calls `_.unescape(path)` before the lookup. It matters because these
 * macros are written into card fields and world-book entries, which pass through
 * HTML at several points; a variable named `A&B` arrives as `A&amp;B`.
 * @param text - the path as written in the macro.
 * @returns the path as the tree spells it.
 */
export function unescapePath(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity] ?? entity)
}

/**
 * Read a lodash-style path out of a tree.
 *
 * Dot segments and bracket indices, which is what the corpus writes —
 * `stat_data.络络.熟络度[0]` appears in the changelog's own status-bar example.
 * @param tree - the value to read from.
 * @param path - the path, already unescaped.
 * @returns the value, or `null` when the path is not there — upstream's default,
 *   not `undefined`.
 */
export function readMacroPath(tree: unknown, path: string): unknown {
  if (path === '') return tree ?? null
  let node: unknown = tree
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (segment === '') continue
    if (node === null || node === undefined) return null
    if (Array.isArray(node)) {
      const index = Number(segment)
      node = Number.isInteger(index) ? node[index] : undefined
      continue
    }
    if (typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[segment]
  }
  return node ?? null
}

/**
 * Drop every `$`-prefixed key, at every depth.
 * @param value - the value read from the tree.
 * @returns a copy without the framework's own bookkeeping.
 */
export function omitDollarKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => omitDollarKeys(item))
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('$')) continue
    result[key] = omitDollarKeys(member)
  }
  return result
}

/** `{{get_<scope>_variable::path}}` — one line. */
const GET = new RegExp(`\{\{get_(${SCOPES})_variable::(.*?)\}\}`, 'gi')
/** `{{format_<scope>_variable::path}}`, with everything before it on its line. */
const FORMAT = new RegExp(`^(.*?)\{\{format_(${SCOPES})_variable::(.*?)\}\}`, 'gim')

/**
 * Expand Tavern Helper's variable macros.
 *
 * `get_` first, then `format_`, which is upstream's registration order and
 * matters when both appear on one line: `format_` measures its indentation from
 * the text already in front of it, so a `get_` still unexpanded would be counted
 * at its macro length instead of its value's.
 * @param text - the text to expand, after the ordinary ST macros have run.
 * @param sources - the trees and the block formatter.
 * @returns the text with both macro families substituted.
 */
export function expandHelperMacros(text: string, sources: MacroSources): string {
  const read = (scope: MacroScope, path: string): unknown => {
    // `undefined` here means no store, which is not the same as a store holding
    // nothing — and the two are indistinguishable once both have become `null`.
    if (sources.variables[scope] === undefined) sources.onUnsupportedScope?.(scope)
    return omitDollarKeys(readMacroPath(sources.variables[scope], unescapePath(path)))
  }

  const withGet = text.replace(GET, (_match, scope: string, path: string) => {
    const value = read(scope as MacroScope, path)
    // A string goes in raw; everything else is compact JSON, which is what
    // `get_` means as against `format_`.
    return typeof value === 'string' ? value : JSON.stringify(value)
  })

  return withGet.replace(FORMAT, (_match, prefix: string, scope: string, path: string) => {
    const block = sources.formatBlock(read(scope as MacroScope, path))
    // Every newline is padded to sit under the macro's own column. Upstream
    // uses the prefix's length, so a block after `状态: ` lines up under it and
    // the YAML keeps meaning what it says.
    return prefix + block.replaceAll('\n', `\n${' '.repeat(prefix.length)}`)
  })
}

/**
 * Whether any of these macros are still present.
 *
 * For a caller that wants to notice an unexpanded macro before it reaches the
 * model rather than after — see `hasResidualMacros` in the host.
 * @param text - the text to check.
 * @returns whether a Tavern Helper variable macro remains.
 */
export function hasHelperMacros(text: string): boolean {
  return new RegExp(`\{\{(?:get|format)_(?:${SCOPES})_variable::`, 'i').test(text)
}

/**
 * Whether a bare macro name is one of these.
 *
 * For the host's residual-macro report, which has to say whether an unexpanded
 * macro is a gap here or the card's own. It lives beside the scope list rather
 * than being spelled out at the call site, because the call site is the one that
 * decides **blame** — a stale copy there would report a macro Iris owns as
 * something the card invented.
 * @param name - the macro head, without braces or arguments.
 * @returns whether it names one of these macros.
 */
export function isHelperMacroName(name: string): boolean {
  return new RegExp(`^(?:get|format)_(?:${SCOPES})_variable$`, 'i').test(name)
}
