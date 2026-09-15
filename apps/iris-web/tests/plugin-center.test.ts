import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createFakeClient } from '@iris/client-fake'
import type {
  SystemPluginFailureState, SystemPluginInstallPreview, SystemPluginSnapshot, SystemPluginView,
} from '@iris/protocol'
import { createServer } from 'vite'

import { createIrisStore } from '../src/client/store.ts'

/** The shell globals a server render reads before any effect runs. */
function installShellGlobals(): void {
  const stored = new Map<string, string>([['iris.language', 'en']])
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
  }
  Object.assign(globalThis, {
    window: {
      localStorage,
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} } },
  })
}

test('plugin center renders factual lifecycle, dependency and host-error guidance in both languages', async t => {
  const stored = new Map<string, string>([['iris.language', 'en']])
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
  }
  Object.assign(globalThis, {
    window: {
      localStorage,
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    document: { documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} } },
  })

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'plugin center test' })
  t.after(async () => {
    wired.dispose()
    client.dispose()
    await server.close()
  })
  await wired.store.getState().boot()

  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as {
    renderPluginCenter: (store: typeof wired.store) => string
    setLanguage: (language: 'en' | 'zh') => void
  }
  const render = (): string => harness.renderPluginCenter(wired.store)

  const enabled = render()
  assert.match(enabled, /data-plugin-id="tavern-helper"/)
  assert.match(enabled, /Disable MVU first/)
  assert.match(enabled, /<button[^>]*disabled=""[^>]*title="Disable MVU first\."/)
  assert.match(enabled, /Uninstalling keeps card and chat data/)
  // The browser-asset half of the status surface renders beside the host chip,
  // even before any manifest fetch has answered (SSR shows the loading phase).
  assert.match(enabled, /data-plugin-asset-phase="loading"/)
  assert.match(enabled, /Browser asset/)
  assert.match(enabled, /Expected revision/)
  assert.doesNotMatch(enabled, /marketplace|download package/i)

  const current = wired.store.getState().systemPlugins
  assert.ok(current !== undefined)
  const failed: SystemPluginSnapshot = {
    revision: current.revision + 1,
    plugins: current.plugins.map(plugin => plugin.id === 'mvu'
      ? {
          ...plugin,
          enabled: false,
          status: 'error',
          error: 'MVU activation failed because TavernHelper did not publish its API.',
        }
      : plugin),
  }
  wired.store.setState({ systemPlugins: failed })
  const errored = render()
  assert.match(errored, /Host error:/)
  assert.match(errored, /MVU activation failed because TavernHelper did not publish its API/)
  assert.match(errored, />Retry enable<\/button>/)
  assert.match(errored, /Fix the reported cause, then retry enable or uninstall this plugin/)

  harness.setLanguage('zh')
  const chinese = render()
  assert.match(chinese, /宿主错误：/)
  assert.match(chinese, />重试启用<\/button>/)
  assert.match(chinese, /请先处理上述原因/)
  assert.match(chinese, /宿主运行时/)
  assert.match(chinese, /浏览器资产/)
  assert.match(chinese, /期望 revision/)
  assert.match(chinese, /实际加载 revision/)
  assert.match(chinese, /最近成功加载/)
  assert.match(chinese, /data-plugin-asset-phase="loading"/)
  assert.match(chinese, /未声明/, 'a plugin the host does not run shows its browser asset as undeclared')
})

/**
 * One row per named failure state, plus the three sources and the consent page.
 *
 * Server-rendered on purpose: everything here is a *projection* — what the page
 * says for a row the host describes a given way — and a projection is exactly
 * what a server render is good for. The clicks live in
 * `plugin-center-install.test.ts`.
 */
