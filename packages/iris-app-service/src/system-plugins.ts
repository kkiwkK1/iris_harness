import { readFile } from 'node:fs/promises'

import { Context, type Fiber } from '@deepseek-ai/cordis'
import {
  registerRequestSchema,
  type SystemPluginFailure,
  type SystemPluginFailureState,
  type SystemPluginProvenance,
  type SystemPluginSnapshot,
  type SystemPluginSource,
  type SystemPluginView,
} from '@iris/protocol'
import type {
  PluginStorage,
  ScopedPluginRevision,
  ScopedRequestSchema,
  SystemPluginActivationScope,
  SystemPluginDefinition,
  SystemPluginLease,
  SystemPluginRuntimeOptions,
  VariableWriter,
} from '@iris/plugin-api'
import type { RpcError } from '@iris/protocol'

import { atomicWriteFile } from './atomic.ts'
import { AppError } from './errors.ts'
import { MVU_PLUGIN_ID, TAVERN_HELPER_PLUGIN_ID } from './plugins/builtins.ts'
import { PLUGIN_PERMISSIONS } from './plugins/manifest.ts'
import { PluginDataStore } from './plugins/storage.ts'

/*
 * The plugin contract lives in `@iris/plugin-api` — definition, activation
 * scope, lease and runtime options. It moved there from this file, which was
 * the transition site named in `notes/SYSTEM-PLUGINS-HANDOFF.md`; the
 * re-export below keeps this module's own surface (and the tests that import
 * through it) on the one definition instead of growing a second one.
 */
export type {
  ScopedPluginRevision,
  ScopedRequestSchema,
  SystemPluginActivationScope,
  SystemPluginDefinition,
  SystemPluginLease,
  SystemPluginRuntimeOptions,
  VariableWriter,
}

const SERVICE_PREFIX = 'iris.system-plugin'

/**
 * The catalog file's current version.
 *
 * Raised from 1 to 2 by PR-2 of `docs/SYSTEM-PLUGIN-INSTALL.md`, and
 * deliberately *not* done as "add optional keys, stay at 1". §6 argues the
 * direction: a v1-reading binary handed a file whose rows carry a `treeHash`
 * it has never heard of would activate those rows anyway, including the ones
 * it cannot re-verify. Under version 2 it cannot read the file at all and
 * takes `initialize`'s existing unreadable-file path — retain the bytes,
 * disable everything, every row `error`. For a feature whose whole point is
 * refusing to run bytes that changed, refusing *everything* is the safe
 * direction.
 */
const STORED_VERSION = 2

/** The versions this reader accepts. Anything else is an unreadable file. */
const READABLE_VERSIONS = new Set([1, STORED_VERSION])

interface StoredPluginPreference {
  installed: boolean
  enabled: boolean
  /** v2. Absent on a row this host has no provenance for (a legacy adopted ST extension). */
  source?: SystemPluginSource
  /** v2, `git`: the https remote. */
  remote?: string
  /** v2, `git`: the full 40-hex commit. */
  commit?: string
  /** v2, `dev`: the absolute directory the plugin is loaded from in place. */
  path?: string
  /** v2: the canonical tree hash recorded at install; re-checked every boot for `git`. */
  treeHash?: string
  /** v2: ISO timestamp of the promotion. */
  installedAt?: string
}

/** The provenance half of a stored row, as the install path hands it over. */
export interface InstalledPluginRecord {
  source: SystemPluginSource
  remote?: string
  commit?: string
  path?: string
  treeHash?: string
  installedAt?: string
}

interface StoredSystemPlugins {
  version: 1 | 2
  revision: number
  plugins: Record<string, StoredPluginPreference>
}

/**
 * Failure states that make `enable` a refusal rather than an attempt.
 *
 * `load-failed` and `activate-failed` are deliberately absent: those two are
 * the plugin's own code misbehaving, the author fixes the file and tries
 * again, and §8's copy for them is "修好后重试启用或卸载". The four listed here
 * are facts about the install that no retry can change without a new install —
 * so a retry that re-imported the tree would be a retry that could succeed
 * against tampered bytes. The seventh state, `hook-failed`, belongs in neither
 * bucket: it is not a stage of reaching `enabled` at all (it rides on an
 * enabled row) and it clears itself on the plugin's next successful write, so
 * it must neither block nor survive an enable.
 */
const ENABLE_BLOCKING_FAILURES: ReadonlySet<SystemPluginFailureState> = new Set([
  'install-failed',
  'manifest-invalid',
  'incompatible',
  'tampered',
])

interface RuntimePlugin {
  definition: NormalizedDefinition
  installed: boolean
  enabled: boolean
  status: SystemPluginView['status']
  error: string | undefined
  activation: Activation | undefined
  incarnation: number
  /**
   * Whether `uninstall` removes the catalog row itself, not just its installed
   * flag.
   *
   * False for everything that was here before this round: a builtin is always
   * in the catalog (uninstalling it means "do not run it", and the row must
   * stay so it can be reinstalled), and an adopted ST extension keeps its row
   * because ST's uninstall keeps the tree too (`st-reinstall.ts:18` — the
   * artifact and the settings are user data, and the same id arriving again is
   * a *reinstall*). True only for a row this round's install path created,
   * where the opposite ruling holds (§6): the tree is deleted, so a row
   * pointing at a tree that no longer exists would be a lie.
   */
  removable: boolean
}

interface Activation {
  fiber: Fiber
  incarnation: number
  revision: number
  disposalError?: Error
}

/** One variable writer in the settlement order, flattened out of the registry. */
export interface RegisteredVariableWriter {
  pluginId: string
  writer: VariableWriter
}

