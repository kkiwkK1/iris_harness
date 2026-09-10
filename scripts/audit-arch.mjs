#!/usr/bin/env node
/**
 * The architecture audit, as a reading rather than a memory.
 *
 *   node scripts/audit-arch.mjs
 *   node scripts/audit-arch.mjs --json
 *
 * Companion to `apps/iris/tests/architecture.test.ts`, which enforces the rules;
 * this reports the **numbers** the audit conversation needs and does not fail a
 * build: the layer table against the computed layers, manifest-versus-source
 * import drift, the handler census behind the monolith question (service.ts
 * size, handlers() span, per-domain counts, protocol methods that no plugin
 * registers and registrations that name no protocol method), and the Cordis
 * composition's own shape (cordis.yml rows against the tree doc's claim).
 *
 * Exit code is 0 unless something structural is *wrong* (a cycle, an upward
 * dependency, an unregistered protocol method) — drift numbers print, wrongness
 * fails.
 *
 * @module scripts/audit-arch
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const json = process.argv.includes('--json')
const findings = []
const note = (severity, area, message) => findings.push({ severity, area, message })

// --- the package graph, from manifests --------------------------------------

/** name → { dir, deps: @iris/* names } for packages/* and apps/iris. */
async function manifestGraph() {
  const graph = new Map()
  for (const group of ['packages', 'apps']) {
    const dir = join(ROOT, group)
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      // apps/iris-web is npm-managed outside the workspace on purpose
      // (pnpm-workspace.yaml says why); it is reported separately below.
      if (join(group, entry.name) === join('apps', 'iris-web')) continue
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(dir, entry.name, 'package.json'), 'utf8'))
      } catch { continue }
      const name = manifest.name ?? `${group}/${entry.name}`
      const deps = Object.keys(manifest.dependencies ?? {})
      graph.set(name, {
        dir: join(dir, entry.name),
        deps: deps.filter(d => d.startsWith('@iris/')),
        all: deps,
      })
    }
  }
  return graph
}

/** Longest-path layers. L0 = depends on no @iris package. */
function computeLayers(graph) {
  const depth = new Map()
  const visiting = new Set()
  const depthOf = name => {
    if (depth.has(name)) return depth.get(name)
    if (visiting.has(name)) throw new Error(`cycle through ${name}`)
    visiting.add(name)
    const { deps } = graph.get(name)
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depthOf))
    visiting.delete(name)
    depth.set(name, d)
    return d
  }
  for (const name of graph.keys()) depthOf(name)
  return depth
}

function detectCycles(graph) {
  const state = new Map()
  const cycles = []
  const visit = (node, trail) => {
    if (state.get(node) === 'done') return
    if (state.get(node) === 'visiting') {
      cycles.push([...trail.slice(trail.indexOf(node)), node].join(' -> '))
      return
    }
    state.set(node, 'visiting')
    for (const dep of graph.get(node)?.deps ?? []) {
      if (graph.has(dep)) visit(dep, [...trail, node])
    }
    state.set(node, 'done')
  }
  for (const node of graph.keys()) visit(node, [])
  return cycles
}

// --- source imports ----------------------------------------------------------

const IRIS_IMPORT = /(?:from|import)\s*['"](@iris\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g
const RELATIVE_IMPORT = /(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g

async function* walkSources(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      yield* walkSources(path)
      continue
    }
    if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue
    yield path
  }
}

/**
 * Per package: every @iris/* name its sources import, plus any relative
 * specifier whose resolution escapes the package root (a boundary crossed by
 * path rather than by name — invisible to every manifest-based check).
 */
async function scanPackageSources(dir) {
  const imported = new Set()
  const escapes = []
  for await (const path of walkSources(dir)) {
    const source = await readFile(path, 'utf8')
    for (const m of source.matchAll(IRIS_IMPORT)) imported.add(m[1])
    for (const m of source.matchAll(RELATIVE_IMPORT)) {
      const target = resolve(dirname(path), m[1])
      if (!target.startsWith(dir + sep) && !target.startsWith(dir)) {
        escapes.push(`${relative(ROOT, path)} -> ${m[1]}`)
      }
    }
  }
  return { imported, escapes }
}

