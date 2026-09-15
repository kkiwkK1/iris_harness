/**
 * The artifact contract: what a staged tree must contain before the installer
 * will promote it.
 *
 * Everything else in this package is artifact-blind. `source` knows transports,
 * `archive` knows hostile names, `hash` knows bytes, `lock` knows the record,
 * `staging`/`transaction`/`recovery` know the state machine — none of them has
 * ever read a field out of an installed tree. Exactly one gate did: the
 * `manifest.json` + `js` check that used to sit inside `installer.ts` as a
 * private `requireManifest`, which is the SillyTavern extension's package
 * format and nothing else's. That one function is what made an
 * artifact-neutral installer an *ST extension* installer.
 *
 * It is now a value. A caller that installs a different kind of artifact
 * passes its own `ArtifactContract`; the transaction, the guards, the hash and
 * the lock are shared, and the only thing that varies is the sentence "this is
 * a well-formed X". Forking the package to install a second artifact kind
 * would have duplicated all seven artifact-blind modules, and duplicated
 * security invariants rot one copy at a time.
 *
 * Two properties of the seam, both deliberate:
 *
 *  - **The contract runs where the old gate ran** — between the staged and
 *    validated phases, before `auditContainment`, before the hash, before the
 *    claim. So a contract refusal costs the same as it always did: staging is
 *    removed, the target root is never touched.
 *  - **The contract never executes the artifact.** It reads files. That is the
 *    module-level invariant `installer.ts` states for the whole package, and
 *    an injected contract is inside it, not an exception to it.
 *
 * The default is the ST contract. Not because the installer still belongs to
 * ST, but because every caller that exists today passed it implicitly, and a
 * generalization that silently *removes* a gate from callers who did not ask
 * is not a generalization. The seam is the replaceability, not the default.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ArchiveSecurityError } from './archive.ts'

/**
 * One artifact format's admission rule.
 *
 * `validate` throws to refuse — the installer's failure path is exception-
 * shaped end to end (`SourceError`, `ArchiveSecurityError`,
 * `InstallClaimBusyError`), and a contract that returned a result would be the
 * only refusal in the package that a caller could forget to read. A contract
 * whose own parser is result-shaped converts at this boundary; see
 * `SYSTEM_PLUGIN_ARTIFACT_CONTRACT` in `@iris/app-service`, whose
 * `parsePluginManifest` returns a typed result and whose `validate` throws it.
 *
 * `name` is the describer half: it names the format in a refusal, so a tree
 * refused by the wrong contract says which contract refused it rather than
 * only what it lacked.
 */
export interface ArtifactContract {
  /** Stable identifier of the artifact format, used in refusals. */
  readonly name: string
  /** Refuses by throwing; returns when the staged tree satisfies the format. */
  validate(contentDir: string): Promise<void>
}

/**
 * The manifest/entry gate every source passes, whatever the transport: an
 * install must contain a manifest.json whose `js` entry names a relative
 * in-tree file that exists. A git checkout is held to exactly the same
 * contract as an unpacked archive or a copied directory — the analyzer's
 * contract is with the artifact, not the transport, so there is no git
 * exemption. Full normalization and module analysis are the analyzer
 * package's job; the installer only refuses to promote something that could
 * not even be described to the analyzer.
 *
 * Moved here from `installer.ts` unchanged — same checks in the same order,
 * same `ArchiveSecurityError` codes, same messages — because the ST install
 * path's observable behaviour is not part of what this change is allowed to
 * move.
 */
async function requireStExtensionManifest(content: string): Promise<void> {
  const raw = await fsp.readFile(path.join(content, 'manifest.json'), 'utf8').catch(() => {
    throw new ArchiveSecurityError('artifact has no manifest.json — nothing to analyze, refusing to promote', 'missing-manifest')
  })
  let manifest: unknown
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new ArchiveSecurityError('manifest.json is not valid JSON', 'bad-manifest')
  }
  const js = (manifest as { js?: unknown }).js
  if (typeof js !== 'string' || js.length === 0) {
    throw new ArchiveSecurityError('manifest.json declares no js entry', 'bad-manifest')
  }
  if (js.includes('\\') || js.includes('..') || path.isAbsolute(js) || /^[a-zA-Z]:/u.test(js)) {
    throw new ArchiveSecurityError(`manifest js entry ${JSON.stringify(js)} is not a relative in-tree path`, 'bad-manifest')
  }
  const entry = path.join(content, ...js.split('/'))
  const st = await fsp.lstat(entry).catch(() => null)
  if (!st?.isFile()) {
    throw new ArchiveSecurityError(`manifest js entry ${js} does not exist in the artifact`, 'bad-manifest')
  }
}

/** The SillyTavern extension format: `manifest.json` with a `js` entry that exists in the tree. */
export const ST_EXTENSION_ARTIFACT_CONTRACT: ArtifactContract = {
  name: 'st-extension',
  validate: requireStExtensionManifest,
}
