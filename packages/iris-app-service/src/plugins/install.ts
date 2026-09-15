/**
 * The system-plugin install path: preview, confirm, cancel, boot scan.
 *
 * This is PR-2 of `docs/SYSTEM-PLUGIN-INSTALL.md` §10 — the half that turns
 * "a Node system plugin must be in `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS` or
 * arrive as an ST extension" into "a package tree can be fetched, shown to the
 * user, and adopted". It owns no mechanism of its own: fetching, staging,
 * containment auditing, hashing and atomic promotion are all
 * `@iris/extension-installer`'s, the manifest contract is `./manifest.ts`'s,
 * and the catalog is `SystemPluginRuntime`'s. What lives here is the
 * *sequence*, and the four decisions the sequence forces.
 *
 * **1. Two steps, and the second one compares against a record.** `preview`
 * stops the installer's transaction at its existing `hashed` phase, with the
 * tree in staging and nothing from it executed. `confirm` echoes back the id,
 * the tree hash and the commit, and every one of them is compared against the
 * transaction the host is already holding — never against a fresh fetch. That
 * is the whole reason the handshake is worth its complexity: the hash the user
 * approved is the hash of the bytes that get promoted, so a tree that moved
 * between the two calls cannot be approved by a consent page that saw the old
 * one (§9 #13).
 *
 * **2. `dev` is loaded in place; `git` is promoted.** A `git` package is
 * copied into `<profile>/system-plugins/installed/<id>/`, locked, and re-hashed
 * on every boot. A `dev` package is staged only so it can be *validated* — the
 * contract, the containment audit and the hash all run — and then the staging
 * is discarded and the catalog records the user's own directory. It has to work
 * that way for the source to mean anything: §7 skips re-verification for `dev`
 * "because its tree is being edited", and a tree that had been copied into the
 * install root would not be the tree being edited. The cost is the one ruling 1
 * accepted in as many words: in a release build there is a same-privilege load
 * path with no byte check behind it, paid for by marking the row `dev`
 * everywhere it appears.
 *
 * **3. Nothing here loads `host.js`.** Neither preview nor confirm imports a
 * line of the package. The definition adopted into the catalog is a *lazy*
 * one: its metadata comes from the manifest, and its `activate` is what
 * performs the `import()`. So the first time a plugin's code runs is the
 * moment the user enables it, which is what §5.2 means by "installation is not
 * activation" and what the lock record already states for itself
 * (`packages/iris-extension-installer/src/lock.ts:71`).
 *
 * **4. `client.js` goes through the asset face that already exists.** If the
 * manifest declares one, it is copied to
 * `<dataDir>/system-plugins/<id>/client/client.js` at adoption, which is the
 * exact location `PluginAssetStore` serves from
 * (`packages/iris-app-service/src/plugin-assets.ts:117`) and the same location
 * the ST compat path writes its member proxy to
 * (`packages/iris-app-service/src/index.ts:826`). The host does not scan it:
 * `scanPluginMemberNames` (`apps/iris-web/src/app/use-plugin-manifest.ts:208`)
 * is a browser module, it requires `registerPluginMembers('<string literal>',
 * { literal keys })` — a computed id or a computed member key scans as nothing
 * at all, which is not an error but "this plugin declares no members" — and a
 * bundle that clashes with another plugin's member names is refused **per
 * plugin, not per frame** (`apps/iris-web/src/sandbox/plugin-members.ts:13`).
 * That refusal is where it belongs and is not moved here.
 *
 * @module @iris/app-service/plugins/install
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  hashTree,
  Installer,
  isValidExtensionId,
  LOCK_FILE_NAME,
  parseLock,
  type ExtensionSource,
  type InstalledExtensionLock,
  type StagedInstall,
} from '@iris/extension-installer'
import type {
  SystemPluginFailure,
  SystemPluginInstallPreview,
  SystemPluginSnapshot,
} from '@iris/protocol'

import { AppError } from '../errors.ts'
import type { SystemPluginDefinition } from '../system-plugins.ts'
import type { InstalledPluginRecord, SystemPluginRuntime } from '../system-plugins.ts'
import { PLUGIN_COPY_LANGUAGES } from '@iris/text'
import {
  auditPluginCopy,
  checkPluginApiVersion,
  parsePluginManifest,
  SUPPORTED_PLUGIN_API_RANGE,
  SYSTEM_PLUGIN_ARTIFACT_CONTRACT,
  type SystemPluginManifest,
} from './manifest.ts'

/**
 * How big a system-plugin package may be: **256 MiB and 20,000 files**
 * (`docs/SYSTEM-PLUGIN-INSTALL.md` §9 #9).
 *
 * The numbers are a measurement, not a taste. The one real tree that has ever
 * travelled this code path is the ST-compat pilot's, and it is **415 files /
 * 102,374,704 bytes** (`notes/st-compat/pilot-lock.md` §2) — so a "sensible"
 * 16 MiB ceiling would have refused the only genuine sample on the day it was
 * written, and a 1,000-file ceiling would have come within a factor of three of
 * it. 256 MiB keeps a factor of 2.5 over the measured sample while staying
 * well under `DEFAULT_EXTRACT_LIMITS`' 1 GiB
 * (`packages/iris-extension-installer/src/archive.ts:48`), which is what still
 * makes an obvious decompression bomb a refusal rather than a disk-full.
 *
 * One constant, exported, so the check and the sentence the user reads cannot
 * drift apart — the failure mode `notes/PLUGIN-FEASIBILITY.md` §8 item 3 names,
 * where a number that moves shortens an answer instead of erroring.
 */
