import fs from 'node:fs'
const p = 'packages/iris-app-service/src/index.ts'
let t = fs.readFileSync(p, 'utf8')
const before = t.length
const B = '`'

// ---- imports ----
t = t.replace(
  "import { refuseOverlappingInstall, StInstall } from './st-install.ts'",
  `import { refuseOverlappingInstall, StInstall } from './st-install.ts'
import {
  buildStExtensionDefinition,
  defaultSettingsBlob,
  hydrateSettingsBlob,
  normalizeManifest,
  StCompatBridge,
  StExtensionSettingsStore,
} from '@iris/compat-st-extension'
import { Installer, isValidExtensionId } from '@iris/extension-installer'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname as pathDirname } from 'node:path'
import { StExtensionAssetStore, ST_EXT_PREFIX } from './st-ext-assets.ts'`
)

// ---- the pilot block, inserted right after systemPlugins creation/initialize ----
t = t.replace(
  `  await systemPlugins.initialize()`,
  `  await systemPlugins.initialize()

  // ---- The ST-compat pilot (P3) ------------------------------------------
  // Installed third-party ST extensions join the runtime here: every directory
  // under installed/ with a valid lock becomes a definition the runtime runs
  // with the same lifecycle it gives TH and MVU, and the bridge the generation
  // path consults is built beside them. The pilot serves ONE extension id —
  // the first installed one — and says so rather than pretending otherwise.
  const stExtensionSettingsStore = new StExtensionSettingsStore(
    join(paths.root, 'st-extension-settings'),
    message => { ctx.logger.warn(message) },
  )
  const stCompatBridge = new StCompatBridge()
  ctx.effect(() => () => { stCompatBridge.dispose() }, 'irisApp.stCompat.bridge')

  const stExtensionId = (): string | undefined => {
    const row = systemPlugins.snapshot().plugins.find(plugin => plugin.installed)
    return row?.id
  }
  const stExtensionEnabledRevision = (extensionId: string): number | undefined => {
    const snapshot = systemPlugins.snapshot()
    const row = snapshot.plugins.find(plugin => plugin.id === extensionId)
    if (row === undefined || !row.installed || row.status !== 'enabled') return undefined
    return snapshot.revision
  }
  const stExtensionSettings = async (extensionId: string): Promise<Record<string, unknown>> => {
    return hydrateSettingsBlob(await stExtensionSettingsStore.read(extensionId) ?? defaultSettingsBlob())
  }

  // Boot scan: adopt every already-installed extension before any request can
  // name it. A lock without a manifest is reported and skipped, never fatal —
  // one broken install must not take the plugin plane down.
  try {
    const installedDir = join(paths.extensions, 'installed')
    const entries = await readdir(installedDir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!isValidExtensionId(entry)) continue
      try {
        const raw = JSON.parse(await readFile(join(installedDir, entry, 'content', 'manifest.json'), 'utf8')) as unknown
        const manifest = buildStExtensionManifest(raw)
        if (manifest === undefined) {
          ctx.logger.warn(\${B}the installed extension "${entry}" has a manifest Iris refuses; it stays inactive\${B})
          continue
        }
        systemPlugins.adoptDefinition(buildStExtensionDefinition({
          id: entry,
          manifest,
          memberBundlePath: join(dataDir, 'system-plugins', entry, 'client', 'client.js'),
        }), { installed: true })
      } catch (cause: unknown) {
        ctx.logger.warn(\${B}the installed extension "${entry}" could not be adopted: \${String(cause)}\${B})
      }
    }
  } catch { /* the extensions root does not exist yet — nothing installed */ }

  const stCompat = {
    bridge: stCompatBridge,
    extensionId: () => stExtensionId() ?? '',
    revisionOf: (extensionId: string): number | undefined => stExtensionEnabledRevision(extensionId),
    settingsFor: (extensionId: string): Promise<unknown> => stExtensionSettings(extensionId),
    persistSettings: async (extensionId: string, blob: unknown): Promise<void> => {
      await stExtensionSettingsStore.write(extensionId, blob)
    },
    installFromDirectory: async (directoryPath: string): Promise<SystemPluginSnapshot> => {
      // The id is the manifest's display name, slugified to the installer's
      // own rule — the same derivation the asset route's dirName uses, so the
      // installed tree and its URLs agree.
      const rawManifest = JSON.parse(await readFile(join(directoryPath, 'manifest.json'), 'utf8')) as { display_name?: unknown }
      if (typeof rawManifest.display_name !== 'string' || rawManifest.display_name === '') {
        throw new AppError('invalid-request', 'the extension directory has no manifest.json display_name to install under')
      }
      const id = rawManifest.display_name.toLowerCase().replace(/[^a-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '')
      if (!isValidExtensionId(id)) {
        throw new AppError('invalid-request', \${B}the extension's name "${String(rawManifest.display_name)}" does not slugify to a valid extension id\${B})
      }
      const installer = await Installer.create(paths.extensions)
      await installer.installAs(id, { kind: 'local-directory', directoryPath })
      const raw = JSON.parse(await readFile(join(paths.extensions, 'installed', id, 'content', 'manifest.json'), 'utf8')) as unknown
      systemPlugins.adoptDefinition(buildStExtensionDefinition({
        id,
        manifest,
        memberBundlePath: join(dataDir, 'system-plugins', id, 'client', 'client.js'),
      }), { installed: true })
      return systemPlugins.snapshot()
    },
  }

  /** The manifest the definition factory needs, or undefined when refused. */
  function buildStExtensionManifest(raw: unknown): ReturnType<typeof normalizeManifest> extends { ok: true, manifest: infer M } ? M : never {
    const parsed = normalizeManifest(raw)
    if (!parsed.ok) throw new Error(parsed.issues.map(issue => `${issue.field}: ${issue.message}`).join('; '))
    return parsed.manifest
  }
  // ---- end pilot block ----`
)

fs.writeFileSync(p, t)
console.log('index part1 ok, delta', t.length - before)
