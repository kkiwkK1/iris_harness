/**
 * The system-plugin state captured by one sandbox incarnation — the browser
 * half of the plugin contract, the counterpart of `@iris/plugin-api` on the
 * host side.
 *
 * Frames never read the live store. A run is born against one host revision
 * and keeps that revision for every request it can schedule later; changing
 * the host snapshot destroys the run and creates another one. This small value
 * is also written into the srcdoc so parse-time interface code and the shell
 * agree about which optional facades exist.
 *
 * The module moved here from `apps/iris-web/src/sandbox/system-plugin-runtime.ts`
 * because its two readers live in different bundles: the shell writes the
 * snapshot into the srcdoc (`encodeSandboxPluginRuntime`), and the frame's
 * bootstrap parses it back out of the meta element
 * (`parseSandboxPluginRuntime`) — different bundles, both built from source,
 * with nothing but the string in a `name="…"` attribute between them. The
 * type, the meta name and the codec therefore live together, so they cannot
 * drift into a snapshot one side writes and the other refuses: the same ground
 * `@iris/compat-tavernhelper-core` holds the verbatim event tables on. The
 * reduction from the host's authoritative catalog is here too
 * (`sandboxPluginRuntime`), because the rule it encodes — MVU is only usable
 * when Tavern Helper is, since the MVU integration rides on the helper's
 * card-facing API — is contract, not a shell detail.
 *
 * Dependencies, by contract: the Iris contract, as types only. `import type`
 * is erased before the browser sees this module, so importing it drags
 * nothing in behind it — the ground `@iris/text` and
 * `@iris/compat-tavernhelper-core` hold their places on the browser's import
 * allowlist on (`apps/iris/tests/architecture.test.ts`), and a source scan
 * pins the rule (`tests/purity.test.ts`).
 *
 * @module @iris/plugin-web-api
 */
import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'

/**
 * Capabilities and revision fixed for one frame lifetime.
 *
 * `plugins` is the third-party half of the snapshot: one row per plugin whose
 * members this incarnation admits, carrying the same rev-keyed URL the
 * aggregate manifest serves. The built-in booleans stay separate fields —
 * they are the compatibility FACE ("is the Tavern Helper surface assembled"),
 * where `plugins` is presence ("who else is in this frame"), and the two
 * read differently (`notes/PLUGIN-CONTRACT-LANDING-SITES.md` §3: the boolean
 * gates in the frame are not generalized away). An empty record is the
 * normal state: every frame whose profile has no third-party plugins
 * installed.
 */
export interface SandboxPluginRuntime {
  revision: number
  tavernHelper: boolean
  mvu: boolean
  plugins: Record<string, PluginAssetEntry>
}

/** Metadata name shared by the srcdoc writer and bootstrap reader. */
export const SYSTEM_PLUGIN_RUNTIME_META = 'iris-system-plugins'

/** Legacy direct builders behave like an existing profile with both built-ins enabled. */
export const DEFAULT_SANDBOX_PLUGIN_RUNTIME: SandboxPluginRuntime = Object.freeze({
  revision: 0,
  tavernHelper: true,
  mvu: true,
  plugins: Object.freeze({}),
})

/** A plugin is usable only after its runtime transition has completed. */
function running(plugin: SystemPluginView | undefined): boolean {
  return plugin?.installed === true && plugin.enabled === true && plugin.status === 'enabled'
}

/**
 * Reduce the authoritative catalog to the capabilities a sandbox understands.
 *
 * @param snapshot - the host's authoritative catalog and revision.
 * @param assets - the aggregate manifest as the shell fetched it, supplying
 *   the rev-keyed URLs a wire snapshot does not carry. The snapshot stays the
 *   authority on **whether** a plugin is in; the manifest is only consulted
 *   **where** its bytes live — a row for a plugin the snapshot does not run
 *   is dropped, and a running plugin without a row is admitted without one
 *   (its members, if any ever arrive, would be the next revision's problem;
 *   a frame must never learn a URL the host did not publish for it).
 * @returns the snapshot for one frame, or `undefined` when there is no host.
 */