export const PLUGIN_TREE_LIMITS = {
  maxBytes: 256 * 1024 * 1024,
  maxFiles: 20_000,
} as const

/** The directory name the installer promotes into, under the install root. */
const INSTALLED_DIR = 'installed'

/** The file name the asset face serves a plugin's browser bundle under. */
const CLIENT_BUNDLE = 'client.js'

/**
 * A failure with one of the six names, raised where it happens.
 *
 * Every refusal on this path is one of these; there is no generic `Error`
 * escaping to a caller that then has to guess which row to mark. The wire code
 * is `invalid-request` for everything a user can fix by choosing a different
 * package and `internal` for everything else, which is the same split the rest
 * of app-service uses.
 */
export class SystemPluginInstallError extends AppError {
  readonly failure: SystemPluginFailure
  constructor(failure: SystemPluginFailure, code: 'invalid-request' | 'internal' = 'invalid-request') {
    // The field and the git step are part of the sentence, not only of the
    // structured payload: a refusal reaches a log, a test's assertion and a
    // thrown error's `.message` far more often than it reaches a renderer, and
    // "manifest-invalid: expected an object" without the field name is the
    // refusal that sends an author reading the wrong line of their manifest.
    // Same shape as `PluginManifestError`'s message (`./manifest.ts`).
    super(code, [
      failure.state,
      ': ',
      failure.field !== undefined ? `${failure.field} — ` : '',
      failure.step !== undefined ? `[${failure.step}] ` : '',
      failure.reason,
    ].join(''))
    this.name = 'SystemPluginInstallError'
    this.failure = failure
  }
}

function installFailed(reason: string, step?: string): SystemPluginInstallError {
  return new SystemPluginInstallError({
    state: 'install-failed',
    ...(step !== undefined ? { step } : {}),
    reason,
  })
}

/** The request shape `plugin.previewInstall` carries, after the wire schema. */
export type PluginInstallSource =
  | { kind: 'git', remote: string, commit: string }
  | { kind: 'dev', path: string }

export interface SystemPluginInstallOptions {
  runtime: SystemPluginRuntime
  /** `<profile>/system-plugins` — the installer layout root (staging/ claims/ installed/). */
  installRoot: string
  /**
   * `<dataDir>/system-plugins` — the **asset** root, where browser bundles are
   * served from.
   *
   * Not the same directory as `installRoot`, and the collision of names is
   * real and deliberate on both sides: this one is dataDir-level and holds only
   * `<id>/client/client.js` (`plugin-assets.ts:117`), the other is
   * profile-level and holds whole package trees. §6 flags the trap; the two
   * fields are named apart here so a call site cannot pass one for the other
   * without saying which it meant.
   */
  clientAssetRoot: string
  /** Test-only: allow `file://` git remotes, so a fixture repository needs no network. */
  allowLocalGit?: boolean
  /**
   * Test-only override of `PLUGIN_TREE_LIMITS`.
   *
   * A seam rather than a setting, and for the same reason `maxArchiveBytes` is
   * one on the installer: a test that proved the ceiling by building a
   * 20,001-file tree would take minutes and would still not prove the *byte*
   * ceiling, so the check is driven at a size a test can build and the
   * shipped numbers are pinned by their own assertion.
   */
  limits?: { maxBytes: number, maxFiles: number }
  log?: (message: string) => void
}

