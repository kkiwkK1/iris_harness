/**
 * The module-graph analyzer — §6 of
 * `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md`, first slice: static imports,
 * export-from, literal dynamic imports, css `url()`/`@import`, `import.meta`,
 * string-literal `new Worker`.
 *
 * Parsing is the TypeScript compiler API (`ts.createSourceFile` + AST walk),
 * not a regex: string-literal module specifiers are read from the syntax
 * tree, so a specifier inside a string, a comment or a parser scaffold is
 * never a finding. TypeScript is already the repository's root devDependency
 * — the analyzer adds no dependency and no network surface, which is the
 * whole point of running analysis before anything is executed.
 *
 * Resolution is honest by construction. A specifier resolves against the
 * file's **virtual** ST-public-relative path (where the artifact will sit
 * under `public/scripts/extensions/<id>/`). Exact hits on the registered
 * host table are `mapped`. Misses with exactly one registered tail-match are
 * `unknown` with the candidate named — bundles bake externals' original
 * depths, so a near miss is not evidence of absence. Bare specifiers are
 * `unknown` (§6: unknown bare specifier marked as unknown) because whether
 * they resolve is an import-map decision the compat plan has not made.
 * Everything the analyzer cannot establish is `unknown`; `missing` is
 * reserved for what it affirmatively could not find.
 *
 * The analyzer reads one directory tree and writes one in-memory report. It
 * executes no artifact code, fetches nothing, and follows no symlink — the
 * boundary §5 demands of the pipeline's read-only half.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import ts from 'typescript'

import { normalizeManifest } from './manifest.ts'
import { stHostRegistry, uniqueSuffixMatch, type HostRegistry } from './host-modules.ts'
import type { CompatibilityFinding, CompatibilityReport } from './report.ts'

/** Where the artifact sits on disk and where it will sit in the ST layout. */
export interface AnalyzeOptions {
  /** Local directory of the unpacked artifact. */
  root: string
  /** ST-`public/`-relative POSIX directory the artifact will be served from. */
  virtualRoot: string
  /** Host table; defaults to the seed registry. */
  registry?: HostRegistry
}

/** The analyzer answers, or refuses with one readable reason. */
export type AnalysisOutcome =
  | { ok: true, report: CompatibilityReport }
  | { ok: false, error: string }

/** Normalize `dir` + `spec` POSIX-style; `undefined` when it escapes the root. */
function resolveRelative(dir: string, spec: string): string | undefined {
  const stack: string[] = []
  for (const segment of (dir === '' ? [] : dir.split('/'))) stack.push(segment)
  for (const segment of spec.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.pop() === undefined) return undefined
      continue
    }
    stack.push(segment)
  }
  return stack.join('/')
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function hasScheme(spec: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)
}

/**
 * Analyze one unpacked ST extension artifact.
 * @param options - tree location, virtual location, optional narrowed registry.
 * @returns the compatibility report, or the reason the tree is unreadable.
 */
