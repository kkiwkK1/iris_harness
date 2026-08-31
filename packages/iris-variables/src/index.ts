/**
 * The Iris variable system.
 *
 * @module @iris/variables
 */

export {
  deletePath,
  detach,
  insertMissing,
  insertOrAssign,
  type DeleteResult,
} from './semantics.ts'

export {
  VariableScopeError,
  type CharacterScope,
  type ExtensionScope,
  type MessageScope,
  type NormalScope,
  type ScriptScope,
  type VariableOption,
  type Variables,
} from './scope.ts'

export {
  keyedMemoryBackend,
  memoryBackend,
  VariableStore,
  type ScopeBackend,
  type ScopeBackends,
} from './store.ts'

export { resolveTurn, sessionMessageBackend } from './message-scope.ts'
