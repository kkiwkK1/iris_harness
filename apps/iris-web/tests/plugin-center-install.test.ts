import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (...args: unknown[]) => { window: Window & typeof globalThis }
}

import { createFakeClient } from '@iris/client-fake'
import type { IrisClient, SystemPluginInstallPreview, SystemPluginSnapshot } from '@iris/protocol'
import { createServer } from 'vite'

import { createIrisStore } from '../src/client/store.ts'

/**
 * The install path, clicked.
 *
 * `plugin-center.test.ts` renders this surface with `react-dom/server`, which
 * is the right instrument for copy and for a row whose state the store can be
 * put into — and the wrong one for everything here: the install form's
 * submit, the consent page's two buttons and a `tampered` row's reinstall are
 * all `useState` transitions behind a click, and a server render cannot click.
 *
 * So this file mounts the real component in jsdom under React `act`, against
 * the real fake client, and asserts on **what the client was called with** —
 * not on what the page says it sent. The distinction is the whole point: a
 * page that echoes a re-typed id instead of the preview's would render
 * identically and send a different consent.
 *
 * The harness is the same one the server-rendered file uses
 * (`plugin-center-harness.tsx`), extended with `mountPluginCenter`; it is
 * loaded through vite because Node's type stripping does not transform JSX.
 */

interface RecordedCall { method: string, params: unknown, result?: unknown, error?: unknown }