export function sandboxPluginRuntime(
  snapshot: SystemPluginSnapshot | undefined,
  assets?: PluginAssetManifest,
): SandboxPluginRuntime | undefined {
  if (snapshot === undefined) return undefined
  const tavernHelper = running(snapshot.plugins.find(plugin => plugin.id === 'tavern-helper'))
  const mvu = tavernHelper && running(snapshot.plugins.find(plugin => plugin.id === 'mvu'))
  const plugins: Record<string, PluginAssetEntry> = {}
  if (assets !== undefined) {
    for (const plugin of snapshot.plugins) {
      if (!running(plugin)) continue
      const entry = assets.plugins[plugin.id]
      if (entry !== undefined) plugins[plugin.id] = entry
    }
  }
  return { revision: snapshot.revision, tavernHelper, mvu, plugins }
}

/** Encode the capability snapshot for a metadata attribute. */
export function encodeSandboxPluginRuntime(runtime: SandboxPluginRuntime): string {
  return JSON.stringify(runtime)
}

/** Parse the capability snapshot before the sandbox installs. */
export function parseSandboxPluginRuntime(value: string | null | undefined): SandboxPluginRuntime {
  let parsed: unknown
  try {
    parsed = value === null || value === undefined ? undefined : JSON.parse(value)
  } catch {
    throw new Error('iris sandbox: the system-plugin snapshot is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('iris sandbox: the frame was built without a system-plugin snapshot')
  }
  const bag = parsed as Record<string, unknown>
  if (
    typeof bag['revision'] !== 'number'
    || !Number.isSafeInteger(bag['revision'])
    || bag['revision'] < 0
    || typeof bag['tavernHelper'] !== 'boolean'
    || typeof bag['mvu'] !== 'boolean'
  ) {
    throw new Error('iris sandbox: the system-plugin snapshot has an invalid shape')
  }
  if (bag['mvu'] && !bag['tavernHelper']) {
    throw new Error('iris sandbox: MVU cannot be enabled without Tavern Helper')
  }
  return {
    revision: bag['revision'],
    tavernHelper: bag['tavernHelper'],
    mvu: bag['mvu'],
    plugins: parsePluginRows(bag['plugins']),
  }
}

/**
 * The snapshot's plugin rows, absent tolerated.
 *
 * Absent parses as an empty record, not a refusal: a shell built before the
 * third-party half existed writes metas without the field, and a frame must
 * not refuse every card on the machine because its shell predates it — the
 * reverse order (new shell, old bootstrap) is refused by the bootstrap
 * needing the markers it was built to read. A **present** field is held to
 * the full contract, because a half-valid row would name a plugin whose
 * members the frame then trusts without knowing where its bytes came from.
 */
function parsePluginRows(value: unknown): Record<string, PluginAssetEntry> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('iris sandbox: the system-plugin snapshot has an invalid plugins record')
  }
  const rows: Record<string, PluginAssetEntry> = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`iris sandbox: the snapshot row for plugin "${id}" has an invalid shape`)
    }
    const { rev, client } = entry as Record<string, unknown>
    if (typeof rev !== 'string' || !/^[0-9a-f]{12}$/.test(rev)) {
      throw new Error(`iris sandbox: the snapshot row for plugin "${id}" has an invalid rev`)
    }
    if (typeof client !== 'string' || !client.startsWith(`${PLUGIN_ASSET_PREFIX}/`)) {
      throw new Error(`iris sandbox: the snapshot row for plugin "${id}" has a client URL outside ${PLUGIN_ASSET_PREFIX}`)
    }
    rows[id] = { rev, client }
  }
  return rows
}

/** Attach the frame's immutable revision to a host-bound action payload. */
export function fenceFrameParams(params: unknown, revision: number): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return params
  return { ...(params as Record<string, unknown>), pluginRevision: revision }
}

