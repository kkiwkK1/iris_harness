import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createFakeClient } from '@iris/client-fake'
import type { SandboxPluginView, UsageBuckets, UsageSummary, UsageTotals } from '@iris/protocol'
import { createServer } from 'vite'

import { createIrisStore } from '../src/client/store.ts'

/**
 * What the panel and the usage page say once PR-D landed.
 *
 * Three properties, and each one is a sentence a reader is supposed to be able
 * to act on:
 *
 * - **「see the code」 is read-only.** Not "the button is disabled" — there is no
 *   edit control in this surface at all. A `<textarea readonly>` would pass a
 *   "cannot type into it" check and still invite a reader to try, and the reason
 *   they cannot edit (authorisation is by hash) is not a property of one
 *   element's attributes.
 * - **the plugin row on the usage page appears exactly when the share does**,
 *   the way the two rows beside it already do. The wrong implementation that
 *   agrees with the right one nearly everywhere is the one that draws a zero, so
 *   the absent case is asserted as hard as the present one.
 * - **the empty panel says what to do, and when it cannot be done, why first.**
 *   In both columns, because the empty state is this feature's only entry
 *   explanation and a reader who reads Chinese gets it in Chinese or not at all.
 *
 * The source view is driven **through the store**, not by setting its state: the
 * seam that would otherwise go untested is the one between the RPC answer and
 * the field the panel reads, and this project has paid for that seam before
 * (`notes/apps/iris-web/DEVIATIONS.md` §114's eleventh tooth).
 */

/**
 * The SSR server these renders load their harness through.
 *
 * `ssr.noExternal` is the one line here that is not boilerplate.
 * `UsagePanel.tsx` takes `Modal` from the dsh primitives, and that package's
 * entry imports a CSS module; Vite externalises dependencies for SSR by
 * default, so Node is handed a `.css` file to load as a module and the render
 * dies before it can say anything about the page. Naming the package hands it
 * to Vite's own pipeline instead, which turns that import into nothing.
 * @param root - the app directory.
 * @returns the server options.
 */
function viteOptions(root: string): Parameters<typeof createServer>[0] {
  return {
    root,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    ssr: { noExternal: ['@deepseek-ai/dsh-client-ui-primitives'] },
  }
}

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

/** The source one plugin's one version was stored with, in the stub host below. */
const STORED_CODE = "return {\n  apply() { iris.styles.insert('body { background: #101418 }') },\n}"
const STORED_HASH = '0badc0ffee11'

/**
 * A row the way `sandboxPlugin.list` answers one.
 * @param over - what to change.
 * @returns the view.
 */
function pluginRow(over: Partial<SandboxPluginView> = {}): SandboxPluginView {
  return {
    id: '1-dark-status',
    versions: [{
      version: 1,
      name: '深色状态栏',
      purpose: '把状态栏改成深色底浅色字。',
      declares: [{ kind: 'style' }],
      bytes: Buffer.byteLength(STORED_CODE, 'utf8'),
      hash: STORED_HASH,
      prompt: '把状态栏改成深色',
      authored: { connectionId: 'p1', model: 'writer-1', at: 1_700_000_000_000 },
    }],
    enabled: true,
    trustFutureVersions: false,
    authorized: true,
    ...over,
  }
}

/**
 * The fake client with one method answered on top of it.
 *
 * A proxy rather than a spread, because the fake is a class with private fields:
 * every other method has to keep running against the real instance, and only
 * `sandboxPlugin.source` — which the fake refuses by design, having no sidecar —
 * is answered here.
 * @param client - the fake.
 * @returns a client that answers the source call.
 */
