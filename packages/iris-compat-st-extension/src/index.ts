/**
 * `@iris/compat-st-extension` — the analysis half of ST-extension
 * compatibility: manifest normalization, the registered host-module table,
 * and the module-graph analyzer that produces `CompatibilityReport`s.
 *
 * Scope fences (runbook §3): this package never depends on an app-service
 * implementation, never starts an extension, and never touches the network.
 * The installer (`iris-extension-installer`, a sibling slice) owns download,
 * unpack, hash-and-lock transactions; the two meet in the lock file, where
 * the artifact hash and this report's content digest are cross-checked.
 */

export { analyzeStExtension, type AnalysisOutcome, type AnalyzeOptions } from './analyze.ts'
export {
  ST_HOST_MODULE_PATHS,
  stHostRegistry,
  uniqueSuffixMatch,
  type HostRegistry,
} from './host-modules.ts'
export {
  normalizeManifest,
  type ManifestIssue,
  type NormalizedManifest,
} from './manifest.ts'
export type {
  CompatVerdict,
  CompatibilityFinding,
  CompatibilityReport,
  FindingCategory,
  FindingResult,
  SourceKind,
} from './report.ts'