/** The apps/iris-web source's @iris imports, through its Vite aliases. */
async function scanWebImports() {
  const dir = join(ROOT, 'apps', 'iris-web', 'src')
  const imported = new Set()
  for await (const path of walkSources(dir)) {
    const source = await readFile(path, 'utf8')
    for (const m of source.matchAll(IRIS_IMPORT)) imported.add(m[1])
  }
  return imported
}

// --- the ARCHITECTURE.md layer table -----------------------------------------

async function documentedLayers() {
  const md = await readFile(join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8')
  const block = md.match(/```\n(L0[\s\S]*?)```/)
  if (!block) return null
  const layers = new Map()
  let current = null
  for (const line of block[1].split('\n')) {
    const m = line.match(/^(L\d)\s+(.*)$/)
    if (m) {
      current = m[1]
      // A leading-arrow annotation ("← no @iris deps") is not a package name.
      var names = m[2].split('←')[0]
    } else if (current !== null && /^\s+\S/.test(line)) {
      names = line.split('←')[0]
    } else {
      continue
    }
    for (const name of names.split(/\s{2,}/).map(s => s.trim()).filter(Boolean)) {
      layers.set(name, current)
    }
  }
  return { layers, claimedTotal: Number(md.match(/(\d+) packages in five layers/)?.[1] ?? NaN) }
}

// --- the handler census -------------------------------------------------------

async function handlerCensus() {
  const indexSrc = await readFile(join(ROOT, 'packages', 'iris-app-service', 'src', 'index.ts'), 'utf8')
  const registered = [...indexSrc.matchAll(/irisRpc\.register\('([^']+)'/g)].map(m => m[1])

  const servicePath = join(ROOT, 'packages', 'iris-app-service', 'src', 'service.ts')
  const serviceSrc = await readFile(servicePath, 'utf8')
  const serviceLines = serviceSrc.split('\n').length
  const handlersAt = serviceSrc.split('\n').findIndex(l => l.startsWith('  handlers(): Handlers {')) + 1
  // The next `  #method` or `  word(` at class-member level after handlers().
  const after = serviceSrc.split('\n').slice(handlersAt)
  let handlersSpan = 0
  for (let i = 1; i < after.length; i++) {
    if (/^  (?:async )?#?[A-Za-z#][A-Za-z0-9_]*\(/.test(after[i])) { handlersSpan = i; break }
  }

  const byDomain = new Map()
  for (const method of registered) {
    const domain = method.includes('.') ? method.slice(0, method.indexOf('.')) : method
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1)
  }

  // The protocol's declared request methods, from requestSchemas's keys.
  const rpcSrc = await readFile(join(ROOT, 'packages', 'iris-protocol', 'src', 'rpc.ts'), 'utf8')
  const schemaStart = rpcSrc.indexOf('const requestSchemas')
  const schemaBlock = rpcSrc.slice(schemaStart, rpcSrc.indexOf('\n}', schemaStart))
  const declared = [...schemaBlock.matchAll(/^\s{2}'?([A-Za-z0-9.]+)'?\s*:/gm)].map(m => m[1])

  const unregistered = declared.filter(m => !registered.includes(m))
  const undeclared = registered.filter(m => !declared.includes(m))

  return { registered, declared, unregistered, undeclared, byDomain, serviceLines, handlersAt, handlersSpan }
}

// --- the composition ----------------------------------------------------------

async function compositionCensus() {
  const yml = await readFile(join(ROOT, 'apps', 'iris', 'cordis.yml'), 'utf8')
  const rows = [...yml.matchAll(/^- id: (\S+)/gm)].map(m => m[1])
  const treeMd = await readFile(join(ROOT, 'notes', 'CORDIS-TREE.md'), 'utf8')
  const claimed = Number(treeMd.match(/要装 (\d+) 个插件/)?.[1] ?? NaN)
  const handlersClaim = treeMd.match(/菜单已约 (\d+) 个方法/)?.[1]
  const linesClaim = treeMd.match(/service\.ts 约 (\d+) 行/)?.[1]
  return { rows, claimed, handlersClaim, linesClaim }
}

// --- tool sprawl ----------------------------------------------------------------

async function toolCensus() {
  const linesOf = async dir => {
    let files = 0, lines = 0
    for await (const path of walkSourcesLoose(dir)) {
      const src = await readFile(path, 'utf8')
      files += 1
      lines += src.split('\n').length
    }
    return { files, lines }
  }
  async function* walkSourcesLoose(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { yield* walkSourcesLoose(path); continue }
      if (!/\.(mjs|ts|tsx|ps1)$/.test(entry.name)) continue
      yield path
    }
  }
  const scripts = await linesOf(join(ROOT, 'scripts'))
  const qa = await linesOf(join(ROOT, 'qa'))
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  return { scripts, qa, rootScriptCount: Object.keys(pkg.scripts).length }
}

// --- run ------------------------------------------------------------------------

const graph = await manifestGraph()
const cycles = detectCycles(graph)
const layers = computeLayers(graph)
const doc = await documentedLayers()
const census = await handlerCensus()
const composition = await compositionCensus()
const tools = await toolCensus()

// manifest vs source drift
const drift = []
for (const [name, info] of graph) {
  const { imported, escapes } = await scanPackageSources(info.dir)
  const own = name === '@iris/app' ? '@iris/app-service' : name
  for (const dep of imported) {
    if (dep === own) continue
    if (!info.deps.includes(dep)) drift.push(`${name} imports ${dep} but its manifest does not declare it`)
  }
  for (const esc of escapes) drift.push(`${name} crosses a package boundary by path: ${esc}`)
}
const webImported = await scanWebImports()
const webAllowed = new Set(['@iris/protocol', '@iris/client-fake', '@iris/rpc-client', '@iris/compat-tavernhelper-core'])
const webForbidden = [...webImported].filter(n => !webAllowed.has(n))

// upward dependencies
const upward = new Set(['@iris/app-service', '@iris/rpc-host'])
const upwardViolations = []
for (const [name, info] of graph) {
  if (name === '@iris/app' || name === '@iris/app-service') continue
  for (const dep of info.deps) if (upward.has(dep)) upwardViolations.push(`${name} -> ${dep}`)
}

// layer table drift
const layerDrift = []
if (doc) {
  const displayName = name => name.replace('@iris/', '').replace('@deepseek-ai/dsh-', '')
  for (const [name, info] of graph) {
    const actual = `L${layers.get(name)}`
    const shown = doc.layers.get(displayName(name))
    if (shown === undefined) layerDrift.push(`${name} (${actual}) is absent from docs/ARCHITECTURE.md's table`)
    else if (shown !== actual && name !== '@iris/app') layerDrift.push(`${name}: doc says ${shown}, computed ${actual}`)
  }
  if (doc.claimedTotal !== graph.size) {
    layerDrift.push(`docs/ARCHITECTURE.md claims ${doc.claimedTotal} packages; ${graph.size} exist (apps/iris-web excluded)`)
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  packages: Object.fromEntries([...graph.keys()].map(name => [
    name, { layer: `L${layers.get(name)}`, deps: graph.get(name).deps },
  ])),
  cycles, upwardViolations, drift, webForbidden, layerDrift,
  docTable: doc ? Object.fromEntries(doc.layers) : null,
  docClaimedTotal: doc?.claimedTotal ?? null,
  handlerCensus: {
    serviceTsLines: census.serviceLines,
    handlersMethodStartsAtLine: census.handlersAt,
    handlersMethodSpansLines: census.handlersSpan,
    registeredCount: census.registered.length,
    declaredProtocolMethods: census.declared.length,
    byDomain: Object.fromEntries([...census.byDomain.entries()].sort((a, b) => b[1] - a[1])),
    unregistered: census.unregistered,
    undeclared: census.undeclared,
  },
  composition: {
    cordisRows: composition.rows,
    treeDocClaims: {
      pluginCount: composition.claimed,
      handlersApprox: composition.handlersClaim,
      serviceLinesApprox: composition.linesClaim,
    },
  },
  tools: { scripts: tools.scripts, qa: tools.qa, rootScripts: tools.rootScriptCount },
}

// wrongness exits non-zero; drift only reports.
let failed = false
if (cycles.length > 0) { note('error', 'cycles', cycles.join('; ')); failed = true }
if (upwardViolations.length > 0) { note('error', 'upward', upwardViolations.join('; ')); failed = true }
if (census.unregistered.length > 0) { note('error', 'protocol', `declared but never registered: ${census.unregistered.join(', ')}`); failed = true }
if (census.undeclared.length > 0) { note('error', 'protocol', `registered but not declared: ${census.undeclared.join(', ')}`); failed = true }
if (webForbidden.length > 0) { note('error', 'browser-boundary', webForbidden.join(', ')); failed = true }
for (const d of drift) note('warn', 'manifest-drift', d)
for (const d of layerDrift) note('warn', 'doc-drift', d)
report.findings = findings

if (json) {
  await writeFile(join(ROOT, 'notes', 'audit-arch-last-run.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} else {
  const line = '─'.repeat(72)
  console.log(line)
  console.log('LAYERS (computed vs docs/ARCHITECTURE.md)')
  console.log(line)
  const byLayer = new Map()
  for (const [name, info] of graph) {
    const l = `L${layers.get(name)}`
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l).push(`${displayName(name)}${doc?.layers.get(displayName(name)) === undefined ? ' ⚠ not in doc' : ''}`)
  }
  for (const [l, names] of [...byLayer].sort()) console.log(`${l}  ${names.join('  ')}`)
  if (doc?.claimedTotal !== undefined) console.log(`doc claims ${doc.claimedTotal} packages; ${graph.size} exist`)
  console.log()
  console.log(line)
  console.log('HANDLER CENSUS (packages/iris-app-service)')
  console.log(line)
  console.log(`service.ts: ${census.serviceLines} lines; handlers() starts at :${census.handlersAt} and spans ~${census.handlersSpan} lines`)
  console.log(`registered handlers: ${census.registered.length}; protocol declares: ${census.declared.length}`)
  for (const [domain, count] of [...census.byDomain].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${domain.padEnd(14)} ${count}`)
  }
  if (census.unregistered.length) console.log(`  declared but never registered: ${census.unregistered.join(', ')}`)
  if (census.undeclared.length) console.log(`  registered but not declared: ${census.undeclared.join(', ')}`)
  console.log()
  console.log(line)
  console.log('COMPOSITION (apps/iris/cordis.yml vs notes/CORDIS-TREE.md)')
  console.log(line)
  console.log(`rows: ${composition.rows.length} — ${composition.rows.join(', ')}`)
  console.log(`tree doc claims: ${composition.claimed} plugins, ~${composition.handlersClaim} handlers, ~${composition.linesClaim}-line service.ts`)
  console.log()
  console.log(line)
  console.log('TOOL SURFACE')
  console.log(line)
  console.log(`scripts/: ${tools.scripts.files} files, ${tools.scripts.lines} lines; qa/: ${tools.qa.files} files, ${tools.qa.lines} lines; root package.json scripts: ${tools.rootScriptCount}`)
  console.log()
  if (drift.length || layerDrift.length || findings.some(f => f.severity === 'error')) {
    console.log(line)
    console.log('FINDINGS')
    console.log(line)
    for (const f of findings) console.log(`[${f.severity}] ${f.area}: ${f.message}`)
  } else {
    console.log('no drift findings')
  }
}

function displayName(name) {
  return name.replace('@iris/', '').replace('@deepseek-ai/dsh-', '')
}

if (failed) process.exitCode = 1