test('the install form, the consent page and the tampered reinstall, driven by clicks', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = {
    fetch: globalThis.fetch,
    navigator: (globalThis as Record<string, unknown>)['navigator'],
  }
  const stored = new Map<string, string>([['iris.language', 'en']])
  dom.window.localStorage.setItem('iris.language', 'en')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  // The browser-asset probe must not answer during this test: a never-settling
  // fetch parks every row at `loading`, which is what a server render shows
  // too, so the rows read the same in both files.
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch
  void stored

  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  const client = createFakeClient({ chunkDelayMs: 0 })

  /*
   * Every RPC, with its params and its answer. Asserting on this rather than on
   * the DOM is what makes "confirm echoes the preview's own fields" a testable
   * claim at all — the echoed values are never rendered as the request, only as
   * the package's facts.
   */
  const calls: RecordedCall[] = []
  const recorder = {
    call: async (method: string, params: unknown) => {
      const entry: RecordedCall = { method, params }
      calls.push(entry)
      try {
        entry.result = await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
        return entry.result
      } catch (error: unknown) {
        entry.error = error
        throw error
      }
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => client.onConnectionChange(listener),
  } as unknown as IrisClient

  const wired = createIrisStore(recorder, { transport: 'fake', origin: 'plugin install test' })
  await wired.store.getState().boot()

  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as {
    mountPluginCenter: (store: typeof wired.store, container: Element) => Promise<{
      html: () => string
      find: (selector: string) => Element | null
      click: (selector: string) => Promise<void>
      type: (selector: string, value: string) => Promise<void>
      settle: (work?: () => void) => Promise<void>
      unmount: () => Promise<void>
    }>
  }
  const page = await harness.mountPluginCenter(wired.store, dom.window.document.getElementById('root')!)

  t.after(async () => {
    await page.unmount()
    wired.dispose()
    client.dispose()
    await server.close()
    globalThis.fetch = previous.fetch
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
    delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  })

  const pluginCalls = (method: string): RecordedCall[] => calls.filter(row => row.method === method)
  const lastCall = (method: string): RecordedCall => {
    const rows = pluginCalls(method)
    const row = rows[rows.length - 1]
    assert.ok(row !== undefined, `no ${method} call was made`)
    return row
  }

  const REMOTE = 'https://example.invalid/acme/iris-plugin-demo.git'
  const COMMIT = '0123456789abcdef0123456789abcdef01234567'

  // ------------------------------------------------- the entry and its checks

  assert.ok(page.find('[data-plugin-install="closed"]') !== null, 'the catalog head has no install entry')
  await page.click('[data-plugin-install="closed"] button')
  assert.ok(page.find('[data-plugin-install="git"]') !== null, 'the install entry did not open the git form')

  await page.click('form[data-plugin-install] button[type="submit"]')
  assert.match(page.html(), /Enter the remote URL of the package repository/, 'an empty remote was sent without a word')
  assert.equal(pluginCalls('plugin.previewInstall').length, 0, 'an empty remote reached the host')

  await page.type('#iris-plugin-install-remote', REMOTE)
  await page.type('#iris-plugin-install-commit', 'main')
  await page.click('form[data-plugin-install] button[type="submit"]')
  assert.match(page.html(), /exactly 40 lowercase hexadecimal characters/, 'a branch name passed the client-side check')
  assert.equal(pluginCalls('plugin.previewInstall').length, 0, 'a branch name reached the host')

  await page.type('#iris-plugin-install-commit', COMMIT.toUpperCase())
  await page.click('form[data-plugin-install] button[type="submit"]')
  assert.equal(pluginCalls('plugin.previewInstall').length, 0, 'an upper-case commit reached the host')

  // ------------------------------------------------------- preview → consent

  await page.type('#iris-plugin-install-commit', COMMIT)
  await page.click('form[data-plugin-install] button[type="submit"]')
  await page.settle()

  assert.deepEqual(lastCall('plugin.previewInstall').params, { source: { kind: 'git', remote: REMOTE, commit: COMMIT } })
  const preview = lastCall('plugin.previewInstall').result as SystemPluginInstallPreview
  assert.ok(page.find('[data-plugin-consent="git"]') !== null, 'a staged preview did not open the consent page')
  assert.equal(page.find('[data-plugin-center] .iris-plugins__list'), null, 'the consent page left the catalog list behind it')

  /*
   * The floor, derived from the preview the host actually answered with rather
   * than from a list written here: every key of `SystemPluginInstallPreview`
   * except the token has to reach the page. A field added to the wire and
   * forgotten in the component fails here without anyone remembering to extend
   * a sample.
   */
  const shown = new Set([...page.html().matchAll(/data-consent-field="([a-zA-Z0-9]+)"/g)].map(match => match[1]!))
  const expected = Object.keys(preview).filter(key => key !== 'previewToken')
  assert.ok(expected.length >= 17, `a git preview should carry at least 17 displayable fields, saw ${String(expected.length)}`)
  assert.deepEqual(expected.filter(key => !shown.has(key)), [], 'preview fields the consent page never renders')
  assert.ok(page.html().includes(preview.treeHash), 'the consent page hides the tree hash it is asking about')
  assert.ok(page.html().includes(COMMIT), 'the consent page hides the commit it is asking about')
  assert.match(page.html(), /This is host code/, 'the consent page does not say this is same-privilege code')
  assert.match(page.html(), /not a boundary Iris enforces/, 'the permissions list is presented as a boundary')

  // ------------------------------------ confirm echoes the preview, not a form

  await page.click('[data-consent-confirm]')
  await page.settle()
  assert.deepEqual(lastCall('plugin.confirmInstall').params, {
    previewToken: preview.previewToken,
    id: preview.id,
    commit: preview.commit ?? null,
    treeHash: preview.treeHash,
  }, 'the confirmation is not the preview the user was shown')
  assert.equal(page.find('[data-plugin-consent]'), null, 'a confirmed install left the consent page up')
  assert.ok(page.find(`[data-plugin-id="${preview.id}"]`) !== null, 'the installed package is not in the catalog')
  assert.equal(pluginCalls('plugin.cancelInstall').length, 0, 'a confirmed token was cancelled as well')

  // ------------------------------------------- cancel discards the token, dev

  await page.click('[data-plugin-install="closed"] button')
  await page.click('input[value="dev"]')
  await page.type('#iris-plugin-install-path', 'D:/packages/iris-plugin-demo')
  await page.click('form[data-plugin-install] button[type="submit"]')
  await page.settle()
  assert.deepEqual(lastCall('plugin.previewInstall').params, { source: { kind: 'dev', path: 'D:/packages/iris-plugin-demo' } })
  const devPreview = lastCall('plugin.previewInstall').result as SystemPluginInstallPreview
  assert.ok(page.find('[data-plugin-consent="dev"]') !== null, 'a dev preview did not open the consent page')
  assert.match(page.html(), /never re-verified against a recorded hash/, 'the dev consent page does not disclose the missing check')
  const devShown = new Set([...page.html().matchAll(/data-consent-field="([a-zA-Z0-9]+)"/g)].map(match => match[1]!))
  assert.deepEqual(
    Object.keys(devPreview).filter(key => key !== 'previewToken').filter(key => !devShown.has(key)),
    [], 'preview fields the dev consent page never renders',
  )

  await page.click('[data-consent-cancel]')
  await page.settle()
  assert.deepEqual(lastCall('plugin.cancelInstall').params, { previewToken: devPreview.previewToken })
  assert.ok(page.find('[data-plugin-center] .iris-plugins__list') !== null, 'cancel did not return to the catalog list')

  // ------------------------------------------- a host refusal, word for word

  // The form is still open, still in `dev` mode: cancelling a consent returns
  // to the list without throwing away what was typed.
  assert.ok(page.find('[data-plugin-install="dev"]') !== null, 'cancelling the consent also closed the form')
  await page.click('input[value="git"]')
  await page.type('#iris-plugin-install-remote', REMOTE)
  await page.type('#iris-plugin-install-commit', 'abcdef0123456789abcdef0123456789abcdef01')
  await page.click('form[data-plugin-install] button[type="submit"]')
  await page.settle()
  const stale = lastCall('plugin.previewInstall').result as SystemPluginInstallPreview
  // Pull the transaction out from under the open consent page, the way a
  // crash-recovery sweep or a second window would.
  await recorder.call('plugin.cancelInstall', { previewToken: stale.previewToken })
  await page.click('[data-consent-confirm]')
  await page.settle()
  const refusal = lastCall('plugin.confirmInstall').error as { message: string }
  assert.match(refusal.message, /^install-failed: no staged install for token/, 'the fake refused in an unexpected shape')
  assert.ok(page.html().includes(refusal.message), 'the host\'s own refusal is not on the page')
  await page.click('[data-consent-cancel]')
  await page.settle()

  // ------------------------- §12 ruling 3: uninstall, then the same consent

  const current = wired.store.getState().systemPlugins
  assert.ok(current !== undefined)
  const tamperedRemote = 'https://example.invalid/acme/mvu.git'
  const tamperedCommit = 'fedcba9876543210fedcba9876543210fedcba98'
  const tampered: SystemPluginSnapshot = {
    revision: current.revision + 1,
    plugins: current.plugins.map(plugin => plugin.id === 'mvu'
      ? {
          ...plugin,
          enabled: false,
          status: 'error' as const,
          source: 'git' as const,
          provenance: {
            remote: tamperedRemote,
            commit: tamperedCommit,
            treeHash: 'a'.repeat(64),
            installedAt: '2026-09-15T02:11:04.912Z',
          },
          failure: { state: 'tampered' as const, reason: 'the tree hash on disk is not the one recorded at install' },
        }
      : plugin),
  }
  await page.settle(() => { wired.store.setState({ systemPlugins: tampered }) })

  assert.ok(page.find('[data-plugin-reinstall="mvu"]') !== null, 'a tampered row offers no way back')
  assert.equal(page.html().includes('accept the current bytes'), false, 'there is an accept-current-bytes button')
  const before = calls.length
  await page.click('[data-plugin-reinstall="mvu"]')
  await page.settle()

  const after = calls.slice(before).filter(row => row.method.startsWith('plugin.'))
  assert.deepEqual(after.map(row => row.method), ['plugin.uninstall', 'plugin.previewInstall'],
    'the reinstall did not run uninstall before staging — ruling 5 refuses a confirm while the id is still taken')
  assert.deepEqual(after[0]?.params, { id: 'mvu' })
  assert.deepEqual(after[1]?.params, { source: { kind: 'git', remote: tamperedRemote, commit: tamperedCommit } })
  assert.ok(page.find('[data-plugin-consent="git"]') !== null, 'the reinstall skipped the consent page')
})

