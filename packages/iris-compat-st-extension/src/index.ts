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

// The pilot's runtime half. The analysis fences above still hold: everything
// in `host/` is pure logic (no I/O, no app-service imports); the browser-side
// kernel and facades live in `apps/iris-web/src/st-extensions/**` and are
// loaded only inside the extension frame.
export { StCompatBridge, type ArmedPlane, type BeginTicket } from './host/bridge.ts'
export { buildStExtensionDefinition, ST_EXTENSION_CAPABILITY, type StExtensionDefinition } from './host/definition.ts'
export {
  applyGenerateResultToContributions,
  bridgeMessagesFromContributions,
  contributionsHaveTemplates,
} from './host/expansion.ts'
export { buildMemberBundle, ST_COMPAT_MEMBER_METHODS } from './host/member-bundle.ts'
export { StExtensionSettingsStore } from './host/settings-store.ts'
export {
  defaultSettingsBlob,
  EJS_TEMPLATE_DEFAULTS,
  hydrateSettingsBlob,
  settingsKeyFor,
  ST_COMPAT_SETTINGS_KEY_PREFIX,
  type StCompatSettingsBlob,
} from './host/settings.ts'
export type { StBridgeContext, StBridgeResult, StBridgePayload } from './runtime/protocol.ts'
export {
  isStFrameToShell,
  validateGenerateResult,
  validateReplyResult,
} from './runtime/protocol.ts'
