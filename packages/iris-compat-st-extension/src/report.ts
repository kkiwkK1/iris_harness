/**
 * The compatibility report's shapes — `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md`
 * §4's data contract, implemented as this package's own types.
 *
 * The runbook proposes, the package states: two additive fields exist here
 * that §4 does not name. `contentDigest` stands in for `artifactSha256`
 * because the analyzer hashes the files it actually walked, while the
 * artifact hash belongs to the installer slice that downloads and unpacks
 * (the two must meet in the lock, where they are cross-checked, not here).
 * `files` lists the walked set so a report can be replayed against the same
 * tree. Everything else keeps §4's names, so the lock/report tooling and the
 * runbook can quote each other without a translation table.
 *
 * `verdict` is always `unverified` when the analyzer writes it: static
 * analysis can enumerate certain dependencies and unknown points, never
 * compatibility (`docs/…RUNBOOK.md` §2). A `verified` verdict is set only by
 * the evidence pipeline, on a locked artifact, with named test suites.
 */

/** Where an installed thing came from. One value per pipeline, not per file. */
export type SourceKind = 'iris-native' | 'st-extension' | 'tavern-script'

/** What the compatibility pipeline currently claims about one artifact. */
export type CompatVerdict = 'unverified' | 'verified' | 'needs-adapter' | 'unsupported'

/** The faces compatibility breaks along (§4). */
export type FindingCategory = 'module' | 'member' | 'dom' | 'event' | 'http' | 'dependency' | 'dynamic'

/** What the analyzer could honestly establish about one named thing. */
export type FindingResult = 'mapped' | 'missing' | 'unknown'

/** One fact about one named thing at one place in the artifact. */
export interface CompatibilityFinding {
  category: FindingCategory
  /** Artifact-relative POSIX path. */
  file: string
  /** 1-based line, when the parser located the site. */
  line?: number
  /** The specifier, member, URL or expression in question. */
  name: string
  result: FindingResult
  /** Why this result — written for a person deciding what to do next. */
  reason: string
}

/** The whole analysis answer for one unpacked artifact. */
export interface CompatibilityReport {
  /** Bump when analysis semantics change; reports name their own vintage. */
  analyzerVersion: number
  /** sha256 over the walked file set; the artifact hash is the installer's to add. */
  contentDigest: string
  verdict: CompatVerdict
  findings: CompatibilityFinding[]
  /** manifest fields outside the ST 1.18.0 read list (§4: 未知字段列入报告). */
  manifestUnknownFields: string[]
  /** Artifact-relative POSIX paths the analyzer actually opened. */
  files: string[]
}
