import { readFile } from 'node:fs/promises'

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { registerRequestSchema, type SystemPluginId, type SystemPluginSnapshot, type SystemPluginView } from '@iris/protocol'
import type {
  ScopedPluginRevision,
  ScopedRequestSchema,
  SystemPluginActivationScope,
  SystemPluginDefinition,
  SystemPluginLease,
  SystemPluginRuntimeOptions,
} from '@iris/plugin-api'

import { atomicWriteFile } from './atomic.ts'
import { AppError } from './errors.ts'

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
}

const SERVICE_PREFIX = 'iris.system-plugin'

interface StoredPluginPreference {
  installed: boolean
  enabled: boolean
}

interface StoredSystemPlugins {
  version: 1
  revision: number
  plugins: Record<string, StoredPluginPreference>
}

interface RuntimePlugin {
  definition: NormalizedDefinition
  installed: boolean
  enabled: boolean
  status: SystemPluginView['status']
  error: string | undefined
  activation: Activation | undefined
  incarnation: number
}

interface Activation {
  fiber: Fiber
  incarnation: number
  revision: number
  disposalError?: Error
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

function validPreference(value: unknown): value is StoredPluginPreference {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row['installed'] === 'boolean' && typeof row['enabled'] === 'boolean'
}

function parseStored(value: unknown): StoredSystemPlugins | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (row['version'] !== 1) return undefined
  if (!Number.isSafeInteger(row['revision']) || (row['revision'] as number) < 0) return undefined
  const plugins = row['plugins']
  if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined
  for (const preference of Object.values(plugins)) {
    if (!validPreference(preference)) return undefined
  }
  return {
    version: 1,
    revision: row['revision'] as number,
    plugins: plugins as Record<string, StoredPluginPreference>,
  }
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
    this.#defaultEnabled = new Set(options.defaultEnabled ?? [
      'tavern-helper' satisfies SystemPluginId,
      'mvu' satisfies SystemPluginId,
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
      })
    }
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
      for (const [id, plugin] of this.#plugins) {
        const preference = stored?.plugins[id]
          ?? { installed: this.#defaultEnabled.has(id), enabled: this.#defaultEnabled.has(id) }
        plugin.installed = preference.installed
        plugin.enabled = preference.installed && preference.enabled
        plugin.status = plugin.installed ? 'disabled' : 'not-installed'
        this.#persisted.set(id, { installed: plugin.installed, enabled: plugin.enabled })
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
          this.#persisted.set(plugin.definition.id, { installed: plugin.installed, enabled: false })
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
          this.#persisted.set(plugin.definition.id, {
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
      plugins: [...this.#plugins.values()].map(plugin => ({
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
      })),
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
      if (!plugin.installed) return this.snapshot()
      await this.#commit(plugin, { installed: false, enabled: false, status: 'not-installed' })
      return this.snapshot()
    })
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
      this.#persisted.set(plugin.definition.id, { installed: true, enabled: true })
    } catch (error: unknown) {
      await this.#disposeActivation(plugin)
      plugin.enabled = false
      plugin.status = 'error'
      plugin.error = `system plugin "${plugin.definition.id}" could not start: ${messageOf(error)}`
      this.#persisted.set(plugin.definition.id, { installed: true, enabled: false })
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
    plugin.activation = undefined
    await activation.fiber.dispose()
    if (activation.disposalError !== undefined) throw activation.disposalError
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
    this.#persisted.set(plugin.definition.id, { installed, enabled })
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
    this.#notify()
  }

  async #setFailure(plugin: RuntimePlugin, error: unknown): Promise<void> {
    const reason = `system plugin "${plugin.definition.name}" failed: ${messageOf(error)}`
    plugin.enabled = false
    plugin.status = 'error'
    plugin.error = reason
    this.#persisted.set(plugin.definition.id, { installed: plugin.installed, enabled: false })
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
    const stored: StoredSystemPlugins = { version: 1, revision, plugins }
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
