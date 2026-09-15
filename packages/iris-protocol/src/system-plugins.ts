/**
 * Where a catalog row's bytes came from.
 *
 * `builtin` ships with Iris; `git` was fetched from an https remote pinned to
 * a full commit and promoted into `<profile>/system-plugins/installed/<id>/`;
 * `dev` is a directory on the user's own disk, loaded in place.
 *
 * `dev` is the one source whose bytes are never re-verified against a recorded
 * hash — that is the whole point of it, and the cost the owner accepted on
 * 2026-09-15 (`docs/SYSTEM-PLUGIN-INSTALL.md` §12 ruling 1) by requiring the
 * marker to appear everywhere a row does. So this field is not decoration:
 * it is the disclosure that pays for the missing check.
 */
export type SystemPluginSource = 'builtin' | 'git' | 'dev'

/**
 * The seven named ways a system plugin row can carry a fault.
 *
 * Every one of them is a row the user can see and act on
 * (`docs/SYSTEM-PLUGIN-INSTALL.md` §1 goal 4); none of them is a crash, and
 * none of them removes the row. The set is closed and ordered by the stage it
 * belongs to: `install-failed` and `manifest-invalid` happen before anything is
 * promoted, `incompatible` and `tampered` before anything is imported, and
 * `load-failed` and `activate-failed` are the two halves of actually running
 * the plugin's own code.
 *
 * `hook-failed` is the seventh and the odd one out on two counts. It is not a
 * stage of reaching `enabled` at all: it records that a *running* plugin's one
 * contribution to a reply settlement — its variable write — threw or timed out,
 * so it is the only state that rides on an `enabled: true, status: 'enabled'`
 * row. And it is momentary by design, cleared by the plugin's own next
 * successful write, where every other state stands until the user (or a fresh
 * boot re-derivation) acts on it.
 */
export type SystemPluginFailureState =
  | 'install-failed'
  | 'manifest-invalid'
  | 'incompatible'
  | 'tampered'
  | 'load-failed'
  | 'activate-failed'
  | 'hook-failed'

/** Why a row is not runnable, in the shape the plugin center renders. */
export interface SystemPluginFailure {
  state: SystemPluginFailureState
  /** `manifest-invalid` / `load-failed`: the offending field, dotted and indexed. */
  field?: string
  /** `install-failed`: which git step refused (`init`/`fetch`/`checkout`/`rev-parse`). */
  step?: string
  /** Human-readable detail. Never carries a credential. */
  reason: string
}

/** What the host recorded about an installed tree at the moment it was installed. */
export interface SystemPluginProvenance {
  /** `git`: the https remote the tree was fetched from. */
  remote?: string
  /** `git`: the full 40-hex commit the fetch was pinned to. */
  commit?: string
  /** `dev`: the absolute directory the plugin is loaded from, in place. */
  path?: string
  /** 64-hex canonical tree hash (`hashTree`), recorded at install and re-checked on every boot for `git`. */
  treeHash?: string
  /** ISO timestamp of the promotion. */
  installedAt?: string
}

/**
 * One catalog entry together with its profile-local runtime state.
 *
 * `id` is an open string, deliberately not a union of the builtin names: an ST
 * extension adopted through the host's `adoptDefinition` handshake arrives
 * with an id of its own, and a catalog row must hold that id beside the
 * builtins without a cast.
 *
 * The last three fields are **optional and additive** (PR-2 of
 * `docs/SYSTEM-PLUGIN-INSTALL.md` §10). The nine that precede them, the
 * six-value `status` union and the free-text `error` are untouched, so an older
 * browser ignores the new keys and renders exactly what it rendered before, and
 * an older host's snapshot still parses here. `failure` refines the row's
 * lifecycle state: for six of the seven states it is a *refinement* of
 * `status: 'error'`, never a replacement — a `tampered` or `incompatible` row
 * is `installed: true, enabled: false, status: 'error'`, and `failure.state` is
 * what lets the interface pick the right sentence. The seventh, `hook-failed`,
 * is the one exception: it rides on a healthy `enabled: true,
 * status: 'enabled'` row, because a variable write that failed this turn says
 * nothing about whether the plugin itself runs.
 */
