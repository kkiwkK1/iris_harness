/**
 * MVU compatibility.
 *
 * @module @iris/mvu
 */

export {
  extractCommands,
  findMatchingCloseParen,
  normalizeCommandPaths,
  splitArguments,
  unquotePath,
  type CommandInfo,
  type CommandType,
} from './commands.ts'

export {
  extractGreetingOverride,
  loadInitVars,
  parseInitVarBody,
  type GreetingOverride,
  type InitVarEntry,
  type InitVarResult,
  type InitVarSource,
} from './initvar.ts'

export {
  applyCommands,
  evaluateLiteral,
  type ApplyFailure,
  type ApplyOptions,
  type ApplyResult,
  type MvuData,
} from './apply.ts'