interface NormalizedDefinition extends Omit<SystemPluginDefinition, 'dependencies'> {
  dependencies: readonly string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function serviceName(pluginId: string, capability: string): string {
  return `${SERVICE_PREFIX}:${pluginId}:${capability}`
}

/** The whole vocabulary — what a builtin's activation may assume was declared. */
const ALL_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set<string>(PLUGIN_PERMISSIONS)

/**
 * A storage face whose every method answers the same named refusal.
 *
 * The scope's `storage` member stays non-optional even when the host cannot
 * or will not provide a working store: an absent member would push
 * `scope.storage?.` into every plugin and leave the author unable to tell
 * "I did not declare the permission" from "this host is too old to have the
 * member at all". A face that throws says which of the two it is.
 */
function refusedStorage(code: RpcError['code'], message: string): PluginStorage {
  const refuse = (): never => { throw new AppError(code, message) }
  return {
    get: async () => refuse(),
    set: async () => refuse(),
    delete: async () => refuse(),
    keys: async () => refuse(),
  }
}

/**
 * What `registerRpc` needs of the transport: `IrisRpcHost.register`'s shape.
 *
 * Structural on purpose — this module names what it calls, not which package
 * provides it, the same way the capability face reads values back with
 * `context.get`. Production resolves the real service under `'irisRpc'`; a
 * test provides a stub the same way plugin capabilities are provided.
 */
interface RpcRegistrar {
  register(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void
}

const STORED_SOURCES: ReadonlySet<string> = new Set<SystemPluginSource>(['builtin', 'git', 'dev'])

function optionalString(row: Record<string, unknown>, key: string): boolean {
  return row[key] === undefined || typeof row[key] === 'string'
}

function validPreference(value: unknown): value is StoredPluginPreference {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (typeof row['installed'] !== 'boolean' || typeof row['enabled'] !== 'boolean') return false
  // The v2 keys are type-checked when present rather than tolerated as
  // unknown extras. A row whose `treeHash` is a number is not a row with a
  // missing hash: it is a file this host cannot act on, and reading it as
  // "no hash recorded" would silently retire the re-verification this version
  // exists to add.
  if (row['source'] !== undefined && (typeof row['source'] !== 'string' || !STORED_SOURCES.has(row['source']))) return false
  for (const key of ['remote', 'commit', 'path', 'treeHash', 'installedAt']) {
    if (!optionalString(row, key)) return false
  }
  return true
}

function parseStored(value: unknown): StoredSystemPlugins | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const version = row['version']
  if (typeof version !== 'number' || !READABLE_VERSIONS.has(version)) return undefined
  if (!Number.isSafeInteger(row['revision']) || (row['revision'] as number) < 0) return undefined
  const plugins = row['plugins']
  if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined
  for (const preference of Object.values(plugins)) {
    if (!validPreference(preference)) return undefined
  }
  return {
    version: version as 1 | 2,
    revision: row['revision'] as number,
    plugins: plugins as Record<string, StoredPluginPreference>,
  }
}

function provenanceOf(preference: StoredPluginPreference | undefined): SystemPluginProvenance | undefined {
  if (preference === undefined) return undefined
  const provenance: SystemPluginProvenance = {
    ...(preference.remote !== undefined ? { remote: preference.remote } : {}),
    ...(preference.commit !== undefined ? { commit: preference.commit } : {}),
    ...(preference.path !== undefined ? { path: preference.path } : {}),
    ...(preference.treeHash !== undefined ? { treeHash: preference.treeHash } : {}),
    ...(preference.installedAt !== undefined ? { installedAt: preference.installedAt } : {}),
  }
  return Object.keys(provenance).length === 0 ? undefined : provenance
}

/**
 * Owns one profile's system-plugin catalog and live Cordis child fibers.
 *
 * Every public transition is serialized. Disabling first closes admission,
 * then drains work already admitted, then disposes the implementation. Thus a
 * resolved disable guarantees that no operation from the old incarnation can
 * later commit.
 */
export class SystemPluginRuntime {
  readonly #context: Context
  readonly #file: string
  readonly #plugins = new Map<string, RuntimePlugin>()
  readonly #listeners = new Set<(snapshot: SystemPluginSnapshot) => void>()
  readonly #onError: (error: Error) => void
  readonly #writePreferences: (file: string, contents: string) => Promise<void>
  readonly #defaultEnabled: ReadonlySet<string>
  readonly #persisted = new Map<string, StoredPluginPreference>()
  readonly #leases = new Map<string, { count: number, waiters: Set<() => void> }>()
  /**
   * Variable writers by plugin id, one array per id in registration order.
   *
   * Two kinds of caller share the one registry: a plugin, through its
   * activation scope (the id is its own definition's, and disposal of the
   * activation removes the writer), and the host itself, for a reply plane it
   * owns whose id names no catalog row — the ST-compat pilot serves the
   * extension under its installed id, and the host registers the bridge's
   * floor writer under that same id. That is why a registered id is allowed to
   * have no row: `orderedVariableWriters` keeps such a writer and leaves its
   * on/off state to the plane it belongs to, while a writer whose id *does*
   * name a row participates only while the row is enabled — which is what
   * makes "disable a writer, its proposals disappear" true by construction.
   */
  readonly #variableWriters = new Map<string, VariableWriter[]>()
  /**
   * Ids that came from the constructor's definition list — the bundled ones.
   *
   * Kept as its own set rather than inferred later, because "was this id here
   * before anything was adopted?" stops being answerable the moment the boot
   * scan starts adopting. It answers two questions: which rows a v1→v2 upgrade
   * may honestly stamp `source: 'builtin'`, and which ids the install path
   * refuses at confirm (§12 ruling 5).
   */
  readonly #builtinIds = new Set<string>()
  /**
   * The named failure on a row, when it has one. Not persisted: the six
   * install/lifecycle states are re-derived at boot from the tree and the
   * record, and a stored failure would be a claim about bytes that may since
   * have been fixed. `hook-failed` is the exception that proves the rule — it
   * is a settlement-time fact about a running plugin, not a verdict on its
   * bytes, so there is nothing at boot to re-derive it from and a new process
   * simply starts with a clean slate.
   */
  readonly #failures = new Map<string, SystemPluginFailure>()
  /**
   * The permissions each adopted *package* declared in its manifest, filled
   * by whoever adopted it with the manifest in hand — the boot scan's
   * `#adoptRecorded` and the install path's confirm, both in
   * `plugins/install.ts`.
   *
   * A row missing here was adopted without a manifest (an ST extension
   * living in this runtime, a placeholder for a broken tree) and declares
   * nothing, which is the conservative reading: third-party code that never
   * spelled a declaration gets no host-provided service, and the refusal it
   * sees names why.
   */
  readonly #declaredPermissions = new Map<string, ReadonlySet<string>>()
  /**
   * The private-store backend, present only when the host passed a
   * `pluginDataRoot`. A runtime without one — every lifecycle test — hands
   * out a `storage` face that refuses with a name rather than no member.
   */
  readonly #pluginData: PluginDataStore | undefined
  #revision = 0
  #queue: Promise<void> = Promise.resolve()
  #initialized = false
  #disposed = false
  #storageFault: Error | undefined

  constructor(options: SystemPluginRuntimeOptions) {
    this.#context = options.context
    this.#file = options.file
    this.#onError = options.onError ?? (() => {})
    this.#writePreferences = options.writePreferences ?? atomicWriteFile
    this.#pluginData = options.pluginDataRoot === undefined
      ? undefined
      : new PluginDataStore({
        root: options.pluginDataRoot,
        // Both channels land where the runtime's own errors go —
        // `reportStoreProblem` in production — so a damaged plugin data file
        // is one diagnostic record and never a stream frame.
        onProblem: message => { this.#report(new Error(message)) },
        onError: error => { this.#report(error) },
      })
    this.#defaultEnabled = new Set(options.defaultEnabled ?? [
      TAVERN_HELPER_PLUGIN_ID,
      MVU_PLUGIN_ID,
    ])

    for (const raw of options.definitions) {
      if (raw.id.length === 0 || raw.id.length > 200) {
        throw new TypeError('system plugin ids must contain 1 to 200 characters')
      }
      if (this.#plugins.has(raw.id)) throw new TypeError(`system plugin "${raw.id}" is registered twice`)
      if (raw.apiVersion !== 1) throw new TypeError(`system plugin "${raw.id}" uses unsupported API version`)
      const dependencies = [...new Set(raw.dependencies ?? [])]
      if (dependencies.includes(raw.id)) throw new TypeError(`system plugin "${raw.id}" depends on itself`)
      this.#plugins.set(raw.id, {
        definition: { ...raw, dependencies },
        installed: false,
        enabled: false,
        status: 'not-installed',
        error: undefined,
        activation: undefined,
        incarnation: 0,
        removable: false,
      })
      this.#builtinIds.add(raw.id)
    }
  }