test('the client-side shape check answers the four commit spellings the wire refuses', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  t.after(async () => { await server.close() })
  const harness = await server.ssrLoadModule('/tests/plugin-center-harness.tsx') as {
    installFormProblem: (
      mode: 'git' | 'dev',
      fields: { remote: string, commit: string, path: string },
    ) => string | undefined
  }
  const git = (remote: string, commit: string): string | undefined =>
    harness.installFormProblem('git', { remote, commit, path: '' })
  const ok = 'https://example.invalid/a.git'
  const full = '0123456789abcdef0123456789abcdef01234567'

  // The four spellings §9 invariant #3 names, plus the empty remote.
  assert.equal(git(ok, 'main'), 'pluginCenterInstallBadCommit')
  assert.equal(git(ok, full.slice(0, 7)), 'pluginCenterInstallBadCommit')
  assert.equal(git(ok, `${full}0`), 'pluginCenterInstallBadCommit')
  assert.equal(git(ok, full.toUpperCase()), 'pluginCenterInstallBadCommit')
  assert.equal(git('   ', full), 'pluginCenterInstallNeedRemote')
  assert.equal(git(`https://example.invalid/${'a'.repeat(2000)}`, full), 'pluginCenterInstallLongRemote')
  assert.equal(git(ok, ` ${full} `), undefined, 'a pasted commit with surrounding whitespace is a typo, not a refusal')

  assert.equal(harness.installFormProblem('dev', { remote: '', commit: '', path: '' }), 'pluginCenterInstallNeedPath')
  assert.equal(harness.installFormProblem('dev', { remote: '', commit: '', path: 'x'.repeat(1001) }), 'pluginCenterInstallLongPath')
  assert.equal(harness.installFormProblem('dev', { remote: '', commit: '', path: 'D:/pkg' }), undefined)
})