test('every failure state, every source badge and the consent page read in both languages', async t => {
  installShellGlobals()

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'plugin failure states test' })
  t.after(async () => {
    wired.dispose()
    client.dispose()
    await server.close()
  })
  await wired.store.getState().boot()

  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as {
    renderPluginCenter: (store: typeof wired.store) => string
    renderConsent: (preview: SystemPluginInstallPreview, lang?: 'en' | 'zh') => string
    setLanguage: (language: 'en' | 'zh') => void
  }
  harness.setLanguage('en')

  const STATES: readonly SystemPluginFailureState[] = [
    'install-failed', 'manifest-invalid', 'incompatible', 'tampered', 'load-failed', 'activate-failed',
  ]
  const row = (state: SystemPluginFailureState, index: number): SystemPluginView => ({
    id: `pkg-${state}`,
    name: `Package ${state}`,
    description: `a row the host describes as ${state}`,
    version: '1.0.0',
    apiVersion: 1,
    dependencies: [],
    installed: true,
    enabled: false,
    status: 'error',
    source: 'git',
    provenance: {
      remote: 'https://example.invalid/acme/pkg.git',
      commit: String(index).repeat(40).slice(0, 40),
      treeHash: String(index).repeat(64).slice(0, 64),
      installedAt: '2026-09-15T02:11:04.912Z',
    },
    failure: {
      state,
      ...(state === 'manifest-invalid' ? { field: 'iris.plugin.host' } : {}),
      ...(state === 'load-failed' ? { field: 'activate' } : {}),
      ...(state === 'install-failed' ? { step: 'fetch' } : {}),
      reason: `the host's own sentence for ${state}`,
    },
  })
  const dev: SystemPluginView = {
    id: 'pkg-dev', name: 'Package dev', description: 'loaded in place', version: '0.1.0', apiVersion: 1,
    dependencies: [], installed: true, enabled: false, status: 'disabled',
    source: 'dev', provenance: { path: 'D:/packages/iris-plugin-demo' },
  }
  const builtin: SystemPluginView = {
    id: 'pkg-builtin', name: 'Package builtin', description: 'ships with Iris', version: '0.0.0', apiVersion: 1,
    dependencies: [], installed: true, enabled: false, status: 'disabled', source: 'builtin',
  }
  const current = wired.store.getState().systemPlugins
  assert.ok(current !== undefined)
  wired.store.setState({
    systemPlugins: {
      revision: current.revision + 1,
      plugins: [...STATES.map(row), dev, builtin],
    } satisfies SystemPluginSnapshot,
  })

  const english = harness.renderPluginCenter(wired.store)

  // Each of the six is named, and each says what it means AND what to do — two
  // separate sentences, because "what happened" and "what now" are two
  // questions and a row that answers only the first is a dead end.
  const MEANING: Record<SystemPluginFailureState, RegExp> = {
    'install-failed': /never finished installing/,
    'manifest-invalid': /manifest is not something Iris can read/,
    incompatible: /plugin API this build of Iris does not implement/,
    tampered: /not the files Iris recorded/,
    'load-failed': /threw while Iris was loading it/,
    'activate-failed': /loaded, then threw while starting/,
  }
  const FIX: Record<SystemPluginFailureState, RegExp> = {
    'install-failed': /Uninstall this row, then install the package again/,
    'manifest-invalid': /Only the author can fix this/,
    incompatible: /Ask the author for a release built against a plugin API this build supports/,
    tampered: /Reinstall from the recorded remote and commit/,
    'load-failed': /Fix the file named above, then retry enable/,
    'activate-failed': /Iris rolled back everything it had registered/,
  }
  for (const state of STATES) {
    assert.match(english, new RegExp(`data-plugin-failure="${state}"`), `${state} has no failure block`)
    assert.match(english, MEANING[state], `${state} does not say what it means`)
    assert.match(english, FIX[state], `${state} does not say what to do about it`)
    assert.match(english, new RegExp(`the host&#x27;s own sentence for ${state}`), `${state} drops the host's own reason`)
  }
  assert.match(english, /Field: iris\.plugin\.host/, 'manifest-invalid does not name its field')
  assert.match(english, /Field: activate/, 'load-failed does not name its field')
  assert.match(english, /Git step: fetch/, 'install-failed does not name the git step')

  // Ruling 3: the one way out of `tampered`, and no way around it.
  assert.match(english, /data-plugin-reinstall="pkg-tampered"/, 'a tampered row offers no reinstall')
  assert.equal(english.match(/data-plugin-reinstall=/g)?.length, 1, 'a state other than tampered offers a reinstall')
  assert.doesNotMatch(english, /accept (the )?current bytes/i, 'there is an accept-current-bytes affordance')
  assert.doesNotMatch(english, /plugin\.update|check for updates/i, 'ruling 2 reserved plugin.update and the page offers it')

  // Ruling 1: `dev` is marked on the row, and the three sources read apart.
  // Matched on the badge's own class, not on `data-plugin-source`: the article
  // carries that attribute too, so the looser pattern stays green with the
  // badge deleted — measured, not assumed (mutation 3 in the ledger).
  assert.match(english, /class="iris-plugin__source iris-plugin__source--dev"[^>]*>dev</, 'a dev row carries no source badge')
  assert.match(english, /class="iris-plugin__source iris-plugin__source--git"[^>]*>git</, 'a git row carries no source badge')
  assert.match(english, /class="iris-plugin__source iris-plugin__source--builtin"[^>]*>bundled</, 'a builtin row carries no source badge')
  assert.match(english, /Loaded in place from a directory on this machine/, 'the dev badge carries no disclosure')

  // Provenance: compact on the row, complete inside it.
  assert.match(english, /data-plugin-provenance/, 'an installed git row records no provenance')
  // `<!-- -->` is React's own text-node separator in a server render.
  assert.match(english, /Recorded at install<!-- --> — 333333333333… · 333333333333… · 2026-09-15/, 'the row does not abbreviate the recorded commit and tree hash')
  assert.match(english, /data-provenance-field="commit"/, 'the expanded provenance omits the commit')
  assert.match(english, /data-provenance-field="treeHash"/, 'the expanded provenance omits the tree hash')
  assert.match(english, /data-provenance-field="installedAt"/, 'the expanded provenance omits the install date')
  assert.match(english, /data-provenance-field="path"/, 'a dev row does not show the directory it loads from')
  assert.ok(english.includes('3'.repeat(40)), 'the full commit is nowhere on the page')

  // The uninstall sentence forks three ways.
  assert.match(english, /data-uninstall-copy="git"[^>]*>Uninstalling deletes the installed tree/, 'a git row does not say the tree is deleted')
  assert.match(english, /data-uninstall-copy="dev"[^>]*>Uninstalling removes the catalog row only/, 'a dev row does not say the directory is left alone')
  assert.doesNotMatch(english, /data-uninstall-copy="builtin"/, 'a builtin row grew a per-row uninstall note')
  assert.match(english, /Uninstalling keeps card and chat data/, 'the builtin retention sentence is gone')

  harness.setLanguage('zh')
  const chinese = harness.renderPluginCenter(wired.store)
  const ZH: Record<SystemPluginFailureState, RegExp> = {
    'install-failed': /这个包没有安装完。/,
    'manifest-invalid': /不是 Iris 读得懂的形状/,
    incompatible: /本次构建没有实现的插件 API/,
    tampered: /与安装时 Iris 记录下来的不符/,
    'load-failed': /它还没开始运行/,
    'activate-failed': /但在启动时抛了错/,
  }
  for (const state of STATES) {
    assert.match(chinese, ZH[state], `${state} has no Chinese sentence`)
  }
  assert.match(chinese, /无法运行：/, 'the Chinese failure block has no title')
  assert.match(chinese, /字段：iris\.plugin\.host/, 'the Chinese manifest-invalid does not name its field')
  assert.match(chinese, /git 步骤：fetch/, 'the Chinese install-failed does not name the git step')
  assert.match(chinese, /按记录的 remote \+ commit 重新安装/, 'the Chinese reinstall button is missing')
  assert.match(chinese, /卸载会从这个 profile 里删掉安装树/, 'the Chinese git uninstall copy is missing')
  assert.match(chinese, /你的开发目录绝不会被碰/, 'the Chinese dev uninstall copy is missing')
  assert.match(chinese, /dev 本地/, 'the Chinese dev badge is missing')
  assert.match(chinese, /安装时记录/, 'the Chinese provenance summary is missing')
  harness.setLanguage('en')

  // ---------------------------------------------------------- the consent page

  const preview: SystemPluginInstallPreview = {
    previewToken: 'preview-0f0f0f0f',
    id: 'acme-demo',
    displayName: 'Acme Demo',
    description: 'a staged package',
    version: '2.1.0',
    apiVersion: '2.0',
    compatible: false,
    supportedApiVersions: '1.0–1.0',
    source: 'git',
    remote: 'https://example.invalid/acme/demo.git',
    commit: 'b'.repeat(40),
    treeHash: 'c'.repeat(64),
    fileCount: 42,
    sizeBytes: 2_097_152,
    capabilities: ['demo.state'],
    permissions: ['provide-capability', 'register-rpc'],
    dependencies: ['tavern-helper'],
    hasClient: true,
    warnings: ['a declared dependency is not in this profile'],
  }
  const consent = harness.renderConsent(preview)
  const shown = new Set([...consent.matchAll(/data-consent-field="([a-zA-Z]+)"/g)].map(match => match[1]!))
  const expected = Object.keys(preview).filter(key => key !== 'previewToken')
  assert.ok(expected.length >= 18, `a git preview carries at least 18 displayable fields, saw ${String(expected.length)}`)
  assert.deepEqual(expected.filter(key => !shown.has(key)), [], 'preview fields the consent page never renders')

  // An incompatible preview still shows the whole page — and refuses.
  assert.match(consent, /data-consent-confirm[^>]*disabled=""/, 'an incompatible package can be confirmed')
  assert.match(consent, /This build cannot run this package, so it cannot be installed/, 'the incompatible reason is missing')
  assert.match(consent, /No — this build does not implement it\./, 'the compatibility verdict is missing')
  assert.match(consent, /<dt>Size<\/dt><dd>2\.0 MB<\/dd>/, 'the size is a raw byte count, not human units')
  assert.match(consent, /Ships a client\.js/, 'the browser bundle is not described')
  assert.match(consent, /not a boundary Iris enforces/, 'the permissions list is presented as a boundary')
  assert.match(consent, /Iris has no registry to check this against/, 'the capabilities list is presented as verified')
  assert.match(consent, /This is host code/, 'the consent page does not say this is same-privilege code')
  assert.match(consent, /aria-label="What this package is, and what installing it means"/, 'the disclosure has no accessible name')

  // `delete` rather than `remote: undefined`: for a dev source those keys are
  // absent on the wire, and `exactOptionalPropertyTypes` is right that absent
  // and present-but-undefined are two shapes.
  const devPreview: SystemPluginInstallPreview = {
    ...preview, compatible: true, source: 'dev', path: 'D:/packages/iris-plugin-demo',
  }
  delete devPreview.remote
  delete devPreview.commit
  const devConsent = harness.renderConsent(devPreview, 'zh')
  assert.match(devConsent, /data-plugin-consent="dev"/, 'the dev consent page is not marked dev')
  assert.match(devConsent, /永远不会与记录下来的哈希复核/, 'the Chinese dev consent page omits ruling 1\'s disclosure')
  assert.match(devConsent, /这是宿主代码/, 'the Chinese consent page does not say this is same-privilege code')
  assert.match(devConsent, /不是 Iris 强制的边界/, 'the Chinese permissions note is missing')
  assert.doesNotMatch(devConsent, /data-consent-confirm[^>]*disabled=""/, 'a compatible package cannot be confirmed')
  const devShown = new Set([...devConsent.matchAll(/data-consent-field="([a-zA-Z]+)"/g)].map(match => match[1]!))
  assert.ok(devShown.has('path'), 'the dev consent page hides the directory it would load from')
  assert.ok(!devShown.has('remote') && !devShown.has('commit'), 'a dev package rendered a remote it does not have')
})