interface PendingPreview {
  staged: StagedInstall
  manifest: SystemPluginManifest
  source: PluginInstallSource
  preview: SystemPluginInstallPreview
}

/**
 * Credentials embedded in a remote URL, refused before git ever sees them.
 *
 * `validateExtensionSource` does not refuse them today
 * (`packages/iris-extension-installer/src/source.ts:60` checks the scheme and
 * whitespace/quotes, nothing about userinfo), and it is not tightened here
 * because that would change the ST install path's behaviour in a round that is
 * not about ST. On this path it is a refusal: a `https://user:token@host/repo`
 * would be copied verbatim into the lock record, into `system-plugins.json`,
 * into the consent page and into every `plugin.list` broadcast — a secret
 * pasted once and then persisted in four places, three of which the user never
 * looks at.
 */
function refuseEmbeddedCredentials(remote: string): void {
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    // Not a parseable URL: the installer's own scheme check refuses it, with a
    // better message than this function could write.
    return
  }
  if (url.username !== '' || url.password !== '') {
    throw installFailed(
      'the remote URL carries credentials in its userinfo — refused before the fetch, because the URL is recorded'
      + ' in the lock, in the catalog and on the consent page, and a secret written there is a secret in four files',
    )
  }
}

/** Walk a staged tree for a `node_modules` directory at any depth. */
async function findNodeModules(root: string, rel = ''): Promise<string | undefined> {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.name === 'node_modules') return childRel
    const found = await findNodeModules(root, childRel)
    if (found !== undefined) return found
  }
  return undefined
}

export class SystemPluginInstallService {
  readonly #runtime: SystemPluginRuntime
  readonly #installRoot: string
  readonly #clientAssetRoot: string
  readonly #allowLocalGit: boolean
  readonly #limits: { maxBytes: number, maxFiles: number }
  readonly #log: (message: string) => void
  readonly #pending = new Map<string, PendingPreview>()

  constructor(options: SystemPluginInstallOptions) {
    this.#runtime = options.runtime
    this.#installRoot = options.installRoot
    this.#clientAssetRoot = options.clientAssetRoot
    this.#allowLocalGit = options.allowLocalGit ?? false
    this.#limits = options.limits ?? PLUGIN_TREE_LIMITS
    this.#log = options.log ?? (() => {})
  }

