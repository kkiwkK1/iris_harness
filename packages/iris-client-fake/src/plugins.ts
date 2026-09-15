/** The bundled system-plugin lifecycle, held in memory for demos and tests. */
import type {
  SystemPluginInstallPreview,
  SystemPluginSnapshot,
  SystemPluginView,
} from '@iris/protocol'

type Refuse = (code: 'not-found' | 'invalid-request' | 'unsupported', message: string) => never

/**
 * A deterministic 64-hex digest of a string, computed without `node:crypto`.
 *
 * This package is bundled into the browser (`apps/iris-web` builds it through
 * Vite, where `node:crypto` resolves to an empty external and `createHash` is
 * an undefined import that fails the *build*, not the test run). The value is
 * never a security claim: it stands in for the tree hash a real staging step
 * would compute, and the only property anything depends on is that the same
 * request previews the same way twice, so a test can assert on it and a
 * mismatched echo can be refused.
 *
 * Eight independent FNV-1a lanes, each seeded differently, concatenated as
 * 32-bit hex — exactly 64 characters, enough spread that two different sources
 * do not collide in a demo catalog, and no more than that is claimed.
 */
function fakeDigest(input: string): string {
  const lanes = [
    0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b,
    0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c,
  ]
  for (let lane = 0; lane < lanes.length; lane++) {
    let hash = lanes[lane] as number
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index) + lane
      hash = Math.imul(hash, 0x01000193)
    }
    lanes[lane] = hash >>> 0
  }
  return lanes.map(lane => (lane >>> 0).toString(16).padStart(8, '0')).join('').padEnd(64, '0').slice(0, 64)
}

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
] satisfies readonly SystemPluginView[]

/**
 * A stateful fake of the control plane.
 *
 * The method surface models only its catalog: an id absent from it is refused,
 * because telling the plugin center that a package exists when no
 * implementation was registered for it is the lie this fake exists not to
 * tell. The catalog itself is injectable — `bundled` — so a test can seat a
 * non-builtin id, the way an adopted ST extension arrives in the host, and
 * drive its lifecycle through the same transitions; ids outside the seated
 * catalog are refused exactly as before.
 */
export class FakeSystemPlugins {
  #revision = 1
  readonly #emit: (snapshot: SystemPluginSnapshot) => void
  readonly #refuse: Refuse
  readonly #plugins: Map<string, SystemPluginView>
  /** Staged previews awaiting a confirm, keyed by the token this fake minted. */
  readonly #previews = new Map<string, SystemPluginInstallPreview>()

  constructor(
    emit: (snapshot: SystemPluginSnapshot) => void,
    refuse: Refuse,
    bundled: readonly SystemPluginView[] = BUNDLED,
  ) {
    this.#emit = emit
    this.#refuse = refuse
    this.#plugins = new Map(
      bundled.map(plugin => [plugin.id, { ...plugin, dependencies: [...plugin.dependencies] }]),
    )
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

  // ------------------------------------------------------- the install path

  /**
   * Stage nothing and describe what a real preview would have described.
   *
   * The fake has no filesystem, no git and no staging, so what it models is the
   * **handshake**, not the transport: a token it minted, a preview whose
   * `treeHash` is derived from the request so the same request always previews
   * the same way, and a `confirm` that refuses any echo that disagrees with
   * what this preview said. That is the part a page is written against, and it
   * is the part that can lie if it is written loosely — a fake that accepted
   * any `treeHash` would let a page ship with the echo wired to the wrong
   * variable and still look correct.
   *
   * The id is derived from the source rather than invented, because a page
   * renders it and a test asserts on it.
   */
  previewInstall(source: { kind: 'git', remote: string, commit: string } | { kind: 'dev', path: string }): SystemPluginInstallPreview {
    const seed = source.kind === 'git' ? `${source.remote} | ${source.commit}` : source.path
    const digest = fakeDigest(seed)
    const id = `demo-${digest.slice(0, 8)}`
    const preview: SystemPluginInstallPreview = {
      previewToken: `preview-${digest.slice(0, 16)}`,
      id,
      displayName: `Demo package ${digest.slice(0, 4)}`,
      description: 'A staged system-plugin package the fake client describes without fetching anything.',
      version: '1.0.0',
      apiVersion: '1.0',
      compatible: true,
      supportedApiVersions: '1.0–1.0',
      source: source.kind,
      ...(source.kind === 'git' ? { remote: source.remote, commit: source.commit } : { path: source.path }),
      treeHash: digest,
      fileCount: 3,
      sizeBytes: 2048,
      capabilities: ['demo.state'],
      permissions: ['provide-capability'],
      dependencies: [],
      hasClient: false,
      // The fake must be exhaustive over the wire shape: a fixed fact, since
      // the fake stages nothing and so carries no files to count.
      i18n: { keys: 2, languages: ['en', 'zh'] },
      warnings: this.#plugins.has(id) ? [`id "${id}" 已被占用 / the id "${id}" is already in this catalog`] : [],
    }
    this.#previews.set(preview.previewToken, preview)
    return preview
  }

