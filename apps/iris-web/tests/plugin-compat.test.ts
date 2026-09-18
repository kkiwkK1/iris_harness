/**
 * The compatibility floor: a card with no sandbox plugins is the card that was
 * there before this feature.
 *
 * "Compatibility is the floor; improvements are documented features" is this
 * project's standing rule, and `docs/SANDBOX-PLUGINS.md` §1 makes the specific
 * promise — a card with no plugins behaves **exactly** as it does today. Two
 * halves of that are reachable in PR-A and both are pinned here:
 *
 * - **the srcdoc's bytes.** The design puts the plugin code on the message
 *   channel and not in the page the shell assembles (§5.2), so the plugin
 *   machinery must contribute nothing to that page — for a card with plugins as
 *   much as for one without. The day someone inlines a plugin bootstrap into the
 *   srcdoc, this goes red.
 * - **the frame count.** Covered next door in `card-scripts.test.ts`: no scripts
 *   and no plugins still builds no frame.
 *
 * @module iris-web/tests/plugin-compat
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCard, type RunnerHost } from '../src/sandbox/runner.ts'
import { installSandboxPluginTree } from '../src/sandbox/plugin-entry.ts'
import { PLUGIN_PANELS_ATTRIBUTE, PLUGIN_STYLE_ATTRIBUTE } from '../src/sandbox/plugin-surface.ts'

/** A stand-in frame element and document, enough for `runCard`. */
function realm(): { document: never, srcdoc: () => string } {
  const element = {
    style: { setProperty: () => undefined, removeProperty: () => undefined },
    dataset: {} as Record<string, string>,
    contentWindow: { postMessage: () => undefined },
    srcdoc: '',
    setAttribute: () => undefined,
    remove: () => undefined,
  }
  const view = {
    location: { origin: 'https://iris.test' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  const document = {
    defaultView: view,
    createElement: () => element,
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  return { document: document as never, srcdoc: () => element.srcdoc }
}

/**
 * The host a card is run with, optionally listening for plugin outcomes.
 * @param plugins - whether the host implements the three plugin callbacks.
 * @returns the host.
 */
function host(plugins: boolean): RunnerHost {
  return {
    bootstrapUrl: 'http://iris.test/sandbox/bootstrap-abc.js',
    scripts: [{ id: 'one', code: 'console.log(1)' }],
    mode: 'module',
    libraries: [],
    documentGranted: false,
    networkGranted: false,
    bundleOrigin: 'https://iris.test',
    context: {} as never,
    viewport: () => ({ width: 800, height: 600 }),
    fetch: async () => '',
    onSettings: () => undefined,
    onSlash: async () => '',
    onDialog: () => undefined,
    onPopup: () => undefined,
    onPopupWithdrawn: () => undefined,
    onCall: async () => undefined,
    onError: () => undefined,
    onBlocked: () => undefined,
    ...(plugins
      ? {
        onPluginMounted: () => undefined,
        onPluginFailed: () => undefined,
        onPluginStyle: () => undefined,
      }
      : {}),
  }
}

test('a frame built for a plugin-aware host is byte-identical to one that is not', () => {
  /*
   * The whole page, compared as a string. Not a marker search: a marker check
   * asks whether the one thing I thought of is absent, and this asks whether
   * **anything** differs — which is the question a compatibility floor is
   * actually about.
   */
  /**
   * The run token, blanked.
   *
   * It is minted per run (`mintToken`) and is *meant* to differ, so comparing it
   * would fail for the one reason that has nothing to do with this feature. It
   * is the only field of the page that varies between two runs, which this test
   * relies on and the length control below keeps honest.
   * @param page - the assembled srcdoc.
   * @returns the page with the token replaced.
   */
  const withoutToken = (page: string): string =>
    page.replace(/content="[0-9a-f]{32}"/gu, 'content="<token>"')

  const without = realm()
  runCard(host(false), without.document)
  const with_ = realm()
  runCard(host(true), with_.document)

  assert.equal(withoutToken(with_.srcdoc()), withoutToken(without.srcdoc()))
  // A positive control: the comparison above is worthless against two empties.
  assert.ok(without.srcdoc().length > 500, 'the srcdoc under comparison is a real page')
  assert.ok(
    withoutToken(without.srcdoc()).includes('<token>'),
    'and the one field that legitimately differs really was found and blanked',
  )
})

test('the plugin machinery puts nothing in the srcdoc at all', () => {
  /*
   * The stronger half, and it is what stops the test above passing by both
   * sides being wrong together: the plugin tree is installed by the bootstrap at
   * run time and the code arrives over the channel, so the page the shell
   * assembles must carry no plugin attribute and no plugin marker.
   */
  const built = realm()
  runCard(host(true), built.document)
  const page = built.srcdoc()

  assert.equal(page.includes(PLUGIN_PANELS_ATTRIBUTE), false)
  assert.equal(page.includes(PLUGIN_STYLE_ATTRIBUTE), false)
  assert.equal(page.includes('plugin:mount'), false)
})

test('installing the tree touches no DOM until a plugin asks for something', () => {
  /*
   * The frame-side half of the same floor. The tree is installed in **every**
   * card frame, including the overwhelming majority that will never hold a
   * plugin, so its cost at install has to be nothing a card could observe — no
   * container in the body, no sheet in the head.
   */
  const created: string[] = []
  const appended: string[] = []
  const document = {
    head: { append: (node: { tag: string }) => appended.push(`head:${node.tag}`) },
    body: { append: (node: { tag: string }) => appended.push(`body:${node.tag}`) },
    createElement: (tag: string) => {
      created.push(tag)
      return { tag, setAttribute: () => undefined, remove: () => undefined, textContent: '' }
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  installSandboxPluginTree({
    token: 'tok',
    document: document as never,
    post: () => undefined,
    onMessage: () => undefined,
    cardSurface: () => ({}),
    origin: 'https://iris.test',
  })

  assert.deepEqual(created, [], 'no element is built before a plugin needs one')
  assert.deepEqual(appended, [], 'and nothing is put into the frame')
})
