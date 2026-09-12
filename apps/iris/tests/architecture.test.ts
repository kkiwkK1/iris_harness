import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The dependency rules from `docs/ARCHITECTURE.md`, enforced.
 *
 * These are the kind of rule that holds only while someone is watching, and
 * "someone" has already been the wrong answer once in this repo. Each one was
 * decided for a reason recorded beside it; a failure here means either the
 * import is wrong or the reason has changed, and the second case belongs in
 * `docs/ARCHITECTURE.md` before it belongs in code.
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
      /*
       * The optional trailing group is load-bearing, and its absence was a hole
       * rather than a limitation.
       *
       * The pattern used to require the closing quote immediately after the
       * package name, so `@iris/persistence/src/anything.ts` **did not match at
       * all**. It was not recorded and permitted — it was never seen, and a
       * specifier that is never seen is indistinguishable from one that does not
       * exist. `forbidden` came back empty and `assert.deepEqual(forbidden, [])`
       * passed with total confidence, which is the most dangerous way for a
       * guard to be wrong: the browser could import any workspace package by
       * writing one extra path segment, and every package's `exports` map
       * carries `"./src/*"`, so the specifier really did resolve.
       *
       * The subpath is captured and discarded so the import is attributed to the
       * package that owns it; the allowlist check below is unchanged.
       */
      for (const match of source.matchAll(/from\s+'(@iris\/[a-z0-9-]+)(?:\/[^']*)?'/g)) {
        found.add(match[1] as string)
      }
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
  // `compat-tavernhelper-core` is allowlisted because the frame needs THE SAME
  // event-name tables the host uses — a hand-copied string that drifts produces
  // a listener that never fires, with no error. It qualifies only because it is
  // dependency-free, and its own purity test pins that; the slash grammar was
  // deliberately left out of it so the browser cannot grow a second parser.
  // `text` is allowlisted on exactly the same ground, for two functions the
  // frame must compute the same way the host does: `stringHash`, which names a
  // button's event (`${scriptId}_${hash(name)}`, and a hash differing by one bit
  // is a listener that never fires), and `parseRegexFromString`, which decides
  // key-as-pattern on both sides of the boundary. It too qualifies only because
  // it is dependency-free, with its own purity test. Both functions were inside
  // `compat-tavernhelper-core` until 2026-09-12 and are on this list for the
  // same reason they were then — what changed is which package they live in, not
  // what the browser can reach (root `notes/DEVIATIONS.md`, stage 0).
  const allowed = new Set(['@iris/protocol', '@iris/client-fake', '@iris/rpc-client', '@iris/compat-tavernhelper-core', '@iris/text'])
  const imported = await sourceImports(join(ROOT, 'apps', 'iris-web'))
  const forbidden = [...imported].filter(name => !allowed.has(name)).sort()

  assert.deepEqual(forbidden, [], `the browser may only import ${[...allowed].join(', ')}`)
})

test('the import scanner sees a package reached through a subpath', async () => {
  /*
   * A guard on the guard, because the one above cannot fail for this on its own.
   *
   * The allowlist test asserts that a set is empty. When the scanner stops
   * recognising a specifier, the specifier does not appear in that set — so the
   * assertion passes, and it passes for the same reason it passes when the code
   * is clean. **A miss and an absence are the same observation.** That is how
   * `@iris/persistence/src/anything.ts` sat inside `apps/iris-web` while this
   * suite reported the browser was importing nothing but the contract.
   *
   * So this test does not check the repository. It hands the scanner a source it
   * has written on purpose and asks what the scanner saw, which is the only
   * question whose answer distinguishes the two cases.
   */
  const dir = await mkdtemp(join(tmpdir(), 'iris-arch-'))
  try {
    await writeFile(
      join(dir, 'sample.ts'),
      [
        "import { a } from '@iris/protocol'",
        "import { b } from '@iris/persistence/src/anything.ts'",
        "import type { C } from '@iris/lorebook/src/matching.ts'",
      ].join('\n'),
      'utf8',
    )

    const seen = await sourceImports(dir)

    assert.deepEqual(
      [...seen].sort(),
      ['@iris/lorebook', '@iris/persistence', '@iris/protocol'],
      'a subpath import must be attributed to the package that owns it — otherwise the allowlist never hears about it',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('the shared text package depends on nothing of ours', async () => {
  // Same rule the contract package holds, for the same reason turned around:
  // `@iris/text` is on the browser's allowlist *because* it can drag nothing in
  // behind it, so an `@iris/*` dependency here would widen what the frame can
  // reach without anything in `apps/iris-web` changing. Its own purity test
  // reads the sources and refuses npm dependencies too; this one is the
  // manifest-side half, and it is here rather than there because a package that
  // may import nothing cannot hold a test that walks the workspace.
  const graph = await manifestGraph()

  assert.ok(graph.has('@iris/text'), 'the package must exist for this to be a check')
  assert.deepEqual(graph.get('@iris/text'), [])
})

test('the generic engines do not depend on the Tavern Helper compat layer', async () => {
  /*
   * The two inverted edges stage 0 of `notes/PLUGIN-FEASIBILITY.md` §3 removed,
   * pinned so they cannot come back quietly — and they would come back quietly,
   * because each was cheap and locally sensible when it was written. Until
   * 2026-09-12 `@iris/lorebook` and `@iris/macro` — engines that know nothing
   * about Tavern Helper — declared a dependency on `@iris/compat-tavernhelper-core`
   * to reach `stringHash` and `parseRegexFromString`, and `@iris/compat-tavernhelper`
   * declared one on `@iris/mvu` to reach `formatYamlBlock`. Neither is a cycle,
   * so the cycle test above never saw them; both make a plugin boundary
   * inexpressible, which is a fact about direction rather than about shape.
   *
   * Stated as named pairs rather than as a general rule. A general rule ("no
   * engine may depend on a compat package") would need a list of which packages
   * are engines, and that list is the thing that goes stale; these three names
   * are the decision this change made, and a fourth edge wanting the same
   * treatment is a new decision that belongs in the ledger before it belongs
   * here. Root `notes/DEVIATIONS.md`, stage 0.
   */
  const forbidden: ReadonlyArray<readonly [string, string]> = [
    ['@iris/lorebook', '@iris/compat-tavernhelper-core'],
    ['@iris/macro', '@iris/compat-tavernhelper-core'],
    ['@iris/compat-tavernhelper', '@iris/mvu'],
  ]
  const graph = await manifestGraph()
  const violations: string[] = []

  for (const [from, to] of forbidden) {
    // A package that has vanished cannot violate the rule, and cannot enforce it
    // either: without this the test passes loudest exactly when it is blind.
    assert.ok(graph.has(from), `${from} is missing from the workspace graph`)
    assert.ok(graph.has(to), `${to} is missing from the workspace graph`)
    if ((graph.get(from) ?? []).includes(to)) violations.push(`${from} → ${to}`)
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