export interface SystemPluginView {
  id: string
  name: string
  description: string
  version: string
  apiVersion: 1
  dependencies: string[]
  installed: boolean
  enabled: boolean
  status: 'not-installed' | 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error'
  error?: string
  source?: SystemPluginSource
  provenance?: SystemPluginProvenance
  failure?: SystemPluginFailure
}

/** Authoritative state of the profile's registered system-plugin catalog. */
export interface SystemPluginSnapshot {
  revision: number
  plugins: SystemPluginView[]
}

/**
 * When a preview is an update of an installed row, the row it replaces.
 *
 * Only `plugin.update` mints previews carrying this field; a preview from
 * `plugin.previewInstall` never has it, so its presence is the protocol-level
 * statement "the user is consenting to a replacement, not a fresh install".
 * The field is **display and intent**, not authorization: the host decides
 * whether a confirm is an update from its own transaction record
 (`docs/SYSTEM-PLUGIN-INSTALL.md` §5.4), never from what the echo claims.
 */
export interface SystemPluginUpdateOf {
  /** The catalog row being replaced. Equal to this preview's `id`. */
  id: string
  /** The commit the row records today. */
  fromCommit: string
  /** The treeHash the row records today. */
  fromTreeHash: string
}

/**
 * What a staged-but-not-installed package says about itself, for the consent
 * step (`docs/SYSTEM-PLUGIN-INSTALL.md` §5.1).
 *
 * Everything here was read out of a tree that is already on this machine, in
 * staging, hashed — not out of a remote that might answer differently next
 * time. That is what makes the two-step handshake worth its complexity: the
 * `treeHash` the user approves is the hash of the bytes that get promoted, and
 * `plugin.confirmInstall` compares the echo against the **transaction record**
 * rather than fetching anything again.
 *
 * **`hasClient` and not a member list.** §5.1's sketch also promised
 * `clientMembers`, the names a `client.js` registers, so the consent page could
 * warn about a clash. The scanner that produces them —
 * `scanPluginMemberNames` (`apps/iris-web/src/app/use-plugin-manifest.ts:208`)
 * — is a browser-app module reading a bundle the browser is about to load, and
 * the host cannot import it without pulling the web app into app-service. The
 * scan already happens where it belongs and refuses **per plugin, not per
 * frame** (`apps/iris-web/src/sandbox/plugin-members.ts:13`), so the host
 * reports whether a bundle exists and leaves the names to the side that reads
 * them. Recorded in `notes/packages/iris-app-service/DEVIATIONS.md` §80.
 */
export interface SystemPluginInstallPreview {
  /**
   * The handle `plugin.confirmInstall` and `plugin.cancelInstall` name.
   *
   * It is the install transaction's own id, which is what the promotion
   * compares against; a token the host does not recognise is a refusal, and a
   * cancelled or already-confirmed token is not recognised.
   */
  previewToken: string
  /** From the package's `iris.plugin.id`; the id the row will occupy. */
  id: string
  displayName: string
  description: string
  /** The package's own `version` field. */
  version: string
  /** Normalized `major.minor`, so the integer spelling `1` reads as `1.0`. */
  apiVersion: string
  /** Whether `apiVersion` is inside this host's supported range. */
  compatible: boolean
  /** The range this host implements, as `min–max`, for the sentence the page shows. */
  supportedApiVersions: string
  source: 'git' | 'dev'
  remote?: string
  commit?: string
  path?: string
  /** 64-hex; the hash of exactly the bytes that would be promoted. */
  treeHash: string
  fileCount: number
  sizeBytes: number
  /** Free-form: what the author says the plugin provides. The host has no registry to check it against. */
  capabilities: string[]
  /** Closed vocabulary: what the author says the plugin uses. A declaration the host spell-checks and shows, never a boundary it enforces. */
  permissions: string[]
  dependencies: string[]
  hasClient: boolean
  /**
   * The package's bundled interface copy, present only when the manifest
   * declares it: how many strings, in which languages. The languages are
   * fixed at two today; the audit of the copy happens before this page, so
   * the field states what the package carries and promises nothing else.
   */
  i18n?: { keys: number, languages: string[] }
  /** Things the user should see before consenting that are not refusals — a dependency this profile does not have, an id already taken. */
  warnings: string[]
  /** Present only when this preview was minted by `plugin.update` for an installed row (§5.4); a fresh-install preview omits it. */
  updateOf?: SystemPluginUpdateOf
}
