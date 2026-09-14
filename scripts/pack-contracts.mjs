/**
 * Publish the three contract packages a plugin repository outside this
 * monorepo consumes: `@iris/plugin-api`, `@iris/plugin-web-api` and
 * `@iris/protocol`.
 *
 * **Why a script and not a manifest change.** The workspace has no build step
 * on purpose — Node 24 runs `./src/index.ts` directly through type stripping,
 * every package's `exports` points at the source, and `private: true` says the
 * workspace copies are not npm packages. All of that stays exactly as it is.
 * Publishing is a *deliberate, separate act* that reads the workspace and
 * writes somewhere else: a staging tree under `dist-pack/` (gitignored) and a
 * tarball per package. Nothing here edits a workspace manifest, so there is no
 * state in which the tree is "half published" — the way there would be if the
 * route were flipping `private` to `false` and pointing `exports` at a `lib/`
 * the workspace does not build. `docs/PLUGIN-CONTRACT-PACKAGING.md` is the
 * prose; `apps/iris/tests/contract-pack.test.ts` is the proof that what comes
 * out of here resolves and runs with no workspace, no path mapping and no
 * alias behind it.
 *
 * What one run does, per package:
 *
 *  1. `tsc -p packages/<pkg>/tsconfig.pack.json` into `<out>/<stage>/lib`,
 *     with declarations, declaration maps and source maps. The pack configs
 *     `extend` the repository base, so `target` and the strictness flags are
 *     the workspace's by construction rather than by a copied constant.
 *  2. A **generated** `package.json` in the staging directory
 *     ({@link publishedManifest}). Generated, not copied and patched: the
 *     published shape differs from the workspace shape in five places at once
 *     (`private` gone, a real version, `files`, a `lib`-facing `exports`,
 *     `workspace:*` resolved), and a patch that forgets one of them produces a
 *     tarball that looks right and is not.
 *  3. `npm pack` into `<out>/`.
 *
 * Idempotent: a previous output is moved aside (and deleted where the platform lets it) before anything is written.
 *
 * Usage:
 *
 *     npm run pack:contracts -- --version 1.0.0-alpha.0
 *     npm run pack:contracts -- --version 1.0.0-alpha.0 --out /tmp/somewhere
 *
 * `--version` is required and has no default. The number is a decision about
 * the contract's compatibility promise (`docs/PLUGIN-CONTRACT-PACKAGING.md`,
 * 版本策略), and a script that guessed it would make that decision silently
 * every time someone re-ran it.
 *
 * @module scripts/pack-contracts
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The three packages, and the one thing that is not derivable from a manifest.
 *
 * `peers` is that thing. `@deepseek-ai/cordis` is a plain dependency in the
 * workspace, where there is exactly one copy of it and nothing can go wrong;
 * in a published package it must be a **peerDependency**, because a plugin
 * that installs its own second copy gets a second module instance, and every
 * Cordis declaration merge in this project targets `declare module
 * '@deepseek-ai/cordis'` (`notes/PLAN.md` — the reason the whole tree pins
 * `@deepseek-ai/cordis` 4.0.2 rather than upstream `cordis` is that all
 * `dsh-*` packages take it as a peer and merge into that one module name).
 * Two instances means two module identities: the host's `Context` and the
 * plugin's `Context` are unrelated types, the plugin's services are published
 * into a registry the host never reads, and nothing reports an error — the
 * plugin simply never activates anything the host can see.
 *
 * `stage` is the staging directory name: the package name without its scope,
 * so the tree under `dist-pack/` reads as the set of packages rather than as
 * a set of directory names that happen to start with `iris-`.
 */
const CONTRACTS = [
  { dir: 'packages/iris-plugin-api', stage: 'plugin-api', peers: ['@deepseek-ai/cordis'] },
  { dir: 'packages/iris-plugin-web-api', stage: 'plugin-web-api', peers: [] },
  { dir: 'packages/iris-protocol', stage: 'protocol', peers: [] },
]