  /** `<profile>/system-plugins/installed/<id>` — where a `git` package's tree lives. */
  installedDir(id: string): string {
    return path.join(this.#installRoot, INSTALLED_DIR, id)
  }

  /**
   * Stage a package and answer what it says about itself.
   *
   * Nothing from the package runs, and nothing outside staging is written. The
   * returned token is the install transaction's own id, which is what
   * `confirm` compares against.
   */
  async preview(source: PluginInstallSource): Promise<SystemPluginInstallPreview> {
    const extensionSource = this.#toExtensionSource(source)
    const installer = await Installer.create(this.#installRoot)
    let staged: StagedInstall
    try {
      staged = await installer.stage(extensionSource, {
        artifactContract: SYSTEM_PLUGIN_ARTIFACT_CONTRACT,
        allowLocalGit: this.#allowLocalGit,
      })
    } catch (error: unknown) {
      throw this.#stageFailure(error)
    }

    try {
      // Size and shape limits run on the staged tree, after the hash rather
      // than before it: `hashTree` is the only walk that already counts files
      // and bytes, and re-walking a tree to pre-check what the next walk will
      // report would be two answers to one question. The archive path's own
      // 1 GiB extraction ceiling is what keeps the pre-hash window bounded.
      if (staged.tree.files > this.#limits.maxFiles) {
        throw installFailed(
          `the package holds ${String(staged.tree.files)} files, over the ${String(this.#limits.maxFiles)}-file limit`,
        )
      }
      if (staged.tree.bytes > this.#limits.maxBytes) {
        throw installFailed(
          `the package is ${String(staged.tree.bytes)} bytes, over the ${String(this.#limits.maxBytes)}-byte limit`,
        )
      }
      const nodeModules = await findNodeModules(staged.contentPath)
      if (nodeModules !== undefined) {
        throw installFailed(
          `the package ships ${nodeModules} — refused. A plugin's dependencies on @iris/* are types only and are erased at`
          + ' build time, and a bundled copy of cordis would give the plugin a second Context: its services would land in a'
          + ' registry the host never reads, and the failure has no symptom at all',
        )
      }

      const parsed = await parsePluginManifest(staged.contentPath)
      if (!parsed.ok) {
        throw new SystemPluginInstallError(
          parsed.state === 'manifest-invalid'
            ? { state: 'manifest-invalid', field: parsed.field, reason: parsed.reason }
            : { state: 'incompatible', field: 'apiVersion', reason: parsed.reason },
        )
      }
      const manifest = parsed.manifest

      // The content audit ran in the contract during `stage` — before the tree
      // was hashed — and that is the refusal that guards the install path. It
      // runs again here only to count the strings the consent page shows; the
      // small files are read twice rather than widening `StagedInstall` to
      // carry the audit past the installer boundary (see ledger §84).
      const copyAudit = await auditPluginCopy(staged.contentPath, manifest)
      if (!copyAudit.ok) {
        throw new SystemPluginInstallError({
          state: 'manifest-invalid',
          field: copyAudit.field,
          reason: copyAudit.reason,
        })
      }

      const warnings: string[] = []
      // Ruling 5 refuses a taken id at *confirm*, not here — but a consent page
      // that only learns at the last click has wasted the user's download, so
      // the fact travels in the preview as a warning while the refusal stays
      // where the owner put it.
      if (this.#runtime.ids().includes(manifest.id)) {
        warnings.push(`id "${manifest.id}" 已被占用 / the id "${manifest.id}" is already in this profile's catalog`)
      }
      for (const dependency of manifest.dependencies) {
        if (!this.#runtime.ids().includes(dependency)) {
          warnings.push(`依赖 "${dependency}" 不在本机目录里 / declared dependency "${dependency}" is not installed here`)
        }
      }

      const preview: SystemPluginInstallPreview = {
        previewToken: staged.transactionId,
        id: manifest.id,
        displayName: manifest.displayName,
        description: manifest.description,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        compatible: checkPluginApiVersion(manifest) === null,
        supportedApiVersions: `${SUPPORTED_PLUGIN_API_RANGE.min}–${SUPPORTED_PLUGIN_API_RANGE.max}`,
        source: source.kind,
        ...(source.kind === 'git' ? { remote: source.remote, commit: staged.resolvedCommit ?? source.commit } : {}),
        ...(source.kind === 'dev' ? { path: path.resolve(source.path) } : {}),
        treeHash: staged.tree.sha256,
        fileCount: staged.tree.files,
        sizeBytes: staged.tree.bytes,
        capabilities: [...manifest.capabilities],
        permissions: [...manifest.permissions],
        dependencies: [...manifest.dependencies],
        hasClient: manifest.client !== undefined,
        ...(manifest.i18n !== undefined
          ? { i18n: { keys: copyAudit.keys, languages: [...PLUGIN_COPY_LANGUAGES] } }
          : {}),
        warnings,
      }
      this.#pending.set(preview.previewToken, { staged, manifest, source, preview })
      return preview
    } catch (error: unknown) {
      await installer.discard(staged).catch(() => {})
      throw error
    }
  }

  /** Throw away a preview's staging. A token the host does not know is not an error. */
  async cancel(previewToken: string): Promise<void> {
    const pending = this.#pending.get(previewToken)
    if (pending === undefined) return
    this.#pending.delete(previewToken)
    const installer = await Installer.create(this.#installRoot)
    await installer.discard(pending.staged)
  }

  /**
   * Promote a previewed package the user consented to.
   *
   * Every echoed field is compared against the record `preview` wrote. A single
   * disagreement discards the whole transaction: a consent is a consent to
   * *these bytes*, and a promotion that accepted three matching fields out of
   * four would be a promotion of bytes nobody agreed to.
   */
  async confirm(params: {
    previewToken: string
    id: string
    commit: string | null
    treeHash: string
  }): Promise<SystemPluginSnapshot> {
    const pending = this.#pending.get(params.previewToken)
    if (pending === undefined) {
      throw installFailed(
        `no staged install for token ${JSON.stringify(params.previewToken)} — it was cancelled, already confirmed, or belongs to a previous run`,
      )
    }
    this.#pending.delete(params.previewToken)
    const installer = await Installer.create(this.#installRoot)
    try {
      if (params.id !== pending.manifest.id) {
        throw installFailed(
          `the confirmation names id ${JSON.stringify(params.id)} but the staged package declares ${JSON.stringify(pending.manifest.id)}`,
        )
      }
      if (params.treeHash !== pending.staged.tree.sha256) {
        throw installFailed(
          `the confirmation names treeHash ${params.treeHash} but the staged tree hashes to ${pending.staged.tree.sha256}`
          + ' — a consent page that saw different bytes cannot approve these',
        )
      }
      const stagedCommit = pending.source.kind === 'git' ? pending.staged.resolvedCommit ?? pending.source.commit : null
      if ((params.commit ?? null) !== stagedCommit) {
        throw installFailed(
          `the confirmation names commit ${String(params.commit)} but the staged tree came from ${String(stagedCommit)}`,
        )
      }
      // §12 ruling 5. A builtin id is refused by name; an id that is merely
      // installed is refused by the installer's own `already-installed` a few
      // lines down, and both surface as `install-failed`, because the answer
      // to "that id is taken" is the same either way and a row that installs,
      // occupies disk and can never activate is the opposite of a named state.
      if (this.#runtime.ids().includes(params.id)) {
        throw installFailed(
          `id 已被占用：本 profile 的插件目录里已经有 "${params.id}" / the id "${params.id}" is already taken in this profile's catalog`,
        )
      }

      const installedAt = new Date().toISOString()
      let record: InstalledPluginRecord
      let hostPath: string
      let clientSourcePath: string | undefined
      let contentDir: string
      if (pending.source.kind === 'git') {
        const result = await installer.promote(pending.staged, params.id)
        record = {
          source: 'git',
          remote: pending.source.remote,
          commit: result.resolvedCommit ?? pending.source.commit,
          treeHash: result.artifactSha256,
          installedAt,
        }
        contentDir = result.targetPath
        hostPath = path.join(result.targetPath, ...pending.manifest.host.split('/'))
        clientSourcePath = pending.manifest.client === undefined
          ? undefined
          : path.join(result.targetPath, ...pending.manifest.client.split('/'))
      } else {
        // The dev tree stays where the user keeps it; staging existed only to
        // run the same contract, containment audit and hash a git package gets.
        await installer.discard(pending.staged)
        const root = path.resolve(pending.source.path)
        record = {
          source: 'dev',
          path: root,
          treeHash: pending.staged.tree.sha256,
          installedAt,
        }
        contentDir = root
        hostPath = path.join(root, ...pending.manifest.host.split('/'))
        clientSourcePath = pending.manifest.client === undefined
          ? undefined
          : path.join(root, ...pending.manifest.client.split('/'))
      }

      if (clientSourcePath !== undefined) await this.#publishClientBundle(params.id, clientSourcePath)
      await this.#publishCopyBundles(params.id, contentDir, pending.manifest)
      return await this.#runtime.adoptInstalled(
        this.#lazyDefinition(pending.manifest, hostPath),
        record,
      )
    } catch (error: unknown) {
      await installer.discard(pending.staged).catch(() => {})
      throw error instanceof AppError ? error : this.#stageFailure(error)
    }
  }

  /**
   * Remove an installed plugin: the tree first, then the row.
   *
   * That order is chosen rather than inherited. A crash between the two leaves
   * a catalog row whose tree is gone, which the next boot names
   * `install-failed` and the user can act on; the other order would leave a
   * tree with no row, and the next boot would re-adopt it — resurrecting a
   * plugin the user just removed, silently. §6's ruling that the tree goes at
   * all is the opposite of ST's (`packages/iris-app-service/src/st-reinstall.ts:1`
   * keeps the tree because the artifact and its settings are user data): a
   * plugin tree is a reproducible read-only product of a `(remote, commit)`
   * pair, so keeping it buys nothing and costs a same-privilege code tree
   * sitting on disk after the user believes they deleted it.
   */
  async uninstall(id: string): Promise<SystemPluginSnapshot> {
    const record = this.#runtime.record(id)
    if (record?.source === 'git') {
      const dir = this.installedDir(id)
      // Renamed aside first: a partially deleted tree that still has its lock
      // would read as an install at the next boot.
      const aside = `${dir}.removing-${createHash('sha256').update(`${id}${String(Date.now())}`).digest('hex').slice(0, 8)}`
      await fsp.rename(dir, aside).catch(() => {})
      await fsp.rm(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
    }
    if (record !== undefined) {
      // The browser bundle is a copy of the package's, never user data: it goes
      // with the package for `dev` rows too.
      await fsp.rm(path.join(this.#clientAssetRoot, id), { recursive: true, force: true }).catch(() => {})
    }
    return await this.#runtime.uninstall(id)
  }

  /**
   * Boot scan: every installed row gets a verdict before any request can name
   * it.
   *
   * `git` rows re-hash their tree and refuse to become runnable when the bytes
   * disagree with the record (§9 #12). `dev` rows skip the hash — that is
   * ruling 1's explicit cost — and are marked `dev` instead. Either way the row
   * exists and carries a name for what is wrong with it; one broken package
   * never takes the plugin plane down.
   */
  async scanInstalled(): Promise<void> {
    for (const { id, record, enabled } of this.#runtime.recordedInstalls()) {
      let failure: SystemPluginFailure | undefined
      try {
        await this.#adoptRecorded(id, record)
      } catch (error: unknown) {
        failure = error instanceof SystemPluginInstallError
          ? error.failure
          : { state: 'install-failed', reason: error instanceof Error ? error.message : String(error) }
      }
      if (failure !== undefined) {
        // The row exists either way. A recorded install whose tree is
        // tampered, gone or unreadable must still appear in `plugin.list` with
        // a name for what is wrong — §1 goal 4 — and a row that vanished
        // instead would leave the user a plugin they cannot see and cannot
        // uninstall, with the id still occupied in the catalog file.
        this.#runtime.adoptDefinition(
          this.#placeholderDefinition(id, failure),
          { installed: true, removable: true },
        )
        this.#runtime.markFailure(id, failure)
        this.#log(`system plugin "${id}" is ${failure.state}: ${failure.reason}`)
        continue
      }
      if (!enabled) continue
      try {
        // The persisted enabled flag is honoured here rather than in
        // `initialize`, because `initialize` runs before any package row
        // exists — it can only activate the definitions the constructor was
        // given. Without this the catalog file would say `enabled: true` and
        // the plugin would silently come back disabled on every restart.
        await this.#runtime.enable(id)
      } catch (error: unknown) {
        this.#log(`system plugin "${id}" was enabled and could not start: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** A catalog row for a package that cannot produce a definition. */
  #placeholderDefinition(id: string, failure: SystemPluginFailure): SystemPluginDefinition {
    return {
      id,
      name: id,
      description: failure.reason,
      version: '0.0.0',
      apiVersion: 1,
      dependencies: [],
      activate: () => {
        // Unreachable through `enable`, which refuses a blocking failure
        // before it orders anything. Kept as the second net: a row that
        // reached activation with no loadable tree behind it must fail, not
        // succeed at doing nothing.
        throw new SystemPluginInstallError(failure, 'internal')
      },
    }
  }

  async #adoptRecorded(id: string, record: InstalledPluginRecord): Promise<void> {
    const root = record.source === 'dev'
      ? record.path
      : this.installedDir(id)
    if (root === undefined) {
      throw installFailed(`the catalog row for "${id}" records a dev source with no path`)
    }
    const stat = await fsp.stat(root).catch(() => null)
    if (stat === null || !stat.isDirectory()) {
      throw installFailed(
        record.source === 'dev'
          ? `the dev directory ${root} is gone — uninstall the row or put the directory back`
          : `the installed tree for "${id}" is missing from ${root}`,
      )
    }

    if (record.source === 'git') {
      const lock = await this.#readLock(id, root)
      // The hash skips `lock.json` because the lock is written *into* the tree
      // after the rename, so it was not part of the bytes the artifact hash was
      // taken over. `hashTree`'s own docblock names this as the reason the skip
      // predicate exists (`packages/iris-extension-installer/src/hash.ts:26`).
      const current = await hashTree(root, rel => rel === LOCK_FILE_NAME).catch((error: unknown) => {
        throw new SystemPluginInstallError({
          state: 'tampered',
          reason: `the installed tree could not be hashed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
      const recorded = record.treeHash ?? lock.artifactSha256
      if (current.sha256 !== recorded || lock.artifactSha256 !== recorded) {
        throw new SystemPluginInstallError({
          state: 'tampered',
          reason: `磁盘上的文件与安装时记录的不符 / the files on disk hash to ${current.sha256}, but the record says ${recorded}`,
        })
      }
    }

    const parsed = await parsePluginManifest(root)
    if (!parsed.ok && parsed.state === 'manifest-invalid') {
      throw new SystemPluginInstallError({ state: 'manifest-invalid', field: parsed.field, reason: parsed.reason })
    }
    if (!parsed.ok) {
      // A plugin that *was* runnable when it was installed and is not any more
      // keeps its row (§3): the catalog says which apiVersion it needs and
      // what this host implements, and the user decides. The refusal carries
      // the parsed manifest, so the row is named after the plugin rather than
      // after its directory.
      throw new SystemPluginInstallError({
        state: 'incompatible',
        field: 'apiVersion',
        reason: parsed.reason,
      })
    }
    const manifest = parsed.manifest
    if (manifest.id !== id) {
      throw new SystemPluginInstallError({
        state: 'manifest-invalid',
        field: 'id',
        reason: `the tree installed as "${id}" declares id ${JSON.stringify(manifest.id)}`,
      })
    }
    if (manifest.client !== undefined) {
      await this.#publishClientBundle(id, path.join(root, ...manifest.client.split('/')))
    }
    await this.#publishCopyBundles(id, root, manifest)
    this.#runtime.adoptDefinition(
      this.#lazyDefinition(manifest, path.join(root, ...manifest.host.split('/'))),
      { installed: true, removable: true },
    )
  }

  async #readLock(id: string, root: string): Promise<InstalledExtensionLock> {
    const lock = await parseLock(root).catch((error: unknown) => {
      throw installFailed(`the lock record for "${id}" is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (lock === null) {
      throw installFailed(`"${id}" has an installed tree with no lock record — it was never a completed install`)
    }
    return lock
  }

  /**
   * The catalog row's definition, with the `import()` deferred into `activate`.
   *
   * Everything the catalog shows — name, description, version, dependencies —
   * comes from the manifest, which was read without executing anything. The
   * package's own code runs for the first time inside `activate`, which is the
   * enable path, under the runtime's existing fiber, lease and rollback
   * machinery. The two failure modes are told apart by *where* they happen and
   * are named accordingly: anything up to and including the default export's
   * shape is `load-failed`, and anything the plugin's own `activate` throws is
   * `activate-failed`.
   */
  #lazyDefinition(manifest: SystemPluginManifest, hostPath: string): SystemPluginDefinition {
    const runtime = this.#runtime
    return {
      id: manifest.id,
      name: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      apiVersion: 1,
      dependencies: [...manifest.dependencies],
      activate: async scope => {
        let loaded: { default?: unknown }
        try {
          loaded = await import(pathToFileURL(hostPath).href) as { default?: unknown }
        } catch (error: unknown) {
          throw markAndThrow(runtime, manifest.id, {
            state: 'load-failed',
            field: 'host',
            reason: `${manifest.host} could not be imported: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        const definition = loaded.default
        if (typeof definition !== 'object' || definition === null) {
          throw markAndThrow(runtime, manifest.id, {
            state: 'load-failed',
            field: 'host',
            reason: `${manifest.host} does not default-export an object — a host module exports one SystemPluginDefinition, not a factory`,
          })
        }
        const exported = definition as Record<string, unknown>
        if (exported.id !== manifest.id) {
          throw markAndThrow(runtime, manifest.id, {
            state: 'load-failed',
            field: 'id',
            reason: `the default export declares id ${JSON.stringify(exported.id)}, but the manifest says ${JSON.stringify(manifest.id)}`,
          })
        }
        if (exported.apiVersion !== manifest.apiVersionParts.major) {
          throw markAndThrow(runtime, manifest.id, {
            state: 'load-failed',
            field: 'apiVersion',
            reason: `the default export declares apiVersion ${String(exported.apiVersion)}, but the manifest says ${manifest.apiVersion}`,
          })
        }
        if (typeof exported.activate !== 'function') {
          throw markAndThrow(runtime, manifest.id, {
            state: 'load-failed',
            field: 'activate',
            reason: 'the default export has no activate function',
          })
        }
        try {
          return await (exported.activate as SystemPluginDefinition['activate'])(scope)
        } catch (error: unknown) {
          throw markAndThrow(runtime, manifest.id, {
            state: 'activate-failed',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }
  }

  /** Copy a package's browser bundle to the one place the asset face serves from. */
  async #publishClientBundle(id: string, sourcePath: string): Promise<void> {
    const dir = path.join(this.#clientAssetRoot, id, 'client')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.copyFile(sourcePath, path.join(dir, CLIENT_BUNDLE))
  }

  /**
   * Copy a package's bundled copy to the one place the asset face serves from.
   *
   * The install path has already audited these files — the contract does it
   * at `stage`, before the tree is hashed — but the boot scan re-publishes
   * from the tree *as it stands now*, and a dev tree may have been edited
   * since. A copy file broken after installation must not take the plugin
   * down: the row stays usable, the broken language is simply not published,
   * and the log names it. A manifest that no longer declares copy removes the
   * published directory, so the asset root stays a projection of the record
   * rather than a museum of earlier versions.
   */
  async #publishCopyBundles(id: string, contentDir: string, manifest: SystemPluginManifest): Promise<void> {
    const dir = path.join(this.#clientAssetRoot, id, 'i18n')
    if (manifest.i18n === undefined) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      return
    }
    await fsp.mkdir(dir, { recursive: true })
    for (const lang of PLUGIN_COPY_LANGUAGES) {
      const source = path.join(contentDir, ...manifest.i18n[lang].split('/'))
      let bytes: Buffer
      try {
        bytes = await fsp.readFile(source)
        JSON.parse(bytes.toString('utf8'))
      } catch (error: unknown) {
        this.#log(`system plugin "${id}" ships an unreadable i18n.${lang} table (${error instanceof Error ? error.message : String(error)}); the copy is not published and the row stays usable`)
        continue
      }
      await fsp.writeFile(path.join(dir, `${lang}.json`), bytes)
    }
  }

  #toExtensionSource(source: PluginInstallSource): ExtensionSource {
    if (source.kind === 'git') {
      refuseEmbeddedCredentials(source.remote)
      return { kind: 'git', repository: source.remote, commit: source.commit }
    }
    return { kind: 'local-directory', directoryPath: path.resolve(source.path) }
  }

  /**
   * Turn an installer refusal into a named row state.
   *
   * The installer's own errors carry a `code` — `bad-repository`,
   * `unpinned-commit`, `head-mismatch`, `git-failed`, `already-installed` — and
   * those are the git steps §8's `failure.step` wants, so they are carried
   * through rather than flattened into prose. A `PluginManifestError` thrown by
   * the artifact contract is unwrapped back into the typed refusal it came
   * from, so a bad `host` path reaches the consent page as
   * `manifest-invalid` at field `host` and not as "the artifact contract threw".
   */
  #stageFailure(error: unknown): SystemPluginInstallError {
    if (error instanceof SystemPluginInstallError) return error
    const state = (error as { state?: unknown }).state
    const field = (error as { field?: unknown }).field
    if (state === 'manifest-invalid' || state === 'incompatible') {
      return new SystemPluginInstallError({
        state,
        ...(typeof field === 'string' ? { field } : {}),
        reason: (error as { reason?: string }).reason ?? String(error),
      })
    }
    const code = (error as { code?: unknown }).code
    return installFailed(
      error instanceof Error ? error.message : String(error),
      typeof code === 'string' ? code : undefined,
    )
  }
}

/**
 * Put the failure on the row, then hand the caller something to throw.
 *
 * The runtime's own catch turns any activation throw into `status: 'error'`
 * with a free-text message; the typed `failure` has to be recorded before that
 * happens, or the row would say "error" with no name for which of the six it
 * is — and §1's fourth goal is that every failure has a name a user can act on.
 */
function markAndThrow(runtime: SystemPluginRuntime, id: string, failure: SystemPluginFailure): Error {
  runtime.markFailure(id, failure)
  return new SystemPluginInstallError(failure, 'internal')
}

export { isValidExtensionId }
