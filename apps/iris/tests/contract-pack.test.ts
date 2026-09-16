import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

/**
 * The published contract packages work **outside** this workspace.
 *
 * Everything else in this repository is checked from inside the workspace,
 * where `pnpm` has linked `@iris/*` into place, `exports` points at
 * `./src/index.ts`, Node strips types on the fly and tsconfig knows where
 * everything is. A plugin repository has none of that. So every mistake a
 * publishing step can make — an `exports` still pointing at `src`, a
 * `workspace:*` range npm cannot fetch, a `./x.ts` specifier surviving into
 * the emitted JavaScript, a framework shipped as a dependency instead of a
 * peer — is invisible to every other test here and fatal to the first person
 * who runs `npm install @iris/plugin-api`.
 *
 * So this one runs `scripts/pack-contracts.mjs` for real, extracts the three
 * tarballs into a temporary `node_modules` with no workspace above it, and
 * asks two different tools whether the result resolves:
 *
 *  - **`tsc --noEmit`, with no `paths` and no alias**, over a sample plugin
 *    that imports one thing from each package. Type resolution only goes
 *    through the published `exports` map's `types` condition, the way an
 *    author's editor would.
 *  - **`import()` at runtime**, on the emitted `lib/index.js` of the two
 *    packages that have runtime exports. The type check above cannot see a
 *    `.ts` extension left in a JavaScript import specifier; the loader can see
 *    nothing else.
 *
 * `skipLibCheck: true` in the sample's tsconfig is what a real plugin
 * repository would set (it is what this repository's own base config sets),
 * and it is also why the sample carries two `@ts-expect-error` lines. With
 * `skipLibCheck` on, a contract whose types quietly degraded to `any` — an
 * unresolvable declaration, a missing peer — would typecheck *silently*, and
 * a test that only asserts "tsc exits 0" would go green on a package that
 * gives an author no types at all. An `@ts-expect-error` on a line that must
 * be an error inverts that: if the type became `any`, the error disappears,
 * the directive becomes unused, and tsc fails. The assertion is the absence of
 * `any`, and it is stated in the direction that cannot be satisfied by
 * accident.
 *
 * Lives at the composition root for the reason `architecture.test.ts` does: it
 * is about the whole tree, and the publishing step is the tree's only edge
 * that faces outward.
 */

// `fileURLToPath`, not `.pathname`: this repository's own path contains
// non-ASCII characters, which a URL percent-encodes.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The version the rehearsal publishes at. Semver, and obviously not a release. */
const VERSION = '1.0.0-test.0'

/** Staging directory name → the tarball npm writes for that package. */
const PACKAGES = [
  { stage: 'plugin-api', name: '@iris/plugin-api' },
  { stage: 'plugin-web-api', name: '@iris/plugin-web-api' },
  { stage: 'protocol', name: '@iris/protocol' },
] as const

/**
 * The sample plugin: one import from each package, and two lines that must not
 * compile.
 *
 * Deliberately exercises the pieces that break in different ways — a type-only
 * interface from the host half (`SystemPluginDefinition`, which reaches into
 * the Cordis peer for `Context` and `Disposable`), a *runtime* function from
 * the browser half (`parsePluginAssetManifest`, so the emitted JS must resolve
 * too) and a union from the wire contract (`RpcMethod`, which exists only if
 * `@iris/protocol` resolved from inside `@iris/plugin-web-api`'s declarations
 * as well as from here).
 */
const SAMPLE = `import type { SystemPluginDefinition } from '@iris/plugin-api'
import { parsePluginAssetManifest, type SandboxPluginRuntime } from '@iris/plugin-web-api'
import type { RpcMethod } from '@iris/protocol'

export const plugin: SystemPluginDefinition = {
  id: 'example',
  name: 'Example',
  description: 'A plugin typed against the published contract, outside the Iris workspace.',
  version: '0.1.0',
  apiVersion: 1,
  activate(scope) {
    // \`scope.context\` is Cordis's \`Context\`, and the returned disposer is
    // Cordis's \`Disposable\`: both come from the peer dependency.
    void scope.context
    void scope.pluginId
    const method: RpcMethod = 'plugin.list'
    void method
    return () => {}
  },
}

export function manifestRows(body: string): string | Record<string, { rev: string, client?: string, i18n?: Record<'en' | 'zh', string> }> {
  const parsed = parsePluginAssetManifest(body)
  return typeof parsed === 'string' ? parsed : parsed.plugins
}

export function usable(runtime: SandboxPluginRuntime): boolean {
  return runtime.tavernHelper && runtime.revision >= 0
}

// @ts-expect-error - not an RpcMethod. If the contract's types degraded to
// \`any\`, this line would stop being an error and tsc would fail on the unused
// directive instead - which is the point.
export const notAMethod: RpcMethod = 'no.such.method'

// @ts-expect-error - apiVersion is the literal 1, and a contract break is a
// new major, never a widened field (docs/PLUGIN-CONTRACT-PACKAGING.md).
export const wrongApiVersion: SystemPluginDefinition['apiVersion'] = 2
`

