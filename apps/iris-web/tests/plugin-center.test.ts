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
  assert.match(enabled, /Catalog revision/)
  assert.match(enabled, /Manifest revision/, 'the manifest generation cell is missing beside the catalog generation')
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
  assert.match(chinese, /目录 revision/)
  assert.match(chinese, /清单 revision/, 'the manifest generation cell has no Chinese label')
  assert.match(chinese, /资产内容 rev/)
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
    'install-failed', 'manifest-invalid', 'incompatible', 'tampered', 'load-failed', 'activate-failed', 'hook-failed',
  ]
  const row = (state: SystemPluginFailureState, index: number): SystemPluginView => ({
    id: `pkg-${state}`,
    name: `Package ${state}`,
    description: `a row the host describes as ${state}`,
    version: '1.0.0',
    apiVersion: 1,
    dependencies: [],
    installed: true,
    // `hook-failed` is the one state that rides on a healthy enabled row (the
    // plugin still runs); every other failure is `status: 'error'`.
    ...state === 'hook-failed' ? { enabled: true, status: 'enabled' as const } : { enabled: false, status: 'error' as const },
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
  // A second builtin row: the real catalog seats two (TavernHelper, MVU), and
  // the copy must read for both of them. `enabled: false` here is what makes
  // the asset reduce to `undeclared` under an SSR (no manifest fetch); the
  // real pair is enabled with no manifest row, which is the same phase.
  const builtinTwo: SystemPluginView = {
    id: 'pkg-builtin-two', name: 'Package builtin two', description: 'also ships with Iris', version: '0.0.0', apiVersion: 1,
    dependencies: [], installed: true, enabled: false, status: 'disabled', source: 'builtin',
  }
  const current = wired.store.getState().systemPlugins
  assert.ok(current !== undefined)
  wired.store.setState({
    systemPlugins: {
      revision: current.revision + 1,
      plugins: [...STATES.map(row), dev, builtin, builtinTwo],
    } satisfies SystemPluginSnapshot,
  })

  const english = harness.renderPluginCenter(wired.store)
  /** Slice one row's markup by its `data-plugin-id`, so a per-row claim cannot be satisfied by another row. */
  const articleOf = (html: string, id: string): string => {
    const at = html.indexOf(`data-plugin-id="${id}"`)
    assert.ok(at >= 0, `no row rendered for ${id}`)
    return html.slice(at, html.indexOf('</article>', at))
  }

  // Each of the seven is named, and each says what it means AND what to do — two
  // separate sentences, because "what happened" and "what now" are two
  // questions and a row that answers only the first is a dead end.
  const MEANING: Record<SystemPluginFailureState, RegExp> = {
    'install-failed': /never finished installing/,
    'manifest-invalid': /manifest is not something Iris can read/,
    incompatible: /plugin API this build of Iris does not implement/,
    tampered: /not the files Iris recorded/,
    'load-failed': /threw while Iris was loading it/,
    'activate-failed': /loaded, then threw while starting/,
    'hook-failed': /The variable write failed or timed out this turn; the reply itself settled normally/,
  }
  const FIX: Record<SystemPluginFailureState, RegExp> = {
    'install-failed': /Uninstall this row, then install the package again/,
    'manifest-invalid': /Only the author can fix this/,
    incompatible: /Ask the author for a release built against a plugin API this build supports/,
    tampered: /Reinstall from the recorded remote and commit/,
    'load-failed': /Fix the file named above, then retry enable/,
    'activate-failed': /Iris rolled back everything it had registered/,
    'hook-failed': /The plugin is still running; its next successful write clears this notice/,
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
  // Ruling 2 was reserved when this assertion was written, and the page was
  // forbidden to offer an update. U1 implemented the update transaction
  // (`docs/SYSTEM-PLUGIN-INSTALL.md` §5.4), so the blanket ban is retired —
  // retired, not loosened, exactly as this file's own ledger §99 arranged when
  // it said the implementer would find this line and delete it. What replaced
  // it is *stricter where it matters*: the update entry exists on installed
  // `git` rows and nowhere else, matched on the button's own attribute rather
  // than the `<article>`'s `data-plugin-source` (the same blunt-match trap the
  // source-badge test fell into before its mutation tightened it).
  const updateButtons: string[] = english.match(/data-plugin-update="[^"]+"/g) ?? []
  // One entry per installed `git` row in the fixture — `STATES.length`, not a
  // literal: the fixture grew a seventh state (`hook-failed`, U2) in the same
  // week this line was written, and a pinned `6` reddened a correct page for
  // the wrong reason. The loop below pins the other direction (every state
  // has its entry), and the two `doesNotMatch` lines pin dev and builtin.
  assert.equal(updateButtons.length, STATES.length, 'an update entry appeared on a row that is not an installed git row')
  for (const state of STATES) {
    assert.ok(updateButtons.includes(`data-plugin-update="pkg-${state}"`), `${state} (git, installed) offers no update entry`)
  }
  assert.doesNotMatch(english, /data-plugin-update="pkg-dev"/, 'a dev row offers an update entry')
  assert.doesNotMatch(english, /data-plugin-update="pkg-builtin"/, 'a builtin row offers an update entry')
  assert.match(english, /data-plugin-dev-note/, 'a dev row does not say why it needs no update')

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

  // W1: a builtin ships no browser bundle — its frame members ride the core
  // member bundle — so the three cells that read like a fault are replaced by
  // one sentence. The claim is per row: `pkg-install-failed` is a `git` row
  // whose asset is `undeclared` too, and for a third party that phase is real
  // information, so it must keep the cells. Matched on the row's own slice and
  // on the sentence's own `data-plugin-builtin-asset-note` stamp, not on the
  // page: a blunt whole-page match stays green while a git row is wrongly
  // swallowed by the branch.
  const builtinOneRow = articleOf(english, 'pkg-builtin')
  const builtinTwoRow = articleOf(english, 'pkg-builtin-two')
  for (const [id, row] of [['pkg-builtin', builtinOneRow], ['pkg-builtin-two', builtinTwoRow]] as const) {
    assert.match(row, /data-plugin-asset-phase="undeclared"/, `${id} is not the undeclared case this branch is for`)
    assert.match(row, /data-plugin-builtin-asset-note/, `${id} does not say in words why it has no browser asset`)
    assert.match(row, /frame members load with the core member bundle/, `${id} lacks the builtin-asset sentence`)
    assert.doesNotMatch(row, /Never/, `${id} still shows "Never"`)
    assert.doesNotMatch(row, /Browser asset/, `${id} still shows the browser-asset cells`)
  }
  const gitUndeclaredRow = articleOf(english, 'pkg-install-failed')
  assert.doesNotMatch(gitUndeclaredRow, /data-plugin-builtin-asset-note/, 'a third-party `undeclared` row was given the builtin sentence')
  assert.match(gitUndeclaredRow, /Browser asset/, 'a third-party `undeclared` row lost its browser-asset cells')
  assert.match(gitUndeclaredRow, /Never/, 'a third-party `undeclared` row no longer says it was never loaded')

  harness.setLanguage('zh')
  const chinese = harness.renderPluginCenter(wired.store)
  const ZH: Record<SystemPluginFailureState, RegExp> = {
    'install-failed': /这个包没有安装完。/,
    'manifest-invalid': /不是 Iris 读得懂的形状/,
    incompatible: /本次构建没有实现的插件 API/,
    tampered: /与安装时 Iris 记录下来的不符/,
    'load-failed': /它还没开始运行/,
    'activate-failed': /但在启动时抛了错/,
    'hook-failed': /变量写入失败或超时了，本轮回复已正常结算/,
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
  // W1's copy exists in both languages, for both builtin rows.
  assert.match(chinese, /内置插件的帧侧成员随核心成员包加载，没有独立的浏览器包。/, 'the Chinese builtin-asset sentence is missing')
  assert.equal(chinese.match(/data-plugin-builtin-asset-note/g)?.length, 2, 'the Chinese builtin-asset sentence is not on both builtin rows')
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
    i18n: { keys: 4, languages: ['en', 'zh'] },
    warnings: ['a declared dependency is not in this profile'],
  }
  const consent = harness.renderConsent(preview)
  const shown = new Set([...consent.matchAll(/data-consent-field="([a-zA-Z0-9]+)"/g)].map(match => match[1]!))
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
  const devShown = new Set([...devConsent.matchAll(/data-consent-field="([a-zA-Z0-9]+)"/g)].map(match => match[1]!))
  assert.ok(devShown.has('path'), 'the dev consent page hides the directory it would load from')
  assert.ok(!devShown.has('remote') && !devShown.has('commit'), 'a dev package rendered a remote it does not have')

  // -------------------------------------------------- an update preview's page

  // `plugin.update` mints the same preview carrying `updateOf`, and the set
  // comparison above is exactly the law that forces the page to grow the row:
  // a field on the wire that the page never renders is this failure, not a
  // quietly shorter page. The user consents to a *replacement* — the row, the
  // commit it records, and the tree hash it will stop having.
  const updatePreview: SystemPluginInstallPreview = {
    ...preview, compatible: true,
    updateOf: { id: 'acme-demo', fromCommit: 'a'.repeat(40), fromTreeHash: 'd'.repeat(64) },
  }
  const updateConsent = harness.renderConsent(updatePreview, 'en')
  const updateShown = new Set([...updateConsent.matchAll(/data-consent-field="([a-zA-Z]+)"/g)].map(match => match[1]!))
  assert.ok(updateShown.has('updateOf'), 'an update preview rendered no updateOf row')
  assert.match(updateConsent, /Commit a{12}…, updating to b{12}…/, 'the updateOf row does not name both commits')
  assert.match(updateConsent, /Tree hash d{12}… becomes c{12}…/, 'the updateOf row does not name both tree hashes')
  assert.match(updateConsent, /enabled preference is kept/, 'the updateOf note does not say what an update preserves')
  const plainConsent = harness.renderConsent(preview)
  assert.doesNotMatch(plainConsent, /data-consent-field="updateOf"/, 'a fresh-install preview rendered an updateOf row')
})