/**
 * The pathname prefix every plugin-asset URL lives under.
 *
 * The same literal the host route is mounted at and the frame's plugin tags
 * are built from, stated once here so the two cannot spell it differently —
 * the same ground `SYSTEM_PLUGIN_RUNTIME_META` holds the meta name on. Fixed,
 * not configurable, for that reason: a prefix both sides must agree on is a
 * contract, and a contract with a per-deployment override is two contracts.
 */
export const PLUGIN_ASSET_PREFIX = '/plugins'

/** Where the aggregate plugin-asset manifest is served. */
export const PLUGIN_ASSET_MANIFEST_PATH = `${PLUGIN_ASSET_PREFIX}/manifest.json`

/** One enabled plugin's browser face, as the aggregate manifest states it. */
export interface PluginAssetEntry {
  /**
   * Content rev of the client bundle: sha1 of its bytes, first 12 hex
   * characters — the shape dsh's own client-module routes use, so bundles
   * and manifests composed by either half interoperate.
   */
  rev: string
  /** The bundle's URL, rev included as its cache-busting query. */
  client: string
}

/**
 * What {@link PLUGIN_ASSET_MANIFEST_PATH} answers: the host composing its
 * plugin install directory with the control plane's current snapshot.
 *
 * Keyed by plugin id and holding only plugins that are enabled **and** have a
 * client bundle on disk, so the manifest is the enable state made fetchable —
 * a plugin that is disabled, or whose bundle is absent, has no row, and a
 * frame holding an older manifest ages out with the `revision` the runtime
 * already broadcasts through `plugins.changed`.
 *
 * Deliberately **not** a fifth key in the build's own `manifest.json`
 * (`apps/iris-web/src/sandbox/asset-manifest.ts`): that manifest is a
 * build-time artifact whose fixed keys three build tools consume by name
 * (`apps/iris-web/tools/hash-sandbox-assets.mjs`, `prune-sandbox-assets.mjs`,
 * `check-bootstrap.mjs`), and letting runtime state into it would make
 * those tools consumers of plugin installs. Two manifests, two gates, no
 * shared prefix — the pruning tool's `<key>-<hash>` name rule must never meet
 * a runtime-composed row.
 */
export interface PluginAssetManifest {
  /** The system-plugin runtime revision this enabled set was read at. */
  revision: number
  /** Enabled plugins that have a client bundle, keyed by plugin id. */
  plugins: Record<string, PluginAssetEntry>
}

/**
 * Parse one {@link PLUGIN_ASSET_MANIFEST_PATH} response body.
 *
 * Held to the same reading the snapshot's row parser applies — a rev is twelve
 * hex characters and a client URL lives under the prefix — because the shell
 * copies manifest rows into frame metas verbatim, and a row that would be
 * refused in a meta must be refused before it gets there. Returns the reason
 * as a string rather than throwing, so a caller formatting a fetch error can
 * name both the URL and the cause in one sentence.
 */
export function parsePluginAssetManifest(text: string): PluginAssetManifest | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'the body is not valid JSON'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the body is not an object'
  }
  const bag = parsed as Record<string, unknown>
  if (typeof bag['revision'] !== 'number' || !Number.isSafeInteger(bag['revision']) || bag['revision'] < 0) {
    return 'the revision is not a nonnegative safe integer'
  }
  const rows = bag['plugins']
  if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) {
    return 'the plugins record is not an object'
  }
  const plugins: Record<string, PluginAssetEntry> = {}
  for (const [id, entry] of Object.entries(rows as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `the row for plugin "${id}" is not an object`
    }
    const { rev, client } = entry as Record<string, unknown>
    if (typeof rev !== 'string' || !/^[0-9a-f]{12}$/.test(rev)) {
      return `the row for plugin "${id}" has an invalid rev`
    }
    if (typeof client !== 'string' || !client.startsWith(`${PLUGIN_ASSET_PREFIX}/`)) {
      return `the row for plugin "${id}" has a client URL outside ${PLUGIN_ASSET_PREFIX}`
    }
    plugins[id] = { rev, client }
  }
  return { revision: bag['revision'], plugins }
}