/** A plugin repository's tsconfig: no paths, no aliases, nothing of this workspace. */
const SAMPLE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    types: [],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['plugin.ts'],
}

/**
 * Extract one npm tarball, dropping its single `package/` root.
 *
 * Hand-written rather than shelled out to `tar`, and the reason is measured:
 * on this machine the `tar` first on PATH is MSYS's GNU tar, which reads the
 * colon in `C:\Users\...\x.tgz` as a remote host and fails with "Cannot
 * connect to C: resolve failed". Windows' own bsdtar would have taken it, and
 * so would every Linux runner, which is exactly what makes the dependency on
 * whatever `tar` happens to be first a bad one for a test whose whole subject
 * is "does this work on a machine that is not this one". Fifty lines of ustar
 * reader depend on nothing.
 *
 * Handles what an npm tarball contains: ustar regular files and directories,
 * the `prefix` field for long paths, and a `pax` extended header's `path`
 * record (node-tar emits one whenever a name does not fit). Anything else —
 * links, devices — is skipped, and the caller checks that files arrived.
 *
 * @param tarball - the `.tgz` to read.
 * @param into - where its contents go, `package/` stripped.
 * @returns how many regular files were written.
 */
function extractTarball(tarball: string, into: string): number {
  const buffer = gunzipSync(readFileSync(tarball))
  let offset = 0
  let written = 0
  let paxPath: string | undefined
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (from: number, length: number): string =>
      header.subarray(from, from + length).toString('utf8').replace(/\0.*$/su, '')
    const size = Number.parseInt(field(124, 12).trim(), 8)
    const type = String.fromCharCode(header[156] as number)
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === 'x' || type === 'g') {
      // `%d path=%s\n`, one record per line.
      const record = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (type === 'x' && record !== null) paxPath = record[1]
      continue
    }
    const prefix = field(345, 155)
    const name = paxPath ?? (prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`)
    paxPath = undefined
    const stripped = name.split('/').slice(1).join('/')
    if (stripped === '' || stripped.split('/').includes('..')) continue
    if (type === '5') {
      mkdirSync(join(into, stripped), { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0') continue
    mkdirSync(dirname(join(into, stripped)), { recursive: true })
    writeFileSync(join(into, stripped), body)
    written += 1
  }
  return written
}

/**
 * Link a directory into the sample's `node_modules`.
 *
 * A junction rather than a symlink: on Windows a directory symlink needs a
 * privilege an ordinary developer account does not have, while a junction does
 * not. Node ignores the type argument everywhere else. Copying would work too
 * and costs 7 MB of zod per run.
 *
 * @param target - the real directory, absolute.
 * @param link - where it should appear.
 */
function linkDir(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true })
  try {
    symlinkSync(target, link, 'junction')
  } catch {
    cpSync(target, link, { recursive: true })
  }
}

/**
 * Build the whole sample repository: pack, extract, link, write the sources.
 *
 * @param dir - an empty temporary directory.
 * @returns where its `node_modules` and the publishing output are.
 */
function stageSampleRepository(dir: string): { modules: string, out: string } {
  const out = join(dir, 'out')

  // Two decoys from an imaginary previous run at another version, so the same
  // single run also answers "does it really clear its own output". It is a
  // delete that silently does nothing — not a delete that throws — that this
  // catches, and that is the shape the failure took when it happened here.
  mkdirSync(join(out, 'protocol', 'lib'), { recursive: true })
  writeFileSync(join(out, 'protocol', 'lib', 'ghost.js'), 'export const ghost = 1\n')
  writeFileSync(join(out, 'iris-protocol-0.0.1.tgz'), 'not a tarball')

  execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'pack-contracts.mjs'), '--version', VERSION, '--out', out],
    { cwd: ROOT, stdio: 'pipe' },
  )

  const modules = join(dir, 'node_modules')
  for (const { stage } of PACKAGES) {
    const tarball = join(out, `iris-${stage}-${VERSION}.tgz`)
    assert.ok(existsSync(tarball), `expected ${tarball}`)
    const into = join(modules, '@iris', stage)
    mkdirSync(into, { recursive: true })
    // An extractor that extracted nothing leaves a directory that looks like
    // an install and is empty, so the count is asserted here rather than left
    // to the file checks below to notice one file at a time.
    const files = extractTarball(tarball, into)
    assert.ok(files > 3, `expected a package in ${tarball}, extracted ${String(files)} file(s)`)
  }

  // zod is a real dependency of the published `@iris/protocol`, so the sample
  // repository needs it the way `npm install` would have provided it.
  const zod = realpathSync(join(ROOT, 'packages', 'iris-protocol', 'node_modules', 'zod'))
  linkDir(zod, join(modules, 'zod'))

  // Cordis is needed for **types only** — nothing below imports it at runtime —
  // but its declarations reach into its own two dependencies, so the scope
  // directories beside it come along rather than the one package.
  const cordis = realpathSync(join(ROOT, 'packages', 'iris-plugin-api', 'node_modules', '@deepseek-ai', 'cordis'))
  const store = dirname(dirname(cordis))
  linkDir(join(store, '@deepseek-ai'), join(modules, '@deepseek-ai'))
  linkDir(join(store, '@standard-schema'), join(modules, '@standard-schema'))

  // The manifest a plugin repository would write, and the one this file's
  // documentation quotes (docs/PLUGIN-CONTRACT-PACKAGING.md).
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'iris-plugin-example',
    version: '0.1.0',
    private: true,
    type: 'module',
    dependencies: {
      '@iris/plugin-api': VERSION,
      '@iris/plugin-web-api': VERSION,
      '@iris/protocol': VERSION,
      '@deepseek-ai/cordis': '4.0.2',
    },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify(SAMPLE_TSCONFIG, null, 2)}\n`)
  writeFileSync(join(dir, 'plugin.ts'), SAMPLE)
  return { modules, out }
}

