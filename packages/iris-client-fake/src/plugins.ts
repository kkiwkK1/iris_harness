/** The bundled system-plugin lifecycle, held in memory for demos and tests. */
import type {
  SystemPluginId,
  SystemPluginSnapshot,
  SystemPluginView,
} from '@iris/protocol'

type Refuse = (code: 'not-found' | 'invalid-request', message: string) => never

const BUNDLED = [
  {
    id: 'tavern-helper',
    name: 'TavernHelper',
    description: 'Compatibility APIs and managed script lifetimes for community cards.',
    version: '0.0.0',
    apiVersion: 1,
    dependencies: [],
    installed: true,
    enabled: true,
    status: 'enabled',
  },
  {
    id: 'mvu',
    name: 'MVU',
    description: 'Variable update, initialization and replay for compatible cards.',
    version: '0.0.0',
    apiVersion: 1,
    dependencies: ['tavern-helper'],
    installed: true,
    enabled: true,
    status: 'enabled',
  },
] satisfies readonly (SystemPluginView & { id: SystemPluginId })[]

/**
 * A stateful fake of the control plane.
 *
 * It deliberately models only the bundled catalog. Accepting an arbitrary id
 * here would tell the plugin center that a package exists when no implementation
 * was registered for it.
 */
export class FakeSystemPlugins {
  #revision = 1
  readonly #emit: (snapshot: SystemPluginSnapshot) => void
  readonly #refuse: Refuse
  readonly #plugins = new Map<string, SystemPluginView>(
    BUNDLED.map(plugin => [plugin.id, { ...plugin, dependencies: [...plugin.dependencies] }]),
  )

  constructor(
    emit: (snapshot: SystemPluginSnapshot) => void,
    refuse: Refuse,
  ) {
    this.#emit = emit
    this.#refuse = refuse
  }

  snapshot(): SystemPluginSnapshot {
    return {
      revision: this.#revision,
      plugins: [...this.#plugins.values()].map(plugin => ({
        ...plugin,
        dependencies: [...plugin.dependencies],
      })),
    }
  }

  /**
   * Whether one catalog row accepts work — the fake of the runtime's
   * `isEnabled`, so a registered plugin method can be gated the same way the
   * host gates its own.
   */
  isEnabled(id: string): boolean {
    const plugin = this.#plugins.get(id)
    return plugin?.enabled === true && plugin.status === 'enabled'
  }

  install(id: string): SystemPluginSnapshot {
    const plugin = this.#require(id)
    if (plugin.installed) return this.snapshot()
    this.#write(id, { installed: true, enabled: false, status: 'disabled' })
    return this.snapshot()
  }

  enable(id: string): SystemPluginSnapshot {
    this.#enable(this.#require(id), new Set())
    return this.snapshot()
  }

  disable(id: string): SystemPluginSnapshot {
    const plugin = this.#require(id)
    this.#requireNoEnabledDependents(plugin)
    if (!plugin.installed || !plugin.enabled) return this.snapshot()
    this.#write(id, { status: 'disabling' })
    this.#write(id, { enabled: false, status: 'disabled' })
    return this.snapshot()
  }

  uninstall(id: string): SystemPluginSnapshot {
    const plugin = this.#require(id)
    this.#requireNoEnabledDependents(plugin)
    if (!plugin.installed) return this.snapshot()
    if (plugin.enabled) {
      this.#write(id, { status: 'disabling' })
      this.#write(id, { enabled: false, status: 'disabled' })
    }
    this.#write(id, { installed: false, enabled: false, status: 'not-installed' })
    return this.snapshot()
  }

  reload(id: string): SystemPluginSnapshot {
    const plugin = this.#require(id)
    this.#requireNoEnabledDependents(plugin)
    if (!plugin.installed) {
      return this.#refuse('invalid-request', `${plugin.name} is not installed; reinstall it before reloading`)
    }
    if (!plugin.enabled) {
      return this.#refuse('invalid-request', `${plugin.name} is disabled; enable it before reloading`)
    }
    this.#write(id, { status: 'disabling' })
    this.#write(id, { enabled: false, status: 'enabling' })
    this.#write(id, { enabled: true, status: 'enabled' })
    return this.snapshot()
  }

  #enable(plugin: SystemPluginView, visiting: Set<string>): void {
    if (plugin.enabled && plugin.status === 'enabled') return
    if (visiting.has(plugin.id)) {
      this.#refuse('invalid-request', `system plugin dependency cycle at "${plugin.id}"`)
    }
    visiting.add(plugin.id)
    for (const dependencyId of plugin.dependencies) {
      const dependency = this.#require(dependencyId)
      if (!dependency.installed) this.install(dependency.id)
      this.#enable(dependency, visiting)
    }
    visiting.delete(plugin.id)
    if (!plugin.installed) this.install(plugin.id)
    this.#write(plugin.id, { status: 'enabling' })
    this.#write(plugin.id, { enabled: true, status: 'enabled' })
  }

  #require(id: string): SystemPluginView {
    const plugin = this.#plugins.get(id)
    if (plugin === undefined) this.#refuse('not-found', `no bundled system plugin "${id}"`)
    return plugin
  }

  #requireNoEnabledDependents(plugin: SystemPluginView): void {
    const dependent = [...this.#plugins.values()].find(candidate =>
      candidate.enabled && candidate.dependencies.includes(plugin.id),
    )
    if (dependent !== undefined) {
      this.#refuse(
        'invalid-request',
        `${plugin.name} is required by enabled ${dependent.name}; disable ${dependent.name} first`,
      )
    }
  }

  #write(id: string, patch: Partial<SystemPluginView>): void {
    const current = this.#require(id)
    const next = { ...current, ...patch }
    if (patch.error === undefined) delete next.error
    this.#plugins.set(id, next)
    this.#revision += 1
    delete next.error
    this.#emit(this.snapshot())
  }
}