function withSourceAnswer<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'call') {
        return async (method: string, params: unknown): Promise<unknown> => {
          if (method === 'sandboxPlugin.source') {
            const asked = params as { pluginId: string, version?: number }
            if (asked.pluginId !== '1-dark-status') throw new Error('no such plugin')
            return { code: STORED_CODE, hash: STORED_HASH, version: asked.version ?? 1 }
          }
          const call = Reflect.get(target, 'call', target) as (m: string, p: unknown) => Promise<unknown>
          return call.call(target, method, params)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as T
}

/** An empty bucket set, so a composed summary is arithmetically honest. */
function buckets(over: Partial<UsageBuckets> = {}): UsageBuckets {
  return { cacheMiss: 0, output: 0, turns: 0, cacheTurns: 0, cachePrompt: 0, ...over }
}

/**
 * A summary carrying whichever side shares the caller names.
 * @param shares - the optional shares to put on the range total and its one chat.
 * @returns the summary.
 */
function summaryWith(shares: Partial<Pick<UsageTotals, 'script' | 'compaction' | 'plugin'>>): UsageSummary {
  const totals: UsageTotals = {
    ...buckets({ cacheMiss: 10_000, output: 900, turns: 4 }),
    undatedTurns: 0,
    ...shares,
  }
  return {
    buckets: [{ ...totals, bucket: 1_700_000_000_000, model: 'deepseek-chat' }],
    chats: [{ ...totals, chatId: 'c1', title: 'Aria', updatedAt: 1_700_000_000_000 }],
    models: ['deepseek-chat'],
    totals,
    granularity: 'day',
    scannedChats: 1,
    skippedChats: 0,
  }
}

test('「see the code」 opens the stored bytes, read-only, and closes again', async t => {
  installShellGlobals()
  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer(viteOptions(root))
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(withSourceAnswer(client), { transport: 'fake', origin: 'plugin panel test' })
  t.after(async () => {
    wired.dispose()
    client.dispose()
    await server.close()
  })
  await wired.store.getState().boot()

  const harness = await server.ssrLoadModule('/tests/sandbox-plugin-panel-harness.tsx') as typeof import('./sandbox-plugin-panel-harness.tsx')
  const render = (): string => harness.renderPluginPanel(wired.store)

  wired.store.setState({
    chatId: 'c1',
    sandboxPluginsFor: 'c1',
    sandboxPlugins: [pluginRow()],
    sandboxPluginSource: undefined,
  })

  const closed = render()
  assert.match(closed, />See the code</, 'the row has no way into the source')
  assert.doesNotMatch(closed, /iris-plugin-code/, 'the block is on screen before anyone asked for it')
  assert.doesNotMatch(closed, /iris\.styles\.insert/, 'the list carried the source, which it must never do')

  // Through the store, so the RPC answer and the field the panel reads are the
  // same fact rather than two that happen to agree.
  await wired.store.getState().readSandboxPluginSource('1-dark-status')
  const held = wired.store.getState().sandboxPluginSource
  assert.equal(held?.code, STORED_CODE)
  assert.equal(held?.hash, STORED_HASH)
  assert.equal(held?.version, 1)

  const open = render()
  assert.match(open, /<pre class="iris-plugin-code__text" data-plugin-code="">/, 'the source is not in a <pre>')
  assert.match(open, /iris\.styles\.insert/, 'the block is open and does not hold the bytes')
  assert.match(open, /Version 1 · hash 0badc0ffee11/, 'the head names neither the version nor the hash')
  assert.match(open, /Read-only\. To change it, say another sentence/)
  assert.match(open, />Hide the code</, 'the control does not say it will close')

  /*
   * **No edit control anywhere in this surface.** The tooth is to render the
   * source in a `<textarea readOnly>` instead: it still cannot be typed into,
   * and it still fails here, which is the point — the rule is about what the
   * panel offers, not about what one element's attributes forbid.
   */
  assert.doesNotMatch(open, /<textarea/i)
  assert.doesNotMatch(open, /<input/i)
  assert.doesNotMatch(open, /contenteditable/i)

  // And the second press is the same control closing, not a second fetch.
  await wired.store.getState().readSandboxPluginSource('1-dark-status')
  assert.equal(wired.store.getState().sandboxPluginSource, undefined)
  assert.doesNotMatch(render(), /iris-plugin-code/)

  // The bytes go with the conversation: a plugin id belongs to one chat, so a
  // view carried across would put one conversation's code under another's row.
  await wired.store.getState().readSandboxPluginSource('1-dark-status')
  assert.notEqual(wired.store.getState().sandboxPluginSource?.code, undefined)
  await wired.store.getState().loadSandboxPlugins('c2')
  assert.equal(wired.store.getState().sandboxPluginSource, undefined)
})

test('the empty panel says what 「create」 is, and says the model is unset first', async t => {
  installShellGlobals()
  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer(viteOptions(root))
  const client = createFakeClient({ chunkDelayMs: 0 })
  const wired = createIrisStore(client, { transport: 'fake', origin: 'plugin empty state test' })
  t.after(async () => {
    wired.dispose()
    client.dispose()
    await server.close()
  })
  await wired.store.getState().boot()

  const harness = await server.ssrLoadModule('/tests/sandbox-plugin-panel-harness.tsx') as typeof import('./sandbox-plugin-panel-harness.tsx')
  const render = (): string => harness.renderPluginPanel(wired.store)

  wired.store.setState({
    chatId: 'c1',
    sandboxPluginsFor: 'c1',
    sandboxPlugins: [],
    authoringConnection: undefined,
  })

  const unset = render()
  // The reason first, then the instruction — the instruction names a control
  // that is dark until the reason is dealt with.
  const reasonAt = unset.indexOf('no model is chosen for writing them')
  const entryAt = unset.indexOf('turns one sentence into one small feature')
  assert.ok(reasonAt !== -1, 'the unset-model sentence is missing')
  assert.ok(entryAt !== -1, 'the entry explanation is missing')
  assert.ok(reasonAt < entryAt, 'the instruction is printed above the reason it cannot be followed')
  // And it points somewhere: a sentence that says the entry is dark without
  // saying where to fix it leaves a reader hunting the settings drawer.
  assert.match(unset, /Writes plugins/)
  assert.match(unset, /Connections/)
  // The instruction says where the switch is, which is not on this panel.
  assert.match(unset, /「\+」/)

  wired.store.setState({ authoringConnection: { id: 'p1', model: 'writer-1' } })
  const set = render()
  assert.doesNotMatch(set, /no model is chosen for writing them/, 'the reason is still shown after it was fixed')
  assert.match(set, /turns one sentence into one small feature/)

  harness.setLanguage('zh')
  const chinese = render()
  assert.match(chinese, /「创造」是用一句话给这段对话长出一个小功能/)
  assert.match(chinese, /在输入框旁边的「\+」里打开它/)
  wired.store.setState({ authoringConnection: undefined })
  const chineseUnset = render()
  assert.match(chineseUnset, /还没有选写插件用的模型/)
  assert.match(chineseUnset, /「写插件用」那一行/)
})

test('the usage page draws the plugin row when the share is there, and nothing when it is not', async t => {
  installShellGlobals()
  const root = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer(viteOptions(root))
  t.after(async () => { await server.close() })

  const harness = await server.ssrLoadModule('/tests/sandbox-plugin-panel-harness.tsx') as typeof import('./sandbox-plugin-panel-harness.tsx')

  const grew = harness.renderUsageReport(summaryWith({
    script: buckets({ cacheMiss: 100, output: 40, turns: 1, cacheTurns: 1, cachePrompt: 150 }),
    plugin: buckets({ cacheMiss: 8_300, output: 640, turns: 2, cacheTurns: 1, cachePrompt: 8_312 }),
  }))
  // The sentence under the total, and the cell on the conversation row: the two
  // places the other side shares appear, so this one appears in both or the
  // feature is half-reported.
  assert.match(grew, /of which 2 plugin-writing requests/)
  assert.match(grew, /2 plugin · /)
  // …beside, not instead of, the card share.
  assert.match(grew, /of which 1 card-script requests/)
  // And the numbers are the share's, not the row's it hangs on.
  assert.match(grew, /of which 2 plugin-writing requests · 8,940 tok/)

  /*
   * **Absent draws nothing at all**, which is the half that separates this from
   * the wrong implementation: a profile that has never grown a feature must not
   * read 「of which 0 plugin-writing requests」. The tooth is to drop the
   * `=== undefined` guard in `Cards`, which leaves that line on every page.
   */
  const never = harness.renderUsageReport(summaryWith({
    script: buckets({ cacheMiss: 100, output: 40, turns: 1, cacheTurns: 1, cachePrompt: 150 }),
  }))
  assert.match(never, /of which 1 card-script requests/, 'the control share is missing, so absence proves nothing')
  assert.doesNotMatch(never, /plugin-writing/)
  assert.doesNotMatch(never, /plugin · /)

  // The share on its own: the note is drawn for it even when neither of the two
  // older shares is there, which a guard written as "script or compaction" would
  // swallow.
  const onlyPlugins = harness.renderUsageReport(summaryWith({
    plugin: buckets({ cacheMiss: 8_300, output: 640, turns: 2, cacheTurns: 1, cachePrompt: 8_312 }),
  }))
  assert.match(onlyPlugins, /of which 2 plugin-writing requests/)
  assert.doesNotMatch(onlyPlugins, /card-script/)

  harness.setLanguage('zh')
  const chinese = harness.renderUsageReport(summaryWith({
    plugin: buckets({ cacheMiss: 8_300, output: 640, turns: 2, cacheTurns: 1, cachePrompt: 8_312 }),
  }))
  assert.match(chinese, /其中写插件请求 2 次/)
  assert.match(chinese, /写插件 2 次/)
  harness.setLanguage('en')
})