/**
 * The semver grammar, from semver.org's own published regular expression.
 *
 * Anchored and complete rather than "has two dots": the version reaches npm's
 * metadata, and a range (`^1.0.0`), a `v` prefix or a bare `1.0` are all
 * things a hurried invocation produces and npm then either rejects far away
 * from here or, worse, accepts into a tarball name.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/**
 * The published `package.json` for one contract package.
 *
 * Pure, and exported, so the rewrite can be tested without running a compiler
 * (`apps/iris/tests/pack-manifest.test.ts`, at the composition root for the
 * reason `architecture.test.ts` is — it is the only place entitled to know all
 * three packages exist).
 *
 * The four rewrites, and why each is a rewrite rather than a copy:
 *
 *  - **`private` and `version` are not carried.** The workspace says
 *    `private: true` and `0.0.0`, which is the truth about the workspace copy.
 *    The published copy is a different artifact with a different truth, and
 *    building it by *omission* rather than by deleting a field means a
 *    `private: true` can never survive by accident.
 *  - **`exports` is replaced, not adjusted.** The workspace maps `.` to
 *    `./src/index.ts` and carries a `./src/*` subpath. Neither is published:
 *    the tarball contains `lib` and nothing else, and a `./src/*` export in a
 *    published package is a promise that every internal file is a public entry
 *    point — the very promise `architecture.test.ts` had to be widened to
 *    police inside this repository.
 *  - **`workspace:*` becomes the version being published.** pnpm resolves that
 *    protocol at install time inside a workspace; outside one it is a
 *    specifier npm cannot fetch. The three packages are published together, so
 *    the resolved range is the exact version of this run.
 *  - **`peers` move out of `dependencies`.** See {@link CONTRACTS}.
 *
 * @param {{ name: string, description?: string, license?: string, dependencies?: Record<string, string> }} manifest
 *   the workspace manifest, parsed.
 * @param {string} version - the semver being published; already validated.
 * @param {readonly string[]} peers - dependency names to publish as peers.
 * @returns {Record<string, unknown>} the manifest to write into the staging directory.
 */
export function publishedManifest(manifest, version, peers = []) {
  if (!SEMVER.test(version)) {
    throw new Error(`pack-contracts: "${version}" is not a semver version`)
  }
  /** @type {Record<string, string>} */
  const dependencies = {}
  /** @type {Record<string, string>} */
  const peerDependencies = {}
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    // A `workspace:*` edge is an edge between two packages published together,
    // so it resolves to this run's version; anything else is a registry range
    // the workspace already chose and this script has no opinion about.
    const published = range.startsWith('workspace:') ? version : range
    if (peers.includes(name)) peerDependencies[name] = published
    else dependencies[name] = published
  }
  for (const name of peers) {
    // A peer that is not a workspace dependency means this table and the
    // manifest have drifted apart; the failure to catch is the silent one,
    // where a renamed dependency leaves `peers` naming nothing and the package
    // publishes with the framework as an ordinary dependency after all.
    if (!(name in peerDependencies)) {
      throw new Error(`pack-contracts: ${manifest.name} declares ${name} a peer but does not depend on it`)
    }
  }
  /** @type {Record<string, unknown>} */
  const published = {
    name: manifest.name,
    version,
    description: manifest.description ?? '',
    license: manifest.license ?? 'AGPL-3.0-only',
    type: 'module',
    files: ['lib'],
    exports: {
      '.': {
        types: './lib/index.d.ts',
        default: './lib/index.js',
      },
    },
  }
  if (Object.keys(dependencies).length > 0) published.dependencies = dependencies
  if (Object.keys(peerDependencies).length > 0) published.peerDependencies = peerDependencies
  return published
}

/** @param {string} message - what went wrong; printed, then the process exits 1. */
function fail(message) {
  console.error(`pack-contracts: ${message}`)
  process.exit(1)
}

/**
 * Read `--version` and `--out`, refusing anything else.
 *
 * Unknown flags are an error rather than being ignored: the one argument that
 * matters is easy to misspell (`--ver`, `--tag`), and an ignored flag means
 * the required-argument check below fires with a confusing message or, if the
 * version was also given, a silently wrong output location.
 *
 * @param {readonly string[]} argv - `process.argv.slice(2)`.
 * @returns {{ version: string, out: string }} the validated invocation.
 */
function parseArgs(argv) {
  let version
  let out = 'dist-pack'
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--version' || flag === '--out') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`)
      if (flag === '--version') version = value
      else out = value
      index += 1
      continue
    }
    fail(`unknown argument "${flag}"; usage: npm run pack:contracts -- --version <semver> [--out <dir>]`)
  }
  if (version === undefined) {
    fail('--version <semver> is required; the number is a compatibility decision, not a default (docs/PLUGIN-CONTRACT-PACKAGING.md)')
  }
  if (!SEMVER.test(version)) {
    fail(`"${version}" is not a semver version; expected something like 1.0.0-alpha.0`)
  }
  return { version, out }
}

