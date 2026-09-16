/**
 * The Iris macro engine.
 *
 * @module @iris/macro
 */

import { expandMacros, type ExpandOptions } from './expand.ts'
import type { MacroContext } from './registry.ts'

/**
 * What one expansion did, for a report that must not change the bytes.
 *
 * `charsBefore`/`charsAfter` are **UTF-16 code units**, the same length unit
 * `String.length` and every other character count in this repository uses, so a
 * reader comparing them with a `length` they measured agrees. They are not the
 * report's content: an expansion report carries heads and sizes, never the text
 * — see the M1 manual's third iron rule.
 */
export interface MacroTrace {
  /** The macro text that went in. */
  readonly text: string
  /**
   * Head → how many times it resolved, folded to lower case.
   *
   * A count per head rather than a list, because a variable-driven preset
   * resolves `setvar` sixty-one times in one prompt and a reader wants the
   * number, not the sixty-one occurrences. Insertion order is first-seen order,
   * so the map is deterministic and a report built from it does not jitter.
   */
  readonly heads: Record<string, number>
  readonly charsBefore: number
  readonly charsAfter: number
}

/**
 * Expand macros and say which ones ran.
 *
 * The traced sibling of {@link expandMacros}: same walk, same registry, same
 * nesting rules — the observation rides an option the untraced call does not
 * pass, so the two cannot drift and the untraced path pays nothing. Added beside
 * `expand` rather than widening it, the manual's own shape, so a caller that
 * does not want a report does not get one and no existing signature moves.
 *
 * Heads are counted **after** resolution, so a name nothing implements — left in
 * the text as `{{...}}` — is not in the map. A caller that wants to know about
 * those has `residualMacros`, which is a different question (what reached the
 * model) asked of a different string (the finished prompt).
 * @param text - the text to expand.
 * @param context - what the macros may read; build it with `createMacroContext`.
 * @param options - registry, recursion limit, and value transform. `onMacro` is
 *   owned by this function and cannot be overridden.
 * @returns the expansion report, and the expanded text.
 */
export function expandTraced(
  text: string,
  context: MacroContext,
  options: Omit<ExpandOptions, 'onMacro'> = {},
): { trace: MacroTrace, text: string } {
  const heads: Record<string, number> = {}
  const expanded = expandMacros(text, context, {
    ...options,
    // Recorded through the engine's own observation rather than by scanning the
    // result: a scan cannot tell a macro that ran from one whose *value* happens
    // to look like `{{...}}`, and the corpus writes exactly that (a card's
    // `setvar` storing a template another macro later reads).
    onMacro: (head) => { heads[head] = (heads[head] ?? 0) + 1 },
  })
  return {
    trace: { text, heads, charsBefore: text.length, charsAfter: expanded.length },
    text: expanded,
  }
}

export {
  createMacroContext,
  createMemoryVariableStore,
  MacroRegistrationError,
  MacroRegistry,
  seededRandom,
  stringHash,
  systemClock,
  systemRandom,
  type MacroCharacter,
  type MacroClock,
  type MacroContext,
  type MacroContextInput,
  type MacroInvocation,
  type MacroLike,
  type MacroLikeContext,
  type MacroLikeReplace,
  type MacroMessage,
  type MacroRandom,
  type MacroResolver,
  type MacroRole,
  type MacroVariableStore,
  type MemoryVariableStore,
  type TokenBudget,
  type VariableScope,
} from './registry.ts'

export {
  createMacroRegistry,
  defaultRegistry,
  registerBuiltins,
} from './builtins.ts'

export {
  expandMacros,
  toRegexSubstitute,
  type ExpandOptions,
} from './expand.ts'

export {
  formatDate,
  humanizeDuration,
} from './format.ts'
