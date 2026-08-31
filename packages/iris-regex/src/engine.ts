/**
 * Running regex scripts.
 *
 * The feature that makes this worth building is not the substitution — it is
 * *where* the substitution applies. A script marked display-only changes what
 * the reader sees; a script marked prompt-only changes what the model reads;
 * a script marked neither rewrites the stored message for good. That three-way
 * split is what lets an MVU card strip its `<UpdateVariable>` block from both
 * the transcript and the next request while the commands stay on disk, and
 * without it the reader sees raw command blocks and the model reads its own
 * previous ones and corrupts every later turn.
 *
 * @module @iris/regex/engine
 */

import { escapeForPattern, regexFromString } from './parse.ts'
import {
  SCRIPT_TYPE,
  SUBSTITUTE,
  type MacroSubstitute,
  type Placement,
  type RegexParams,
  type RegexScript,
  type ScriptType,
} from './types.ts'

/** Options for one run. */
export interface RunOptions extends RegexParams {
  /** Macro expander. Omitted means patterns and replacements are used verbatim. */
  substitute?: MacroSubstitute
}

/** A script together with who owns it, for ordering. */
export interface OwnedScript {
  script: RegexScript
  type: ScriptType
}

/**
 * Order scripts the way upstream runs them: global, then the character's, then
 * the preset's.
 *
 * Stable within a tier, so a card's own scripts keep the order it listed them
 * in — they are often written to run in sequence.
 * @param owned - scripts with their owners.
 * @returns the scripts in run order.
 */
export function orderScripts(owned: readonly OwnedScript[]): RegexScript[] {
  return owned
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.type - right.type || left.index - right.index)
    .map(entry => entry.script)
}

/**
 * Whether a script's ephemerality matches what this string is for.
 *
 * The third case is the subtle one: a permanent script runs only when the
 * string is neither being rendered nor being sent. Upstream's reasoning, worth
 * keeping in mind, is that the stored text was already rewritten when it was
 * saved — running a permanent script again at render or send time would apply
 * it twice.
 */
function appliesToStage(script: RegexScript, params: RegexParams): boolean {
  const display = script.markdownOnly === true
  const prompt = script.promptOnly === true
  if (display && params.isMarkdown === true) return true
  if (prompt && params.isPrompt === true) return true
  return !display && !prompt && params.isMarkdown !== true && params.isPrompt !== true
}

/** Whether a script's depth window contains this message. */
function appliesAtDepth(script: RegexScript, depth: number | undefined): boolean {
  if (typeof depth !== 'number') return true

  const min = script.minDepth
  // `null` means unset; `-1` is a real bound and must not be treated as absent.
  if (typeof min === 'number' && Number.isFinite(min) && min >= -1 && depth < min) return false

  const max = script.maxDepth
  if (typeof max === 'number' && Number.isFinite(max) && max >= 0 && depth > max) return false

  return true
}

/** The find pattern, with macros handled per the script's mode. */
function findPattern(script: RegexScript, substitute: MacroSubstitute | undefined): string {
  const mode = Number(script.substituteRegex ?? SUBSTITUTE.NONE)
  if (substitute === undefined || mode === SUBSTITUTE.NONE) return script.findRegex
  if (mode === SUBSTITUTE.ESCAPED) return substitute(script.findRegex, { postProcess: escapeForPattern })
  // RAW, and anything unrecognized: upstream falls back to expanding without
  // escaping rather than refusing the script.
  return substitute(script.findRegex)
}

/** Strip the script's trim strings out of one captured value. */
function trim(value: string, script: RegexScript, options: RunOptions): string {
  const strings = script.trimStrings ?? []
  if (strings.length === 0) return value

  let result = value
  for (const raw of strings) {
    const target = options.substitute === undefined
      ? raw
      : options.substitute(raw, options.characterOverride === undefined
        ? {}
        : { characterOverride: options.characterOverride })
    if (target.length > 0) result = result.replaceAll(target, '')
  }
  return result
}

/** Matches `$0`, `$12` or `$<name>` in a replacement string. */
const GROUP_REFERENCE = /\$(\d+)|\$<([^>]+)>/g

/**
 * Run one script against a string.
 *
 * Placement, ephemerality and depth are the caller's business — this applies
 * the script unconditionally, which is what makes it usable for previewing a
 * single script in an editor.
 * @param script - the script to run.
 * @param text - the string to transform.
 * @param options - macro expander and trim-string context.
 * @returns the transformed string, or the input unchanged when the script is
 *   disabled, empty, or its pattern will not compile.
 */
export function runRegexScript(script: RegexScript, text: string, options: RunOptions = {}): string {
  if (script.disabled === true || script.findRegex.length === 0 || text.length === 0) return text

  const pattern = regexFromString(findPattern(script, options.substitute))
  if (pattern === undefined) return text

  return text.replace(pattern, (...args: unknown[]) => {
    const whole = args[0] as string
    // A replace callback ends with (offset, string) and, when the pattern has
    // named groups, a groups object after them.
    const last = args[args.length - 1]
    const groups = typeof last === 'object' && last !== null ? (last as Record<string, string | undefined>) : undefined
    const numbered = args.slice(0, groups === undefined ? -2 : -3) as (string | undefined)[]

    // `{{match}}` is spelled `$0` internally, so both reach the same branch.
    const template = script.replaceString.replace(/\{\{match\}\}/gi, '$0')

    const filled = template.replaceAll(GROUP_REFERENCE, (_reference, index: string | undefined, name: string | undefined) => {
      const captured = index !== undefined
        ? (index === '0' ? whole : numbered[Number(index)])
        : groups?.[name as string]
      // An unmatched or empty group contributes nothing rather than the literal
      // `$1`, which is what a card author expects from an optional group.
      if (captured === undefined || captured === '') return ''
      return trim(captured, script, options)
    })

    return options.substitute === undefined ? filled : options.substitute(filled)
  })
}

/**
 * Run every applicable script, in order.
 * @param text - the string to transform.
 * @param placement - what kind of string this is.
 * @param scripts - candidate scripts, already in run order (see {@link orderScripts}).
 * @param options - stage, depth, and the macro expander.
 * @returns the transformed string.
 */
export function applyRegexScripts(
  text: string,
  placement: Placement,
  scripts: readonly RegexScript[],
  options: RunOptions = {},
): string {
  if (text.length === 0) return text

  let result = text
  for (const script of scripts) {
    if (script.disabled === true) continue
    if (!appliesToStage(script, options)) continue
    if (options.isEdit === true && script.runOnEdit !== true) continue
    if (!appliesAtDepth(script, options.depth)) continue
    if (!(script.placement ?? []).includes(placement)) continue

    result = runRegexScript(script, result, options)
  }
  return result
}

export { SCRIPT_TYPE }
