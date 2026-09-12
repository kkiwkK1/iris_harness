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

/*
 * `formatYamlBlock` used to be exported here. It moved to
 * `@iris/compat-tavernhelper` on 2026-09-12 — `{{format_*_variable::…}}` is a
 * Tavern Helper macro and that package was its only caller, while the export
 * bought a hard `compat-tavernhelper → mvu` edge for one formatter (root
 * `notes/DEVIATIONS.md`, stage 0). `js-yaml` stays a dependency here for
 * `initvar.ts`'s parser.
 */

export {
  extractUpdateCommands,
  scanDialects,
  type DialectScan,
} from './dialects.ts'

export {
  extractJsonPatch,
  pointerToPath,
  scanJsonPatch,
  type JsonPatchScan,
} from './json-patch.ts'

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

export {
  applyTemplate,
  isArraySchema,
  isObjectSchema,
  refuseInsert,
  schemaForPath,
  type SchemaNode,
} from './schema.ts'
