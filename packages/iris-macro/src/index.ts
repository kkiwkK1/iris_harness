/**
 * The Iris macro engine.
 *
 * @module @iris/macro
 */

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
  type VariableScope,
} from './registry.ts'

export {
  createMacroRegistry,
  defaultRegistry,
  registerBuiltins,
} from './builtins.ts'

export {
  expandMacros,
  type ExpandOptions,
} from './expand.ts'

export {
  formatDate,
  humanizeDuration,
} from './format.ts'