test('the published contract packages resolve and run outside the workspace', async (t) => {
  const started = Date.now()
  const dir = mkdtempSync(join(tmpdir(), 'iris-contract-pack-'))
  try {
    const { modules, out } = stageSampleRepository(dir)

    // 0. The run cleared the output it found. Both decoys are gone, and the
    //    only tarballs present are this run's three.
    assert.equal(existsSync(join(out, 'protocol', 'lib', 'ghost.js')), false, 'a stale emitted file survived the run')
    assert.equal(existsSync(join(out, 'iris-protocol-0.0.1.tgz')), false, 'a stale tarball survived the run')
    assert.deepEqual(
      readdirSync(out).filter(entry => entry.endsWith('.tgz')).sort(),
      PACKAGES.map(({ stage }) => `iris-${stage}-${VERSION}.tgz`).sort(),
    )

    // 1. The published manifests say what they must say, read out of the
    //    tarball rather than out of the staging directory: what a consumer
    //    installs is the tarball.
    for (const { stage, name } of PACKAGES) {
      const manifest = JSON.parse(
        readFileSync(join(modules, '@iris', stage, 'package.json'), 'utf8'),
      ) as Record<string, unknown>
      assert.equal(manifest['name'], name)
      assert.equal(manifest['version'], VERSION)
      assert.equal(manifest['private'], undefined, `${name} must not publish as private`)
      assert.deepEqual(manifest['exports'], {
        '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      }, `${name}'s published exports must face lib, never src`)
      const deps = (manifest['dependencies'] ?? {}) as Record<string, string>
      const unresolved = Object.entries(deps).filter(([, range]) => range.startsWith('workspace:'))
      assert.deepEqual(unresolved, [], `${name} published an unresolvable workspace range`)
      for (const [dep, range] of Object.entries(deps)) {
        if (dep.startsWith('@iris/')) assert.equal(range, VERSION, `${name} -> ${dep}`)
      }
      // The framework is a peer everywhere it appears: a plugin installing its
      // own second copy would get a second module identity and silently
      // register its services into a registry the host never reads.
      assert.equal(deps['@deepseek-ai/cordis'], undefined, `${name} must not depend on Cordis`)
      assert.ok(existsSync(join(modules, '@iris', stage, 'lib', 'index.js')), `${name} lib/index.js`)
      assert.ok(existsSync(join(modules, '@iris', stage, 'lib', 'index.d.ts')), `${name} lib/index.d.ts`)
    }
    const pluginApi = JSON.parse(
      readFileSync(join(modules, '@iris', 'plugin-api', 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    assert.equal(pluginApi.peerDependencies?.['@deepseek-ai/cordis'], '4.0.2')

    // 2. No emitted JavaScript may import a `.ts` file. The type checker below
    //    cannot see this — it reads the declarations — and the loader below
    //    sees only the entry point's own graph, so the scan is what covers the
    //    files neither of them reaches.
    const survivors: string[] = []
    for (const { stage } of PACKAGES) {
      const lib = join(modules, '@iris', stage, 'lib')
      for (const file of readdirSync(lib).filter(entry => entry.endsWith('.js'))) {
        const source = readFileSync(join(lib, file), 'utf8')
        for (const match of source.matchAll(/from ["'](\.[^"']*\.ts)["']/g)) {
          survivors.push(`${stage}/lib/${file}: ${match[1] as string}`)
        }
      }
    }
    assert.deepEqual(survivors, [], 'a .ts specifier survived into the emitted JavaScript')

    // 2b. The tarball carries no source maps. `lib` is everything that ships
    //     and there is no `src/` beside it, so a `.d.ts.map`/`.js.map` would
    //     point at files no consumer has — a dangling map is worse than an
    //     absent one, because "go to definition" follows it and lands nowhere.
    //     Both halves are asserted: the maps are absent from the extracted
    //     tree, and the tarball's own entry list — read from the bytes rather
    //     than from what the extractor chose to write — names no `*.map`.
    //     `inlineSources` alone could smuggle the source text in without a map
    //     file, so the emitted `.js`/`.d.ts` are checked for `sourceMappingURL`
    //     too. A mutation re-enabling `declarationMap`/`sourceMap` in any pack
    //     config reddens this.
    const mapFiles: string[] = []
    const mapPointers: string[] = []
    for (const { stage } of PACKAGES) {
      const lib = join(modules, '@iris', stage, 'lib')
      for (const file of readdirSync(lib)) {
        if (file.endsWith('.map')) mapFiles.push(`${stage}/lib/${file}`)
        if (file.endsWith('.js') || file.endsWith('.d.ts')) {
          const source = readFileSync(join(lib, file), 'utf8')
          if (/sourceMappingURL=/.test(source)) mapPointers.push(`${stage}/lib/${file}`)
        }
      }
    }
    assert.deepEqual(mapFiles, [], 'a source map shipped in lib/, where nothing can resolve it')
    assert.deepEqual(mapPointers, [], 'an emitted file still points at a source map that does not ship')

    // 3. A plugin author's type check: the published `types` condition only,
    //    no paths, no alias, no workspace.
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    try {
      execFileSync(process.execPath, [tsc, '-p', dir, '--noEmit'], { stdio: 'pipe', encoding: 'utf8' })
    } catch (error) {
      const failure = error as { stdout?: string, stderr?: string }
      assert.fail(`the sample plugin does not typecheck against the published packages:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`)
    }

    // 4. The loader's turn. `import()` with a computed specifier, so nothing
    //    here is resolved by TypeScript at build time either.
    const protocolEntry = pathToFileURL(join(modules, '@iris', 'protocol', 'lib', 'index.js')).href
    const protocol = await import(protocolEntry) as { requestSchemas: Record<string, unknown> }
    const methods = Object.keys(protocol.requestSchemas)
    assert.ok(methods.length > 100, `expected the whole RPC surface, got ${String(methods.length)} methods`)
    assert.ok(methods.includes('plugin.list'), 'expected the system-plugin methods')

    const webEntry = pathToFileURL(join(modules, '@iris', 'plugin-web-api', 'lib', 'index.js')).href
    const web = await import(webEntry) as {
      parsePluginAssetManifest: (text: string) => { revision: number, plugins: Record<string, unknown> } | string
      PLUGIN_ASSET_MANIFEST_PATH: string
    }
    const parsed = web.parsePluginAssetManifest(JSON.stringify({
      revision: 3,
      plugins: { example: { rev: '0123456789ab', client: '/plugins/example/client.js?v=0123456789ab' } },
    }))
    assert.notEqual(typeof parsed, 'string', `the manifest parser refused a valid manifest: ${String(parsed)}`)
    assert.deepEqual(parsed, {
      revision: 3,
      plugins: { example: { rev: '0123456789ab', client: '/plugins/example/client.js?v=0123456789ab' } },
    })
    assert.equal(web.PLUGIN_ASSET_MANIFEST_PATH, '/plugins/manifest.json')

    t.diagnostic(`contract-pack: ${String(Date.now() - started)} ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