  /** Discard a preview. An unknown token is not an error — the same as the host. */
  cancelInstall(previewToken: string): void {
    this.#previews.delete(previewToken)
  }

  /**
   * Promote a previewed package, if every echoed field agrees with the preview.
   *
   * Ruling 5 is modelled too: an id already in the catalog is refused rather
   * than shadowed, which is what makes `plugin.confirmInstall` against
   * `tavern-helper` a refusal here as well as on the host.
   */
  confirmInstall(params: { previewToken: string, id: string, commit: string | null, treeHash: string }): SystemPluginSnapshot {
    const preview = this.#previews.get(params.previewToken)
    if (preview === undefined) {
      this.#refuse('invalid-request', `install-failed: no staged install for token ${JSON.stringify(params.previewToken)}`)
    }
    this.#previews.delete(params.previewToken)
    if (params.id !== preview.id) {
      this.#refuse('invalid-request', `install-failed: the confirmation names id ${JSON.stringify(params.id)}, the preview staged ${JSON.stringify(preview.id)}`)
    }
    if (params.treeHash !== preview.treeHash) {
      this.#refuse('invalid-request', `install-failed: the confirmation names treeHash ${params.treeHash}, the preview staged ${preview.treeHash}`)
    }
    if ((params.commit ?? null) !== (preview.commit ?? null)) {
      this.#refuse('invalid-request', `install-failed: the confirmation names commit ${String(params.commit)}, the preview staged ${String(preview.commit ?? null)}`)
    }
    if (this.#plugins.has(params.id)) {
      this.#refuse('invalid-request', `install-failed: id 已被占用 / the id "${params.id}" is already taken in this catalog`)
    }
    const row: SystemPluginView = {
      id: preview.id,
      name: preview.displayName,
      description: preview.description,
      version: preview.version,
      apiVersion: 1,
      dependencies: [...preview.dependencies],
      installed: true,
      enabled: false,
      status: 'disabled',
      source: preview.source,
      provenance: {
        ...(preview.remote !== undefined ? { remote: preview.remote } : {}),
        ...(preview.commit !== undefined ? { commit: preview.commit } : {}),
        ...(preview.path !== undefined ? { path: preview.path } : {}),
        treeHash: preview.treeHash,
        installedAt: new Date().toISOString(),
      },
    }
    this.#plugins.set(row.id, row)
    this.#revision += 1
    this.#emit(this.snapshot())
    return this.snapshot()
  }

  /**
   * Reserved and refused, on both sides of the wire.
   *
   * The fake refuses for the same reason and with the same code the host does
   * (`unsupported`), so a client that handles the refusal against this fake
   * handles it against a real host. A fake that quietly succeeded here would be
   * the single most misleading thing in this file: it would let a page ship an
   * update button that works in every test and fails for every user.
   */
  update(id: string): never {
    return this.#refuse(
      'unsupported',
      `plugin.update is reserved and not implemented (docs/SYSTEM-PLUGIN-INSTALL.md §12 ruling 2): to change "${id}"`
      + ' to another commit, uninstall it and install the new commit through the full consent step',
    )
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