/**
 * npm, as a JavaScript file run by this Node.
 *
 * Not the `npm`/`npm.cmd` shim on PATH: on Windows that is a `.cmd`, which
 * `execFile` refuses without a shell, and running it through a shell would put
 * this repository's non-ASCII path through cmd.exe quoting for no benefit.
 *
 * @returns {string} the path to `npm-cli.js` shipped beside this Node.
 */
function npmCli() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(cli)) fail(`could not find npm beside node (looked at ${cli})`)
  return cli
}

/** @param {string} dir - a directory; @returns {number} the total size of its files, in bytes. */
function sizeOf(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? sizeOf(path) : statSync(path).size
  }
  return total
}

function main() {
  const { version, out } = parseArgs(process.argv.slice(2))
  const outDir = resolve(ROOT, out)
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) fail(`could not find the workspace TypeScript (looked at ${tsc}); run an install first`)
  const npm = npmCli()

  // Idempotence, and it has to be a fresh directory rather than an overwrite:
  // a stale `lib/` from a previous run whose source file has since been
  // deleted would otherwise be published as part of this one, and a stale
  // `.tgz` from a different `--version` would sit beside this run's output
  // looking equally fresh.
  //
  // The previous output is **moved aside first, then deleted best-effort**,
  // rather than deleted in place and checked. Measured 2026-09-15 on the
  // machine this was written on: `rmSync(dir, { recursive: true })` on a
  // directory inside this repository returned without an error and removed
  // nothing, while `renameSync` and single-file `unlinkSync` worked and the
  // same `rmSync` under the OS temp directory worked — an environment fact of
  // that machine's tool sandbox, not of Node, but a publish step must not
  // depend on which machine it runs on. A rename cannot half-succeed, so the
  // directory this run writes into is empty by construction; what survives is
  // at worst a `dist-pack.stale-<stamp>` beside it, named in the output.
  if (existsSync(outDir)) {
    const stale = `${outDir}.stale-${new Date().toISOString().replaceAll(':', '-')}`
    renameSync(outDir, stale)
    rmSync(stale, { recursive: true, force: true })
    if (existsSync(stale)) {
      console.warn(`pack-contracts: the previous output could not be deleted and was moved aside to ${stale}; remove it by hand.`)
    }
  }
  mkdirSync(outDir, { recursive: true })
  if (readdirSync(outDir).length > 0) fail(`${outDir} is not empty after creation; refusing to publish into it`)

  for (const contract of CONTRACTS) {
    const source = join(ROOT, contract.dir)
    const stage = join(outDir, contract.stage)
    /** @type {{ name: string, description?: string, license?: string, dependencies?: Record<string, string> }} */
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))

    console.log(`pack-contracts: ${manifest.name} -> ${stage}`)
    // `--outDir` on the command line overrides the config's, which is what
    // lets `--out` point a whole run at a temporary directory; everything else
    // — target, strictness, the extension rewrite — comes from the file.
    execFileSync(
      process.execPath,
      [tsc, '-p', join(source, 'tsconfig.pack.json'), '--outDir', join(stage, 'lib')],
      { cwd: ROOT, stdio: 'inherit' },
    )

    writeFileSync(
      join(stage, 'package.json'),
      `${JSON.stringify(publishedManifest(manifest, version, contract.peers), null, 2)}\n`,
    )
    // npm ships LICENSE and README regardless of `files`; shipping the licence
    // of an AGPL package is not optional, so it is put where npm will find it.
    copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'))

    execFileSync(process.execPath, [npm, 'pack', '--pack-destination', outDir], { cwd: stage, stdio: 'inherit' })
    console.log(`pack-contracts: ${manifest.name} lib is ${String(sizeOf(join(stage, 'lib')))} bytes`)
  }

  console.log(`\npack-contracts: ${String(CONTRACTS.length)} package(s) at ${version} in ${outDir}`)
}

// Importable for the manifest test, runnable for everything else.
// `pathToFileURL`, not a hand-built `file://` string: this repository's path
// contains non-ASCII characters and a drive letter, both of which a hand-built
// URL spells differently from the one Node puts in `import.meta.url`.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
