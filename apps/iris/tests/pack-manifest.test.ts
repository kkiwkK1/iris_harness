import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The published-manifest rewrite, on its own.
 *
 * `apps/iris/tests/contract-pack.test.ts` proves the whole publishing step
 * works, and it takes six seconds and two TypeScript compilations to say so.
 * This file takes the one pure function out of the middle of that and asks it
 * the questions that have a wrong answer per package rather than per run: what
 * happens to a `workspace:*` range, what happens to a peer that is not there,
 * what a non-semver version does, and — the one that matters most and would
 * never show up as a test failure anywhere else — that `private` and the
 * workspace's `0.0.0` cannot reach a tarball.
 *
 * It reads the script through a **computed** specifier. The script is `.mjs`
 * and this repository does not turn on `allowJs`, so a literal `import` of it
 * would be a type error; a computed one is not resolved by TypeScript at all,
 * and the shape is stated here as the cast instead. That is a real (small)
 * gap — the cast is a claim about the script's export, not a check of it — and
 * the claim is checked by the first assertion failing loudly if the import
 * yields nothing.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

interface PublishedManifest {
  name: string
  version: string
  description: string
  license: string
  type: string
  files: string[]
  exports: Record<string, unknown>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  private?: unknown
}

type Packer = {
  publishedManifest: (
    manifest: { name: string, description?: string, license?: string, dependencies?: Record<string, string> },
    version: string,
    peers?: readonly string[],
  ) => PublishedManifest
}

const script = pathToFileURL(join(ROOT, 'scripts', 'pack-contracts.mjs')).href
const { publishedManifest } = await import(script) as Packer

/** The workspace manifest shape the rewrite is given, as `@iris/plugin-web-api` states it. */
const WORKSPACE = {
  name: '@iris/plugin-web-api',
  license: 'AGPL-3.0-only',
  version: '0.0.0',
  private: true,
  type: 'module',
  description: 'The browser-side system-plugin face.',
  exports: { '.': './src/index.ts', './src/*': './src/*' },
  dependencies: { '@iris/protocol': 'workspace:*' },
}

test('the script really exports the rewrite', () => {
  assert.equal(typeof publishedManifest, 'function')
})

test('a workspace range becomes the version being published', () => {
  const published = publishedManifest(WORKSPACE, '1.0.0-alpha.3')
  assert.deepEqual(published.dependencies, { '@iris/protocol': '1.0.0-alpha.3' })
  // The three packages are published together, so the edge between them is an
  // exact pin rather than a range: a `^` here would let a plugin repository
  // install a protocol newer than the plugin-api it was typed against.
  assert.equal(published.dependencies?.['@iris/protocol'], published.version)
})

test('a registry range the workspace chose is carried through untouched', () => {
  const published = publishedManifest(
    { name: '@iris/protocol', dependencies: { zod: '^4.4.3' } },
    '1.0.0',
  )
  assert.deepEqual(published.dependencies, { zod: '^4.4.3' })
})

test('the framework is published as a peer, not a dependency', () => {
  const published = publishedManifest(
    { name: '@iris/plugin-api', dependencies: { '@deepseek-ai/cordis': '4.0.2' } },
    '1.0.0',
    ['@deepseek-ai/cordis'],
  )
  assert.deepEqual(published.peerDependencies, { '@deepseek-ai/cordis': '4.0.2' })
  assert.equal(published.dependencies, undefined)
})

test('a peer the manifest does not declare is refused rather than silently dropped', () => {
  // The failure this catches is a renamed or removed dependency leaving the
  // peer table naming nothing: the package would then publish with the
  // framework as an ordinary dependency, or with no framework at all, and
  // every assertion about what *is* in the manifest would still pass.
  assert.throws(
    () => publishedManifest({ name: '@iris/plugin-api', dependencies: {} }, '1.0.0', ['@deepseek-ai/cordis']),
    /declares @deepseek-ai\/cordis a peer but does not depend on it/,
  )
})

test('neither `private` nor the workspace version can reach the published shape', () => {
  const published = publishedManifest(WORKSPACE, '1.0.0-alpha.3')
  assert.equal('private' in published, false)
  assert.equal(published.version, '1.0.0-alpha.3')
  assert.notEqual(published.version, WORKSPACE.version)
})

test('the published exports face lib, and publish no source subpath', () => {
  const published = publishedManifest(WORKSPACE, '1.0.0')
  assert.deepEqual(published.exports, {
    '.': { types: './lib/index.d.ts', default: './lib/index.js' },
  })
  assert.deepEqual(published.files, ['lib'])
  assert.equal(published.type, 'module')
  assert.equal(published.license, 'AGPL-3.0-only')
})

test('the script refuses to run without a version, and writes nothing', () => {
  // Checked on the real invocation rather than on `publishedManifest`, because
  // the failure mode is a *default*: a script that quietly published `0.0.0`,
  // or last run's number, would produce a perfectly valid tarball carrying a
  // compatibility promise nobody made. The exit has to happen before any
  // output is deleted or written, so the message is asserted too — an exit 1
  // from a crash somewhere later would pass a bare exit-code check.
  let stderr = ''
  let status = 0
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'pack-contracts.mjs')], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    })
  } catch (error) {
    const failure = error as { status?: number, stderr?: string }
    status = failure.status ?? 0
    stderr = failure.stderr ?? ''
  }
  assert.equal(status, 1)
  assert.match(stderr, /--version <semver> is required/)
})

test('a version that is not semver is refused', () => {
  for (const bad of ['', '1.0', 'v1.0.0', '^1.0.0', '1.0.0.0', 'latest', '01.0.0']) {
    assert.throws(
      () => publishedManifest(WORKSPACE, bad),
      /is not a semver version/,
      `expected "${bad}" to be refused`,
    )
  }
  for (const good of ['1.0.0', '0.0.1', '1.0.0-alpha.0', '2.3.4-rc.1+build.5']) {
    assert.equal(publishedManifest(WORKSPACE, good).version, good)
  }
})
