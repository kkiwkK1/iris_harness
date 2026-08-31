/**
 * ST-Prompt-Template compatibility: EJS prompt templates.
 *
 * A different thing from `@iris/macro`'s `{{…}}`. This is the extension the
 * user has installed and enabled, and the corpus uses it heavily: 8 of 19 cards,
 * 3364 template tags, and — measured over the same install — a further 6575 tags
 * in the world books on disk. What the templates contain is arbitrary
 * JavaScript: 1749 `if`, 205 `function`, 139 `try`/`catch`, 118 `for`.
 *
 * So evaluating one is running the card author's code, and the only question
 * worth asking about this package is where that happens. It happens in a child
 * process with no environment, no filesystem writes, no ability to spawn, and a
 * `vm` realm with no `process`, no `require`, and no working dynamic import.
 * Nothing the template can reach is a host object; every write it performs comes
 * back described, for the host to apply through its own entry points.
 *
 * `DEVIATIONS.md` lists where this deliberately differs from upstream, and what
 * each difference was measured to cost.
 *
 * @module @iris/compat-prompt-template
 */

export {
  DEFAULT_DEADLINE_MS,
  childExecArgv,
  evaluateBatch,
  type EvaluatorOptions,
} from './host.ts'

export {
  UnsupportedTemplateApiError,
  buildEnvironment,
  createState,
  findWorldInfoEntry,
  type BatchState,
  type Environment,
  type EnvironmentOptions,
  type VarOptions,
} from './environment.ts'

export {
  DEFERRED_PATCHES,
  UPSTREAM_COMPILE_OPTIONS,
  UpstreamPatchError,
  applySourcePatches,
  hasTemplate,
  identityEscape,
  installNestedDelimiters,
  rethrow,
  stubInclude,
  type IncluderResult,
} from './upstream.ts'

export type {
  BatchOutcome,
  ChildMessage,
  EvalBatch,
  EvalItem,
  ItemResult,
  Json,
  Op,
  Scope,
  Snapshot,
  WorldInfoEntry,
} from './types.ts'