  /**
   * Adopt a definition after construction — the installed-ST-extension
   * handshake. The constructor's validation, re-run: an adopted definition is
   * indistinguishable from a builtin one, and the runtime's own invariants
   * (unique ids, apiVersion 1, no self-dependency) are not relaxed for it.
   * Idempotent: re-adopting a known id is a no-op, so a boot scan and a
   * runtime install can race safely.
   * @param options.permissions - what the adopted package's manifest declared,
   *   when the adopter read one (`plugins/install.ts`'s boot scan and confirm
   *   both did). Recorded once, at adoption, because that is the one moment
   *   the manifest and the catalog row are in the same pair of hands. An
   *   adopter without a manifest omits it and the row declares nothing.
   * @returns true when the definition was adopted, false when it already existed.
   */
  adoptDefinition(
    raw: SystemPluginDefinition,
    options: { installed: boolean, removable?: boolean, permissions?: readonly string[] },
  ): boolean {
    if (this.#plugins.has(raw.id)) return false
    if (raw.id.length === 0 || raw.id.length > 200) {
      throw new TypeError('system plugin ids must contain 1 to 200 characters')
    }
    if (raw.apiVersion !== 1) throw new TypeError(`system plugin "${String(raw.id)}" uses unsupported API version`)
    const dependencies = [...new Set(raw.dependencies ?? [])]
    if (dependencies.includes(raw.id)) throw new TypeError(`system plugin "${String(raw.id)}" depends on itself`)
    this.#plugins.set(raw.id, {
      definition: { ...raw, dependencies },
      installed: options.installed,
      enabled: false,
      status: options.installed ? 'disabled' : 'not-installed',
      error: undefined,
      activation: undefined,
      incarnation: 0,
      removable: options.removable ?? false,
    })
    if (options.permissions !== undefined) {
      this.#declaredPermissions.set(raw.id, new Set(options.permissions))
    }
    if (!this.#persisted.has(raw.id)) {
      this.#persisted.set(raw.id, { installed: options.installed, enabled: false })
    }
    return true
  }

  /** Whether this id came from the constructor's definition list. */
  isBuiltin(id: string): boolean {
    return this.#builtinIds.has(id)
  }

  /** Every id the catalog currently holds, builtin or adopted. */
  ids(): string[] {
    return [...this.#plugins.keys()]
  }

  /**
   * Every persisted row that records where its bytes came from, whether or not
   * the catalog currently holds a definition for it.
   *
   * The boot scan reads *this*, not `ids()`, and the difference is the whole
   * point: after `initialize` the catalog holds only the bundled definitions,
   * while the file holds a row for every package installed in earlier runs.
   * Iterating the catalog would have scanned nothing and reported nothing —
   * a plugin plane that silently forgot every installed package, with no error
   * anywhere, because the loop it was in was empty.
   */
  recordedInstalls(): { id: string, record: InstalledPluginRecord, enabled: boolean }[] {
    const rows: { id: string, record: InstalledPluginRecord, enabled: boolean }[] = []
    for (const [id, preference] of this.#persisted) {
      const record = this.record(id)
      if (record === undefined || record.source === 'builtin') continue
      rows.push({ id, record, enabled: preference.installed && preference.enabled })
    }
    return rows
  }

  /** The stored provenance of one row, as the boot scan and the install path read it. */
  record(id: string): InstalledPluginRecord | undefined {
    const preference = this.#persisted.get(id)
    if (preference?.source === undefined) return undefined
    return {
      source: preference.source,
      ...(preference.remote !== undefined ? { remote: preference.remote } : {}),
      ...(preference.commit !== undefined ? { commit: preference.commit } : {}),
      ...(preference.path !== undefined ? { path: preference.path } : {}),
      ...(preference.treeHash !== undefined ? { treeHash: preference.treeHash } : {}),
      ...(preference.installedAt !== undefined ? { installedAt: preference.installedAt } : {}),
    }
  }

  /**
   * Adopt a definition that came from an installed package tree, together with
   * where its bytes came from.
   *
   * The provenance is written to `system-plugins.json` in the same transition
   * that adds the row, so a catalog row and the record that lets a later boot
   * re-verify it can never be one write apart. `enabled` is false and stays
   * false: installing is not enabling, which is the invariant the lock record
   * states for itself (`packages/iris-extension-installer/src/lock.ts:71`).
   */
  adoptInstalled(
    raw: SystemPluginDefinition,
    record: InstalledPluginRecord,
    permissions?: readonly string[],
  ): Promise<SystemPluginSnapshot> {
    return this.#serialize(async () => {
      this.#assertWritable()
      if (this.#plugins.has(raw.id)) {
        throw new AppError('invalid-request', `system plugin "${raw.id}" is already in this profile's catalog`)
      }
      this.adoptDefinition(raw, {
        installed: true,
        removable: true,
        ...(permissions === undefined ? {} : { permissions }),
      })
      const plugin = this.#require(raw.id)
      const before = this.#persisted.get(raw.id)
      this.#persisted.set(raw.id, { installed: true, enabled: false, ...record })
      const revision = this.#revision + 1
      try {
        await this.#write(revision)
      } catch (error: unknown) {
        this.#plugins.delete(raw.id)
        if (before === undefined) this.#persisted.delete(raw.id)
        else this.#persisted.set(raw.id, before)
        throw new AppError(
          'internal',
          `system plugin "${raw.id}" could not be recorded: ${messageOf(error)}`,
        )
      }
      this.#revision = revision
      plugin.installed = true
      plugin.enabled = false
      plugin.status = 'disabled'
      this.#notify()
      return this.snapshot()
    })
  }

  /**
   * Put a named failure on a row and stop it running.
   *
   * Six of the seven states are the whole vocabulary here (§1 goal 4): a
   * plugin that cannot run is a row the user can see and act on, never a log
   * line and never a crash. Four of them also make `enable` a refusal — see
   * `ENABLE_BLOCKING_FAILURES` for which and why. The seventh, `hook-failed`,
   * never passes through here: it must not stop the plugin, so it goes through
   * {@link noteHookFailure}, which leaves `enabled`/`status`/`error` alone.
   */
  markFailure(id: string, failure: SystemPluginFailure): void {
    const plugin = this.#require(id)
    this.#failures.set(id, failure)
    plugin.enabled = false
    plugin.status = 'error'
    plugin.error = `${failure.state}: ${failure.reason}`
    this.#notify()
  }

  /** The named failure on a row, if it has one. */
  failure(id: string): SystemPluginFailure | undefined {
    return this.#failures.get(id)
  }

  /**
   * Record that one writer's contribution to this turn failed.
   *
   * Deliberately not {@link markFailure}: a variable write that threw or timed
   * out says nothing about whether the plugin runs, so `enabled`, `status` and
   * `error` are all left alone and the reply settles without the failed
   * proposal. The row keeps the reason so the interface can say what happened;
   * {@link clearHookFailure} or the plugin's next successful write removes it.
   */
  noteHookFailure(id: string, reason: string): void {
    const plugin = this.#plugins.get(id)
    if (plugin === undefined) return
    this.#failures.set(id, { state: 'hook-failed', reason })
    this.#notify()
  }

  /**
   * Clear a `hook-failed` this runtime wrote, after the writer's next
   * successful proposal. The state check is load-bearing: a row carrying an
   * install-path failure must not have it washed away by a settlement, so a
   * key whose state is anything else is left exactly where it was.
   */
  clearHookFailure(id: string): void {
    if (this.#failures.get(id)?.state !== 'hook-failed') return
    this.#failures.delete(id)
    this.#notify()
  }

  /**
   * Register one variable writer under `pluginId`; the returned disposer
   * removes it and is idempotent. The activation scope and the host share this
   * one entry point — one registry, two callers, the same shape as
   * `ScopedRequestSchema`/`RuntimeRequestSchema`.
   */
  registerVariableWriter(pluginId: string, writer: VariableWriter): () => void {
    const writers = this.#variableWriters.get(pluginId) ?? []
    writers.push(writer)
    this.#variableWriters.set(pluginId, writers)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.#variableWriters.get(pluginId)
      if (current === undefined) return
      const index = current.indexOf(writer)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.#variableWriters.delete(pluginId)
    }
  }

  /**
   * The writers that may propose this turn, in settlement order.
   *
   * The order is activation order, computed as `(dependency depth, id)` and
   * compared lexicographically with depth first. **The MVU row sorts after a
   * depth-0 writer because it declares `dependencies: ['tavern-helper']`, not
   * because of how the ids are spelled** — `'mvu' < 'prompt-template'`
   * alphabetically, so a plain `sort()` on the id would silently reverse a
   * decade of upstream handler order (ST-Prompt-Template runs its reply
   * handler first, card scripts such as MVU after) and hand every conflict to
   * the wrong winner. The depth comes from `NormalizedDefinition.dependencies`
   * in `#plugins`; a cycle cannot reach here because `enable` refuses one
   * through `#enableOrder` before any writer is registered, and the visiting
   * set below is only a belt for that guarantee.
   *
   * A writer whose id names no catalog row is kept and sorted at depth 0: only
   * the host registers such an id (see `#variableWriters`), and its on/off
   * state belongs to the plane it serves, not to the catalog.
   */
  orderedVariableWriters(): readonly RegisteredVariableWriter[] {
    const entries: Array<{ pluginId: string, depth: number, writer: VariableWriter }> = []
    for (const [pluginId, writers] of this.#variableWriters) {
      if (this.#plugins.has(pluginId) && !this.isEnabled(pluginId)) continue
      const depth = this.#dependencyDepth(pluginId, new Set())
      for (const writer of writers) entries.push({ pluginId, depth, writer })
    }
    return entries
      .sort((left, right) => left.depth - right.depth || (left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0))
      .map(({ pluginId, writer }) => ({ pluginId, writer }))
  }

  /** `1 + max(depth(dependency))`, or 0 for a row-less id; the set breaks cycles that cannot legitimately occur. */
  #dependencyDepth(id: string, visiting: Set<string>): number {
    const plugin = this.#plugins.get(id)
    if (plugin === undefined || visiting.has(id)) return 0
    visiting.add(id)
    let depth = 0
    for (const dependency of plugin.definition.dependencies) {
      depth = Math.max(depth, 1 + this.#dependencyDepth(dependency, visiting))
    }
    return depth
  }

  /** Load profile preferences and activate the persisted enabled set. */
  async initialize(): Promise<SystemPluginSnapshot> {
    return await this.#serialize(async () => {
      if (this.#initialized) return this.snapshot()
      if (this.#disposed) throw new AppError('unsupported', 'the system plugin runtime is disposed')

      let stored: StoredSystemPlugins | undefined
      try {
        const text = await readFile(this.#file, 'utf8')
        try {
          stored = parseStored(JSON.parse(text))
          if (stored === undefined) throw new Error('the file has an unsupported shape')
        } catch (error: unknown) {
          this.#storageFault = new Error(
            `${this.#file} could not be read as system-plugin preferences (${messageOf(error)});`
            + ' the file was retained and all system plugins are disabled',
          )
        }
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== 'ENOENT') {
          this.#storageFault = new Error(
            `${this.#file} could not be read (${messageOf(error)});`
            + ' the file was retained and all system plugins are disabled',
          )
        }
      }

      if (this.#storageFault !== undefined) {
        this.#report(this.#storageFault)
        for (const plugin of this.#plugins.values()) {
          plugin.installed = true
          plugin.enabled = false
          plugin.status = 'error'
          plugin.error = this.#storageFault.message
        }
        this.#initialized = true
        return this.snapshot()
      }

      this.#revision = stored?.revision ?? 0
      for (const [id, preference] of Object.entries(stored?.plugins ?? {})) {
        this.#persisted.set(id, { ...preference })
      }
      // v1 → v2, in place. §6 words it as "every row gains
      // `source: "builtin"`"; only the rows this build actually registered as
      // builtins get it here, because a v1 file can also hold rows for adopted
      // ST extensions, and stamping those `builtin` would put a claim about
      // where bytes came from into the one field that exists to answer that
      // question. Those rows keep no `source`, which is what "this host has no
      // provenance for this row" is spelled as — the boot scan fills it in if
      // it finds a tree, and the field is optional precisely so that absent
      // stays sayable. Recorded in DEVIATIONS §80.
      if (stored?.version === 1) {
        for (const [id, preference] of this.#persisted) {
          if (this.#builtinIds.has(id)) this.#persisted.set(id, { ...preference, source: 'builtin' })
        }
      }
      for (const [id, plugin] of this.#plugins) {
        const preference = stored?.plugins[id]
          ?? { installed: this.#defaultEnabled.has(id), enabled: this.#defaultEnabled.has(id) }
        plugin.installed = preference.installed
        plugin.enabled = preference.installed && preference.enabled
        plugin.status = plugin.installed ? 'disabled' : 'not-installed'
        this.#remember(id, { installed: plugin.installed, enabled: plugin.enabled })
        if (this.#builtinIds.has(id)) this.#remember(id, { source: 'builtin' })
      }

      // A persisted boot increment prevents a surviving old frame from sharing
      // a revision with this process. Reconnect also treats plugin.list as an
      // authoritative replacement, including recovery from an unreadable file.
      await this.#write(this.#revision + 1)
      this.#revision += 1
      this.#initialized = true

      const wanted = [...this.#plugins.values()].filter(plugin => plugin.enabled)
      for (const plugin of wanted) plugin.enabled = false
      for (const plugin of wanted) {
        if (plugin.status === 'error' || plugin.activation !== undefined) continue
        try {
          const order = this.#enableOrder(plugin.definition.id)
          for (const dependency of order) {
            if (dependency.activation !== undefined) continue
            dependency.installed = true
            await this.#activateAtStartup(dependency)
          }
        } catch (error: unknown) {
          plugin.enabled = false
          plugin.status = 'error'
          plugin.error = `system plugin "${plugin.definition.id}" could not start: ${messageOf(error)}`
          this.#remember(plugin.definition.id, { installed: plugin.installed, enabled: false })
          await this.#persistFailure(plugin, error)
        }
      }
      try {
        // Dependency repair and startup failures change the preference set the
        // first boot write carried. Replace it at the same boot revision so
        // capabilities activated with that revision and the final snapshot
        // identify one incarnation.
        await this.#write(this.#revision)
      } catch (error: unknown) {
        const reason = new Error(
          `normalized system-plugin startup state could not be saved: ${messageOf(error)}`,
        )
        for (const plugin of [...this.#plugins.values()].reverse()) {
          if (plugin.activation !== undefined) {
            try {
              await this.#disposeActivation(plugin)
            } catch (disposeError: unknown) {
              this.#report(errorOf(disposeError))
            }
          }
          plugin.enabled = false
          plugin.status = 'error'
          plugin.error = reason.message
          this.#remember(plugin.definition.id, {
            installed: plugin.installed,
            enabled: false,
          })
        }
        try {
          const revision = this.#revision + 1
          await this.#write(revision)
          this.#revision = revision
        } catch (saveError: unknown) {
          const detail = `; disabled startup state could not be saved: ${messageOf(saveError)}`
          for (const plugin of this.#plugins.values()) plugin.error += detail
          this.#storageFault = new Error(`${reason.message}${detail}`)
          this.#report(errorOf(saveError))
        }
        this.#report(reason)
      }
      this.#notify()
      return this.snapshot()
    })
  }

  /** Current immutable wire projection. */
  snapshot(): SystemPluginSnapshot {
    return {
      revision: this.#revision,
      plugins: [...this.#plugins.values()].map(plugin => {
        const stored = this.#persisted.get(plugin.definition.id)
        const provenance = provenanceOf(stored)
        const failure = this.#failures.get(plugin.definition.id)
        return {
          id: plugin.definition.id,
          name: plugin.definition.name,
          description: plugin.definition.description,
          version: plugin.definition.version,
          apiVersion: 1,
          dependencies: [...plugin.definition.dependencies],
          installed: plugin.installed,
          enabled: plugin.enabled,
          status: plugin.status,
          ...plugin.error === undefined ? {} : { error: plugin.error },
          // The three optional fields of PR-2. Omitted rather than set to
          // undefined, so a row with no provenance serializes to exactly the
          // bytes it serialized to before this round.
          ...stored?.source === undefined ? {} : { source: stored.source },
          ...provenance === undefined ? {} : { provenance },
          ...failure === undefined ? {} : { failure: { ...failure } },
        }
      }),
    }
  }

  /** Whether new work may enter this plugin's current incarnation. */
  isEnabled(id: string): boolean {
    const plugin = this.#plugins.get(id)
    return plugin?.enabled === true && plugin.status === 'enabled' && plugin.activation !== undefined
  }

  /** Observe committed snapshots. Listener failures are reported and isolated. */
  onChange(listener: (snapshot: SystemPluginSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Read a live capability only while its owner accepts new work. */
  capability<T>(pluginId: string, name: string): T | undefined {
    if (!this.isEnabled(pluginId)) return undefined
    return this.#context.get(serviceName(pluginId, name)) as T | undefined
  }

  /** Refuse a disabled plugin or a request from another runtime revision. */
  assertCurrent(pluginId: string, expectedRevision?: number): void {
    const plugin = this.#require(pluginId)
    if (!this.isEnabled(pluginId)) {
      throw new AppError('unsupported', `system plugin "${plugin.definition.name}" is disabled`)
    }
    if (expectedRevision !== undefined && expectedRevision !== this.#revision) {
      throw new AppError(
        'unsupported',
        `system plugin "${plugin.definition.name}" request belongs to stale runtime revision `
        + `${String(expectedRevision)}; the current revision is ${String(this.#revision)}`,
      )
    }
  }

  /** Admit one operation and return the drain token its transition waits for. */
  lease(pluginId: string, expectedRevision?: number): SystemPluginLease {
    this.assertCurrent(pluginId, expectedRevision)
    const plugin = this.#require(pluginId)
    const activation = plugin.activation!
    const key = `${pluginId}\u0000${String(activation.incarnation)}`
    const bucket = this.#leases.get(key) ?? { count: 0, waiters: new Set<() => void>() }
    bucket.count += 1
    this.#leases.set(key, bucket)
    let released = false
    return {
      pluginId,
      revision: this.#revision,
      incarnation: activation.incarnation,
      // Closing admission changes the public status before drain starts, but
      // work that already owns this token remains current until its activation
      // is actually disposed. This is the commit permission disable waits for.
      isCurrent: () => this.#plugins.get(pluginId)?.activation === activation,
      assertCurrent: () => {
        if (this.#plugins.get(pluginId)?.activation !== activation) {
          throw new AppError('unsupported', `system plugin "${plugin.definition.name}" incarnation is stale`)
        }
      },
      release: () => {
        if (released) return
        released = true
        bucket.count -= 1
        if (bucket.count !== 0) return
        this.#leases.delete(key)
        for (const resolve of bucket.waiters) resolve()
        bucket.waiters.clear()
      },
    }
  }

  install(id: string): Promise<SystemPluginSnapshot> {
    return this.#serialize(async () => {
      this.#assertWritable()
      const plugin = this.#require(id)
      if (plugin.installed) return this.snapshot()
      await this.#commit(plugin, { installed: true, enabled: false, status: 'disabled' })
      return this.snapshot()
    })
  }

  enable(id: string): Promise<SystemPluginSnapshot> {
    return this.#serialize(async () => {
      this.#assertWritable()
      const target = this.#require(id)
      if (this.isEnabled(id)) return this.snapshot()
      // A named install-path failure is refused here rather than attempted: a
      // `tampered` row whose enable re-imported the tree would be an enable
      // that can succeed against bytes the hash record disagrees with, which
      // is the one thing the hash record exists to stop. The refusal names the
      // state so the interface can offer the right next step (§8).
      for (const blocked of this.#enableOrderSafe(id)) {
        const failure = this.#failures.get(blocked)
        if (failure !== undefined && ENABLE_BLOCKING_FAILURES.has(failure.state)) {
          throw new AppError(
            'unsupported',
            `system plugin "${blocked}" is ${failure.state} and cannot be enabled: ${failure.reason}`,
          )
        }
      }
      // The two retryable states are cleared by the attempt itself: the author
      // fixed the file, the row gets a fresh verdict rather than inheriting the
      // last one.
      this.#failures.delete(id)
      const order = this.#enableOrder(id)
      const prior = new Map(order.map(plugin => [plugin.definition.id, {
        installed: plugin.installed,
        enabled: plugin.enabled,
      }]))
      const newlyEnabled: RuntimePlugin[] = []
      try {
        for (const plugin of order) {
          if (this.isEnabled(plugin.definition.id)) continue
          await this.#enableOne(plugin)
          newlyEnabled.push(plugin)
        }
      } catch (error: unknown) {
        for (const plugin of newlyEnabled.reverse()) {
          if (plugin === target) continue
          const before = prior.get(plugin.definition.id)!
          try {
            await this.#disableOne(plugin, 'dependency enable rollback')
            if (!before.installed) {
              await this.#commit(plugin, { installed: false, enabled: false, status: 'not-installed' })
            }
          } catch (rollbackError: unknown) {
            this.#report(errorOf(rollbackError))
          }
        }
        throw error
      }
      return this.snapshot()
    })
  }

  disable(id: string): Promise<SystemPluginSnapshot> {
    return this.#serialize(async () => {
      this.#assertWritable()
      const plugin = this.#require(id)
      this.#refuseEnabledDependents(plugin, 'disable')
      if (!this.isEnabled(id)) return this.snapshot()
      await this.#disableOne(plugin, 'disable')
      return this.snapshot()
    })
  }

  reload(id: string): Promise<SystemPluginSnapshot> {
    return this.#serialize(async () => {
      this.#assertWritable()
      const plugin = this.#require(id)
      this.#refuseEnabledDependents(plugin, 'reload')
      if (!this.isEnabled(id)) {
        throw new AppError('unsupported', `system plugin "${plugin.definition.name}" is disabled`)
      }

      await this.#invalidate(plugin, true)
      await this.#drain(plugin)
      try {
        await this.#disposeActivation(plugin)
        await this.#commit(plugin, { enabled: true, status: 'enabling' })
        await this.#activate(plugin, this.#revision + 1)
        await this.#commit(plugin, { enabled: true, status: 'enabled' })
      } catch (error: unknown) {
        try {
          await this.#disposeActivation(plugin)
        } catch (disposeError: unknown) {
          this.#report(errorOf(disposeError))
        }
        await this.#setFailure(plugin, error)
        throw new AppError('internal', plugin.error!)
      }
      return this.snapshot()
    })
  }

  uninstall(id: string): Promise<SystemPluginSnapshot> {
    return this.#serialize(async () => {
      this.#assertWritable()
      const plugin = this.#require(id)
      this.#refuseEnabledDependents(plugin, 'uninstall')
      if (this.isEnabled(id)) await this.#disableOne(plugin, 'uninstall')
      if (!plugin.installed && !plugin.removable) return this.snapshot()
      if (plugin.removable) {
        // The row itself goes, not just its installed flag. The caller deletes
        // the tree (§6: a plugin tree holds no user data, and one left on disk
        // after the user believes they removed it is a same-privilege code
        // tree they have stopped watching) — so a row that stayed would point
        // at nothing and would also keep the id occupied against a reinstall.
        const before = this.#persisted.get(id)
        this.#plugins.delete(id)
        this.#persisted.delete(id)
        this.#failures.delete(id)
        const revision = this.#revision + 1
        try {
          await this.#write(revision)
        } catch (error: unknown) {
          this.#plugins.set(id, plugin)
          if (before !== undefined) this.#persisted.set(id, before)
          throw new AppError(
            'internal',
            `system plugin "${plugin.definition.name}" state could not be saved: ${messageOf(error)}`,
          )
        }
        this.#revision = revision
        this.#notify()
        return this.snapshot()
      }
      await this.#commit(plugin, { installed: false, enabled: false, status: 'not-installed' })
      return this.snapshot()
    })
  }

  /**
   * Drain every plugin's private store and close it to new writes.
   *
   * The teardown counterpart of `cardStorage.flush()` and
   * `scriptVariables.flush()`, from the same handlers-effect dispose: the
   * chains run per plugin, so this returns only when every write enqueued
   * before it — including one a plugin made from its own dispose, the save it
   * could not have made at any other moment — is on disk. After it, `set` and
   * `delete` answer `invalid-request`; reads keep answering what is on disk.
   * Failures never reject here: each failed write was already thrown to its
   * own caller and reported through the store's `onError`, and the host's
   * shutdown cannot act on either.
   */
  flushPluginData(): Promise<void> {
    if (this.#pluginData === undefined) return Promise.resolve()
    return this.#pluginData.flush()
  }

  /** Tear down every child fiber without changing persisted preferences. */
  async dispose(): Promise<void> {
    await this.#serialize(async () => {
      if (this.#disposed) return
      this.#disposed = true
      const active = [...this.#plugins.values()].filter(plugin => plugin.activation !== undefined)
      for (const plugin of active.reverse()) {
        plugin.enabled = false
        plugin.status = plugin.installed ? 'disabled' : 'not-installed'
        await this.#drain(plugin)
        try {
          await this.#disposeActivation(plugin)
        } catch (error: unknown) {
          this.#report(errorOf(error))
        }
      }
      this.#listeners.clear()
    })
  }

  async #enableOne(plugin: RuntimePlugin): Promise<void> {
    if (!plugin.installed) {
      await this.#commit(plugin, { installed: true, enabled: false, status: 'disabled' })
    }
    await this.#commit(plugin, { enabled: false, status: 'enabling' })
    try {
      await this.#activate(plugin, this.#revision + 1)
      await this.#commit(plugin, { enabled: true, status: 'enabled' })
    } catch (error: unknown) {
      try {
        await this.#disposeActivation(plugin)
      } catch (disposeError: unknown) {
        this.#report(errorOf(disposeError))
      }
      await this.#setFailure(plugin, error)
      throw new AppError('internal', plugin.error!)
    }
  }

  async #disableOne(plugin: RuntimePlugin, verb: string): Promise<void> {
    await this.#invalidate(plugin, false)
    await this.#drain(plugin)
    try {
      await this.#disposeActivation(plugin)
      await this.#commit(plugin, { enabled: false, status: 'disabled' })
    } catch (error: unknown) {
      await this.#setFailure(plugin, new Error(`${verb} failed: ${messageOf(error)}`))
      throw new AppError('internal', plugin.error!)
    }
  }

  async #invalidate(plugin: RuntimePlugin, keepEnabledPreference: boolean): Promise<void> {
    await this.#commit(plugin, {
      enabled: keepEnabledPreference,
      status: 'disabling',
    })
  }

  async #activateAtStartup(plugin: RuntimePlugin): Promise<void> {
    plugin.status = 'enabling'
    try {
      await this.#activate(plugin, this.#revision)
      plugin.enabled = true
      plugin.status = 'enabled'
      plugin.error = undefined
      this.#failures.delete(plugin.definition.id)
      this.#remember(plugin.definition.id, { installed: true, enabled: true })
    } catch (error: unknown) {
      await this.#disposeActivation(plugin)
      plugin.enabled = false
      plugin.status = 'error'
      plugin.error = `system plugin "${plugin.definition.id}" could not start: ${messageOf(error)}`
      this.#remember(plugin.definition.id, { installed: true, enabled: false })
      throw error
    }
  }

  async #activate(plugin: RuntimePlugin, revision: number): Promise<void> {
    const incarnation = plugin.incarnation + 1
    const activation: Activation = { fiber: undefined as unknown as Fiber, incarnation, revision }
    const definition = plugin.definition
    const cordisPlugin = {
      name: `iris-system-plugin:${definition.id}`,
      apply: async (context: Context) => {
        const scope: SystemPluginActivationScope = {
          context,
          pluginId: definition.id,
          revision,
          provide: (name, value) => context.provide(serviceName(definition.id, name), value),
          getDependency: <T>(pluginId: string, name: string): T | undefined => {
            if (!definition.dependencies.includes(pluginId)) {
              throw new AppError(
                'invalid-request',
                `system plugin "${definition.id}" did not declare dependency "${pluginId}"`,
              )
            }
            return this.capability<T>(pluginId, name)
          },
          variables: {
            // Registered as an effect of this activation's own fiber, the way
            // `registerRpc` below is: the writer joins when the plugin does and
            // leaves when the fiber is disposed — a disable, a reload — so a
            // plugin that ignores the returned disposer still cannot write past
            // its own activation.
            registerWriter: (writer: VariableWriter): (() => void) => {
              let teardown: () => void = () => {}
              context.effect(() => {
                teardown = this.registerVariableWriter(definition.id, writer)
                return teardown
              }, `iris-system-plugin:${definition.id}: variable writer`)
              return () => { teardown() }
            },
          },
          registerRpc: <T>(
            method: string,
            schema: ScopedRequestSchema<T>,
            handler: (params: T & ScopedPluginRevision) => unknown,
          ) => {
            const registrar = this.#context.get('irisRpc') as RpcRegistrar | undefined
            if (registrar === undefined) {
              throw new AppError(
                'internal',
                `system plugin "${definition.id}" cannot register RPC methods: the RPC host is not available`,
              )
            }
            // Registered as an effect of this activation's own fiber, so its
            // disposal — the plugin's own teardown, a disable, a reload — takes
            // the registration with it. `context.effect` runs the effect now,
            // so a refused name (a builtin, another plugin's method) throws
            // here, inside `activate`, failing this plugin and nothing else.
            let teardown: () => void = () => {}
            context.effect(() => {
              const disposeSchema = registerRequestSchema(method, schema)
              let disposeHandler: () => void
              try {
                disposeHandler = registrar.register(method, params => {
                  // Admission per call, not only at registration: the lease
                  // refuses when this plugin has stopped accepting work and —
                  // when the request carries a fence — when it names a runtime
                  // revision this activation already replaced. Released when
                  // the handler settles, so a disable drains in-flight calls
                  // before disposing the fiber that owns them.
                  const lease = this.lease(
                    definition.id,
                    (params as ScopedPluginRevision).pluginRevision,
                  )
                  return Promise.resolve(handler(params as T & ScopedPluginRevision))
                    .finally(() => { lease.release() })
                })
              } catch (error: unknown) {
                // Never half-registered: a handler that could not sit down
                // takes its schema with it.
                disposeSchema()
                throw error
              }
              let disposed = false
              teardown = () => {
                if (disposed) return
                disposed = true
                disposeHandler()
                disposeSchema()
              }
              return teardown
            }, `iris-system-plugin:${definition.id}: rpc ${method}`)
            return () => { teardown() }
          },
          storage: this.#storageFace(definition.id, activation),
        }
        const dispose = await definition.activate(scope)
        if (typeof dispose !== 'function') return
        return async () => {
          try {
            await dispose()
          } catch (error: unknown) {
            activation.disposalError = errorOf(error)
            throw error
          }
        }
      },
    }
    const fiber = this.#context.plugin(cordisPlugin)
    activation.fiber = fiber
    plugin.activation = activation
    plugin.incarnation = incarnation
    try {
      await fiber.await()
    } catch (error: unknown) {
      await fiber.dispose()
      plugin.activation = undefined
      throw error
    }
  }

  async #disposeActivation(plugin: RuntimePlugin): Promise<void> {
    const activation = plugin.activation
    if (activation === undefined) return
    try {
      await activation.fiber.dispose()
    } finally {
      // Cleared only once the fiber — and with it the plugin's own dispose —
      // has finished. A storage face captured by that dispose must still read
      // as current while it runs, because writing its final state is the one
      // save a plugin cannot make at any other moment; the moment the
      // activation is truly gone, the same predicate reads stale. The
      // transitions are serialized, so no observer sits between "drained" and
      // "disposed" that this window could surprise.
      plugin.activation = undefined
    }
    if (activation.disposalError !== undefined) throw activation.disposalError
  }

  /**
   * The permission set an activation of this id may assume.
   *
   * A builtin declares all of them: it is this repository's own source, ships
   * with Iris, and making it write out a manifest of its own members would be
   * ceremony — the one documented exception to the vocabulary carrying
   * consequences (`plugins/manifest.ts`). An adopted package declares exactly
   * what its manifest listed; an adopted row with no manifest on record
   * declares nothing.
   */
  #permissionsOf(id: string): ReadonlySet<string> {
    const declared = this.#declaredPermissions.get(id)
    if (declared !== undefined) return declared
    if (this.#builtinIds.has(id)) return ALL_PLUGIN_PERMISSIONS
    return new Set<string>()
  }

  /**
   * The `storage` half of one activation's scope.
   *
   * Three shapes, decided here rather than per call: a host with no plugin
   * data root refuses with `internal` (wiring is missing — the host's fault,
   * the same reading `registerRpc` gives an absent RPC registrar); a plugin
   * that did not declare `plugin-storage` refuses with `invalid-request`,
   * named after `getDependency`'s refusal of an undeclared dependency; and a
   * plugin that did gets the real store.
   *
   * The real store's identity predicate is the same one `lease().isCurrent()`
   * reads — the catalog row still points at *this* activation — and not
   * `lease()` itself, whose admission requires `isEnabled`. The difference is
   * the plugin's own dispose: by then the row has already left `enabled`, but
   * the activation has not yet been disposed, and saving final state there is
   * exactly the write a plugin cannot make at any other moment.
   */
  #storageFace(pluginId: string, activation: Activation): PluginStorage {
    if (this.#pluginData === undefined) {
      return refusedStorage(
        'internal',
        `system plugin "${pluginId}" cannot use storage: this host has no plugin data root`,
      )
    }
    if (!this.#permissionsOf(pluginId).has('plugin-storage')) {
      return refusedStorage(
        'invalid-request',
        `system plugin "${pluginId}" did not declare the "plugin-storage" permission;`
        + ' add it to iris.plugin.permissions',
      )
    }
    const store = this.#pluginData
    return store.storageFor(pluginId, () => this.#plugins.get(pluginId)?.activation === activation)
  }

  /**
   * The ids an enable of `id` would touch, without the opinions `#enableOrder`
   * has about cycles and missing rows.
   *
   * Separate because the failure check runs *before* the ordering: a row
   * blocked by a `tampered` dependency must be refused by that name, not by a
   * cycle error the ordering happened to hit first.
   */
  #enableOrderSafe(id: string): string[] {
    const seen = new Set<string>()
    const walk = (current: string): void => {
      if (seen.has(current)) return
      seen.add(current)
      const plugin = this.#plugins.get(current)
      if (plugin === undefined) return
      for (const dependency of plugin.definition.dependencies) walk(dependency)
    }
    walk(id)
    return [...seen]
  }

  #enableOrder(id: string): RuntimePlugin[] {
    const result: RuntimePlugin[] = []
    const visited = new Set<string>()
    const visiting: string[] = []
    const visit = (pluginId: string) => {
      if (visited.has(pluginId)) return
      const cycleAt = visiting.indexOf(pluginId)
      if (cycleAt >= 0) {
        throw new AppError(
          'invalid-request',
          `system plugin dependency cycle: ${[...visiting.slice(cycleAt), pluginId].join(' -> ')}`,
        )
      }
      const plugin = this.#plugins.get(pluginId)
      if (plugin === undefined) {
        const owner = visiting.at(-1)
        throw new AppError(
          'not-found',
          owner === undefined
            ? `system plugin "${pluginId}" is not registered`
            : `system plugin "${owner}" depends on unregistered plugin "${pluginId}"`,
        )
      }
      visiting.push(pluginId)
      for (const dependency of plugin.definition.dependencies) visit(dependency)
      visiting.pop()
      visited.add(pluginId)
      result.push(plugin)
    }
    visit(id)
    return result
  }

  #refuseEnabledDependents(plugin: RuntimePlugin, verb: string): void {
    const dependents = [...this.#plugins.values()]
      .filter(candidate => candidate.definition.dependencies.includes(plugin.definition.id))
      .filter(candidate => candidate.enabled || candidate.status === 'enabling')
      .map(candidate => candidate.definition.name)
    if (dependents.length === 0) return
    throw new AppError(
      'busy',
      `cannot ${verb} system plugin "${plugin.definition.name}" while enabled dependent(s) `
      + `${dependents.map(name => `"${name}"`).join(', ')} are active; disable ${dependents.join(', ')} first`,
    )
  }

  async #drain(plugin: RuntimePlugin): Promise<void> {
    const activation = plugin.activation
    if (activation === undefined) return
    const bucket = this.#leases.get(`${plugin.definition.id}\u0000${String(activation.incarnation)}`)
    if (bucket === undefined || bucket.count === 0) return
    await new Promise<void>(resolve => { bucket.waiters.add(resolve) })
  }

  async #commit(
    plugin: RuntimePlugin,
    change: Partial<Pick<RuntimePlugin, 'installed' | 'enabled' | 'status'>>,
  ): Promise<void> {
    const installed = change.installed ?? plugin.installed
    const enabled = installed && (change.enabled ?? plugin.enabled)
    const revision = this.#revision + 1
    const before = this.#persisted.get(plugin.definition.id)
    // The provenance keys ride through every lifecycle transition untouched.
    // Spreading `before` first is what makes an enable/disable a change to two
    // booleans rather than a silent erasure of where the bytes came from — and
    // the erasure would be invisible until the next boot declined to
    // re-verify a row it no longer knew was a `git` row.
    this.#persisted.set(plugin.definition.id, { ...before, installed, enabled })
    try {
      await this.#write(revision)
    } catch (error: unknown) {
      if (before === undefined) this.#persisted.delete(plugin.definition.id)
      else this.#persisted.set(plugin.definition.id, before)
      throw new AppError(
        'internal',
        `system plugin "${plugin.definition.name}" state could not be saved: ${messageOf(error)}`,
      )
    }
    this.#revision = revision
    plugin.installed = installed
    plugin.enabled = enabled
    plugin.status = change.status ?? (installed ? (enabled ? 'enabled' : 'disabled') : 'not-installed')
    plugin.error = undefined
    // A committed transition clears the free-text error; the typed failure
    // beside it has to go with it, or the row would carry a `failure.state`
    // under a `status` that says everything is fine.
    this.#failures.delete(plugin.definition.id)
    this.#notify()
  }

  /** Update the two lifecycle booleans (or a provenance key) without erasing the rest of the row. */
  #remember(id: string, patch: Partial<StoredPluginPreference>): void {
    const before = this.#persisted.get(id) ?? { installed: false, enabled: false }
    this.#persisted.set(id, { ...before, ...patch })
  }

  async #setFailure(plugin: RuntimePlugin, error: unknown): Promise<void> {
    const reason = `system plugin "${plugin.definition.name}" failed: ${messageOf(error)}`
    plugin.enabled = false
    plugin.status = 'error'
    plugin.error = reason
    this.#remember(plugin.definition.id, { installed: plugin.installed, enabled: false })
    try {
      const revision = this.#revision + 1
      await this.#write(revision)
      this.#revision = revision
      this.#notify()
    } catch (saveError: unknown) {
      plugin.error += `; disabled state could not be saved: ${messageOf(saveError)}`
      this.#report(new Error(plugin.error))
      this.#notify()
    }
    this.#report(errorOf(error))
  }

  async #persistFailure(plugin: RuntimePlugin, error: unknown): Promise<void> {
    try {
      await this.#write(this.#revision)
    } catch (saveError: unknown) {
      plugin.error += `; disabled state could not be saved: ${messageOf(saveError)}`
      this.#report(errorOf(saveError))
    }
    this.#report(errorOf(error))
  }

  async #write(revision: number): Promise<void> {
    const plugins: Record<string, StoredPluginPreference> = Object.create(null)
    for (const [id, preference] of this.#persisted) plugins[id] = { ...preference }
    const stored: StoredSystemPlugins = { version: STORED_VERSION, revision, plugins }
    await this.#writePreferences(this.#file, `${JSON.stringify(stored, null, 2)}\n`)
  }

  #require(id: string): RuntimePlugin {
    const plugin = this.#plugins.get(id)
    if (plugin === undefined) throw new AppError('not-found', `system plugin "${id}" is not registered`)
    return plugin
  }

  #assertWritable(): void {
    if (!this.#initialized) throw new AppError('busy', 'the system plugin runtime has not initialized')
    if (this.#disposed) throw new AppError('unsupported', 'the system plugin runtime is disposed')
    if (this.#storageFault !== undefined) throw new AppError('internal', this.#storageFault.message)
  }

  #notify(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch (error: unknown) {
        this.#report(errorOf(error))
      }
    }
  }

  #report(error: Error): void {
    try {
      this.#onError(error)
    } catch {
      // A diagnostic observer is not part of the transition transaction.
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => {}, () => {})
    return result
  }
}
