/**
 * SillyTavern-compatible regex scripts.
 *
 * @module @iris/regex
 */

export {
  applyRegexScripts,
  orderScripts,
  runRegexScript,
  type OwnedScript,
  type RunOptions,
} from './engine.ts'

export { escapeForPattern, regexFromString } from './parse.ts'

export {
  PLACEMENT,
  SCRIPT_TYPE,
  SUBSTITUTE,
  TIER_ORDER,
  type MacroSubstitute,
  type Placement,
  type RegexParams,
  type RegexScript,
  type ScriptType,
  type SubstituteMode,
} from './types.ts'