export async function analyzeStExtension(options: AnalyzeOptions): Promise<AnalysisOutcome> {
  const registry = options.registry ?? stHostRegistry()
  const virtualRoot = options.virtualRoot.replace(/^\/+|\/+$/g, '')
  const findings: CompatibilityFinding[] = []

  let manifestRaw: string
  try {
    manifestRaw = await readFile(join(options.root, 'manifest.json'), 'utf8')
  } catch {
    return { ok: false, error: `manifest.json is not readable under ${options.root}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestRaw)
  } catch {
    return { ok: false, error: 'manifest.json is not valid JSON' }
  }
  const normalized = normalizeManifest(parsed)
  if (!normalized.ok) {
    return { ok: false, error: `manifest refused: ${normalized.issues.map(issue => `${issue.field} ${issue.message}`).join('; ')}` }
  }
  const manifest = normalized.manifest

  const files: string[] = ['manifest.json']
  const digests: string[] = [`manifest.json:${createHash('sha256').update(manifestRaw).digest('hex')}`]

  /** Record one specifier resolution per the module docblock's honesty rules. */
  function recordSpecifier(spec: string, file: string, line: number | undefined, category: CompatibilityFinding['category']): void {
    const at = { file, ...(line !== undefined ? { line } : {}) }
    if (hasScheme(spec)) {
      findings.push({ category: 'http', ...at, name: spec, result: 'missing', reason: 'remote module import; the first-version compat environment loads no remote modules' })
      return
    }
    if (spec.startsWith('/')) {
      const target = spec.slice(1)
      if (registry.paths.has(target)) {
        findings.push({ category, ...at, name: spec, result: 'mapped', reason: `resolves to registered host module ${target}` })
      } else {
        const candidate = uniqueSuffixMatch(target, registry)
        findings.push({ category, ...at, name: spec, result: candidate === undefined ? 'missing' : 'unknown',
          reason: candidate === undefined ? `resolves to ${target}, which is not a registered host path` : `resolves to ${target}; tail may match registered host module ${candidate} (bundled depth unverifiable)` })
      }
      return
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      // Resolution happens in the ST-public-relative virtual space — where
      // the artifact will actually sit — so the public root is the upper
      // bound and the artifact root is a prefix, not the other way round.
      const virtualFile = `${virtualRoot}/${file}`
      const dir = virtualFile.slice(0, virtualFile.lastIndexOf('/'))
      const target = resolveRelative(dir, spec)
      if (target !== undefined && isUnder(target, virtualRoot)) {
        queueOwn(target.slice(virtualRoot.length + 1))
        return // own-file edges enter the graph; absent targets are flagged by the walk
      }
      if (target === undefined) {
        findings.push({ category, ...at, name: spec, result: 'missing', reason: 'resolves above the ST public root' })
        return
      }
      if (registry.paths.has(target)) {
        findings.push({ category, ...at, name: spec, result: 'mapped', reason: `resolves to registered host module ${target}` })
        return
      }
      const candidate = uniqueSuffixMatch(target, registry)
      if (candidate !== undefined) {
        findings.push({ category, ...at, name: spec, result: 'unknown', reason: `resolves to ${target}, which is unregistered; the tail may match host module ${candidate} if the bundle baked the specifier's depth` })
        return
      }
      findings.push({ category, ...at, name: spec, result: 'missing', reason: `resolves to ${target}, which is not a registered host path` })
      return
    }
    findings.push({ category, ...at, name: spec, result: 'unknown', reason: 'bare specifier: whether it resolves is an import-map decision the compat plan has not registered' })
  }

  const walked = new Set<string>()
  const pending: string[] = []

  /** Queue an own artifact file; absence is reported when the walk reaches it. */
  function queueOwn(artifactRelative: string): void {
    if (!walked.has(artifactRelative) && !pending.includes(artifactRelative)) pending.push(artifactRelative)
  }

  if (manifest.js !== undefined) queueOwn(manifest.js)

  while (pending.length > 0) {
    const file = pending.pop() as string
    if (walked.has(file)) continue
    walked.add(file)
    let text: string
    try {
      text = await readFile(join(options.root, file), 'utf8')
    } catch {
      findings.push({ category: 'module', file, name: file, result: 'missing', reason: 'imported by the artifact graph but absent from the tree' })
      continue
    }
    files.push(file)
    digests.push(`${file}:${createHash('sha256').update(text).digest('hex')}`)

    const virtualFile = `${virtualRoot}/${file}`
    const source = ts.createSourceFile(virtualFile, text, ts.ScriptTarget.ESNext, true)

    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined
        && ts.isStringLiteral(node.moduleSpecifier)) {
        // One ExportDeclaration node covers both `export {a} from` and
        // `export * from`; the moduleSpecifier is what the analyzer reads.
        const position = source.getLineAndCharacterOfPosition(node.moduleSpecifier.getStart(source))
        recordSpecifier(node.moduleSpecifier.text, file, position.line + 1, 'module')
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        if (argument !== undefined && ts.isStringLiteral(argument)) {
          recordSpecifier(argument.text, file, line, 'dynamic')
        } else {
          findings.push({ category: 'dynamic', file, line, name: 'import(<expression>)', result: 'unknown', reason: 'expression dynamic import: target not statically known, escape loading is not silently allowed' })
        }
      } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta') {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        findings.push({ category: 'dom', file, line, name: 'import.meta', result: 'unknown', reason: 'import.meta semantics in the compat environment are a facade decision, not a given' })
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker'
        && node.arguments !== undefined) {
        const argument = node.arguments[0]
        if (argument !== undefined && ts.isStringLiteral(argument)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          findings.push({ category: 'dom', file, line, name: argument.text, result: 'unknown', reason: 'Worker URL baked against a URL layout; mapping and origin policy are verified separately (§6)' })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  if (manifest.css !== undefined) {
    const file = manifest.css
    files.push(file)
    try {
      const css = await readFile(join(options.root, file), 'utf8')
      digests.push(`${file}:${createHash('sha256').update(css).digest('hex')}`)
      /** 1-based css line of a match — the report is answerable to a person. */
      const lineAt = (index: number): number => css.slice(0, index).split('\n').length
      for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
        const name = match[2]
        if (name === undefined) continue
        findings.push({ category: 'http', file, ...(match.index !== undefined ? { line: lineAt(match.index) } : {}), name, result: 'unknown', reason: 'css resource reference; CORS and path mapping verified separately (§6)' })
      }
      for (const match of css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g)) {
        const name = match[1]
        if (name === undefined) continue
        findings.push({ category: 'http', file, ...(match.index !== undefined ? { line: lineAt(match.index) } : {}), name, result: 'unknown', reason: 'css @import; resolution policy verified separately (§6)' })
      }
    } catch {
      findings.push({ category: 'http', file, name: file, result: 'missing', reason: 'css declared in the manifest but absent from the tree' })
    }
  }

  const report: CompatibilityReport = {
    analyzerVersion: 1,
    contentDigest: createHash('sha256').update([...digests].sort().join('\n')).digest('hex'),
    verdict: 'unverified',
    findings,
    manifestUnknownFields: [...manifest.unknownFields],
    files: [...files].sort(),
  }
  return { ok: true, report }
}
