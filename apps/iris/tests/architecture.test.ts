import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The dependency rules from `ARCHITECTURE.md`, enforced.
 *
 * These are the kind of rule that holds only while someone is watching, and
 * "someone" has already been the wrong answer once in this repo. Each one was
 * decided for a reason recorded beside it; a failure here means either the
 * import is wrong or the reason has changed, and the second case belongs in
 * `ARCHITECTURE.md` before it belongs in code.
 *
 * Lives at the composition root because that is the only place entitled to know
 * the whole tree exists.
 */

// `fileURLToPath`, not `.pathname`: this repository's own path contains
// non-ASCII characters, which a URL percent-encodes. Reading `.pathname` here
// yields `%E5%B0%8F...` and every lookup misses.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Every workspace package's `@iris/*` dependencies, from its manifest. */
async function manifestGraph(): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>()
  for (const group of ['packages', 'apps']) {
    const dir = join(ROOT, group)
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let manifest: { name?: string, dependencies?: Record<string, string>, devDependencies?: Record<string, string> }
      try {
        manifest = JSON.parse(await readFile(join(dir, entry.name, 'package.json'), 'utf8')) as typeof manifest
      } catch { continue }
      const name = manifest.name ?? `${group}/${entry.name}`
      const deps = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
      graph.set(name, deps.filter(dep => dep.startsWith('@iris/')))
    }
  }
  return graph
}

/** Every `@iris/*` package a directory's sources import, read from the source. */
async function sourceImports(dir: string): Promise<Set<string>> {
  const found = new Set<string>()
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        await walk(path)
        continue
      }
      if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue
      const source = await readFile(path, 'utf8')
      for (const match of source.matchAll(/from\s+'(@iris\/[a-z0-9-]+)'/g)) found.add(match[1] as string)
    }
  }
  await walk(dir)
  return found
}

test('the package graph has no cycles', async () => {
  // A cycle means two packages are really one, and the boundary between them is
  // decoration. It also breaks the reversibility Cordis is here to provide:
  // there is no order in which a cycle can be unloaded.
  const graph = await manifestGraph()
  const state = new Map<string, 'visiting' | 'done'>()
  const cycles: string[] = []

  const visit = (node: string, trail: string[]): void => {
    if (state.get(node) === 'done') return
    if (state.get(node) === 'visiting') {
      cycles.push([...trail.slice(trail.indexOf(node)), node].join(' → '))
      return
    }
    state.set(node, 'visiting')
    for (const dep of graph.get(node) ?? []) {
      if (graph.has(dep)) visit(dep, [...trail, node])
    }
    state.set(node, 'done')
  }

  for (const node of graph.keys()) visit(node, [])
  assert.deepEqual(cycles, [])
})

test('the contract package depends on nothing of ours', async () => {
  // If the contract depended on a domain package, changing how something is
  // stored would change what goes on the wire.
  const graph = await manifestGraph()

  assert.deepEqual(graph.get('@iris/protocol'), [])
})

test('the browser sees the contract and nothing else', async () => {
  // The rule most worth enforcing and least visible: `apps/iris-web` reaches
  // workspace code through Vite aliases, not its manifest, so every dependency
  // graph shows it as a leaf. The untrusted side is the one no tool watches by
  // default, so this reads its imports instead.
  //
  // A browser that could reach `@iris/persistence` could build a chat file, and
  // a chat file it built would bypass every check the host makes on the way in.
  // `rpc-client` was missing from the first version of this list — an omission,
  // not a decision: it is the browser's real transport, implements `IrisClient`,
  // and itself depends only on the contract. The list happened to be written
  // while the interface still ran on the fake alone, which is exactly how an
  // allowlist goes stale: it encodes the day it was written.
  const allowed = new Set(['@iris/protocol', '@iris/client-fake', '@iris/rpc-client'])
  const imported = await sourceImports(join(ROOT, 'apps', 'iris-web'))
  const forbidden = [...imported].filter(name => !allowed.has(name)).sort()

  assert.deepEqual(forbidden, [], `the browser may only import ${[...allowed].join(', ')}`)
})

test('nothing depends upward on the host or the composition root', async () => {
  // Dependencies point toward the leaves. The composition root is the only place
  // entitled to know the whole tree exists.
  const upward = new Set(['@iris/app-service', '@iris/rpc-host'])
  const graph = await manifestGraph()
  const violations: string[] = []

  for (const [name, deps] of graph) {
    if (name === '@iris/app' || name === '@iris/app-service') continue
    for (const dep of deps) {
      if (upward.has(dep)) violations.push(`${name} → ${dep}`)
    }
  }

  assert.deepEqual(violations, [])
})

test('the host never depends on the fake client', async () => {
  // The fake exists so the interface can be built without a host. If the host
  // reached for it, its conventions would become load-bearing — which has
  // already happened once, through the browser, and cost a live bug.
  const graph = await manifestGraph()
  const hostSide = ['@iris/app', '@iris/app-service', '@iris/rpc-host', '@iris/persistence']
  const violations = hostSide.filter(name => (graph.get(name) ?? []).includes('@iris/client-fake'))

  assert.deepEqual(violations, [])
})
