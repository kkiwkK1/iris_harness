import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sandboxPluginOwnerId } from '@iris/protocol'

import { TRACE_MEMBERS } from '../src/sandbox/owner-scope.ts'
import { installSandboxPluginTree } from '../src/sandbox/plugin-entry.ts'
import type { SandboxPluginTree } from '../src/sandbox/plugin-tree.ts'
import { contextFor, pluginRealm, type PluginRealm } from './plugin-owner-realm.ts'

/**
 * Teardown item 5 as `scope.dispose()`, end to end: the real frame surface,
 * the real plugin entry, and the real tree, with a plugin whose code is
 * compiled by `new Function` exactly as in a frame.
 *
 * Findings `owner-scope-for-teardown` and `frame-plugin-kernel-on-cordis`
 * (corrected direction: a Cordis-shaped scope, no Cordis library). The first
 * test is the one the review asked for first: a plugin that publishes a global
 * and is unmounted must leave no trace of it. On main it left the global,
 * because item 5 was three hard-coded calls and `initializeGlobal` was not one.
 */

const CHAT = 'aria-chat-A'

/** Somewhere plugin code can record that its listener ran. */
const hits = (): string[] => {
  const holder = globalThis as { __irisTeardownHits?: string[] }
  holder.__irisTeardownHits ??= []
  return holder.__irisTeardownHits
}

/**
 * A realm with the plugin tree installed into it the way `frame-entry.ts` does.
 * @param overrides - context fields for the conversation.
 * @returns the realm and the tree.
 */
function mountedRealm(overrides: Record<string, unknown> = {}): { realm: PluginRealm, tree: SandboxPluginTree } {
  const realm = pluginRealm(contextFor(CHAT, overrides))
  const document = {
    head: { append: () => undefined },
    body: { append: () => undefined },
    createElement: (tag: string) => ({ tag, setAttribute: () => undefined, remove: () => undefined, textContent: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const tree = installSandboxPluginTree({
    token: 'tok',
    document: document as never,
    post: message => realm.posted.push(message),
    onMessage: () => undefined,
    cardSurface: owner => realm.sandbox.cardSurface(owner),
    origin: 'https://iris.test',
  })
  return { realm, tree }
}

/**
 * Whether the card's shared namespace holds a name, as a card script sees it.
 * @param realm - the frame.
 * @param name - the published name.
 * @returns the answer of `name in parent`, and the value.
 */
function publishedIn(realm: PluginRealm, name: string): { has: boolean, value: unknown } {
  const parent = realm.cardGlobals()['parent'] as Record<string, unknown>
  return { has: name in parent, value: parent[name] }
}

test('a plugin that publishes a global and is unmounted leaves no such global', async () => {
  const { realm, tree } = mountedRealm()
  await tree.mount({ pluginId: '01-x', version: 1, code: "return { apply() { iris.card.initializeGlobal('X', 1) } }" })
  assert.deepEqual(publishedIn(realm, 'X'), { has: true, value: 1 }, 'the plugin never published, so absence proves nothing')

  const steps = await tree.unmount('01-x')

  // The tooth: make the `global:` effect's undo a no-op (or go back to the
  // three hard-coded calls), and 'X' is still there.
  assert.equal(publishedIn(realm, 'X').has, false, 'the plugin’s global outlived it')
  assert.equal(steps.length, 6, 'the checklist is still six items')
  assert.ok(steps.every(step => step.ok), JSON.stringify(steps))
})

test('revoking a plugin’s publication never takes a name a card script owns', async () => {
  const { realm, tree } = mountedRealm()
  const parent = realm.cardGlobals()['parent'] as Record<string, unknown>

  // Y: the card published first, the plugin overwrote it. Unmounting puts the
  // card's value back, rather than deleting a name the card published.
  parent['Y'] = 'card'
  // Z: the plugin published first, the card republished after. It is the
  // card's now, and unmounting leaves it.
  await tree.mount({
    pluginId: '01-x',
    version: 1,
    code: "return { apply() { iris.card.initializeGlobal('Y', 'plugin'); iris.card.initializeGlobal('Z', 'plugin') } }",
  })
  parent['Z'] = 'card'
  assert.equal(publishedIn(realm, 'Y').value, 'plugin')

  await tree.unmount('01-x')

  assert.deepEqual(publishedIn(realm, 'Y'), { has: true, value: 'card' })
  assert.deepEqual(publishedIn(realm, 'Z'), { has: true, value: 'card' })
})

test('every trace-bearing member a plugin calls is gone after it is unmounted', async () => {
  const owner = sandboxPluginOwnerId(CHAT, '01-all')
  // A button table the host already holds for this owner, so emptying it is a
  // write the frame actually makes (an equal table is not re-sent).
  const { realm, tree } = mountedRealm({ scriptButtons: { [owner]: [{ name: 'seed', visible: true }] } })
  hits().length = 0

  const code = `
    const c = iris.card
    const hit = name => () => { globalThis.__irisTeardownHits.push(name) }
    return { apply() {
      c.eventOn('t-on', hit('eventOn'))
      c.eventOnce('t-once', hit('eventOnce'))
      c.eventMakeFirst('t-first', hit('eventMakeFirst'))
      c.eventMakeLast('t-last', hit('eventMakeLast'))
      c.replaceScriptButtons([{ name: 'a', visible: true }])
      c.appendInexistentScriptButtons([{ name: 'b', visible: true }])
      c.updateScriptButtonsWith(table => [...table, { name: 'c', visible: false }])
      c.injectPrompts([{ id: 't-inject', content: 'remember the lighthouse' }])
      c.initializeGlobal('T', 1)
    } }`
  await tree.mount({ pluginId: '01-all', version: 1, code })
  const mounted = realm.posted.find(message => message.type === 'plugin:mounted')
  assert.ok(mounted !== undefined, `the plugin did not mount: ${JSON.stringify(realm.posted.filter(m => m.type === 'plugin:failed'))}`)

  // The control: every family left something while the plugin was up.
  const emitter = realm.sandbox.cardSurface('another-owner').members
  const emit = emitter['eventEmit'] as (event: string) => Promise<void>
  await emit('t-on')
  assert.deepEqual(hits(), ['eventOn'], 'the listener never registered, so its absence later proves nothing')
  assert.equal(publishedIn(realm, 'T').has, true)

  const before = realm.calls().length
  const steps = await tree.unmount('01-all')
  assert.ok(steps.every(step => step.ok), JSON.stringify(steps))
  const after = realm.calls().slice(before)

  const compared = new Set<string>()

  // events: no listener of the plugin's answers any more.
  hits().length = 0
  for (const event of ['t-on', 't-once', 't-first', 't-last']) await emit(event)
  assert.deepEqual(hits(), [], 'a listener outlived the plugin')
  for (const name of ['eventOn', 'eventOnce', 'eventMakeFirst', 'eventMakeLast']) compared.add(name)

  // buttons: the owner's table was emptied, under the owner id.
  const cleared = after.filter(call => call.method === 'replaceScriptButtons')
  assert.equal(cleared.length, 1, JSON.stringify(after))
  assert.equal(cleared[0]?.params['scriptId'], owner)
  assert.deepEqual(cleared[0]?.params['buttons'], [])
  for (const name of ['replaceScriptButtons', 'appendInexistentScriptButtons', 'updateScriptButtonsWith']) compared.add(name)

  // injections: the removal for the key went out.
  assert.ok(
    after.some(call => call.method === 'setExtensionPrompt' && call.params['key'] === 't-inject' && call.params['value'] === ''),
    `no removal for the injection: ${JSON.stringify(after)}`,
  )
  compared.add('injectPrompts')

  // globals.
  assert.equal(publishedIn(realm, 'T').has, false)
  compared.add('initializeGlobal')

  /*
   * **The compared count, as a floor.** Every member `TRACE_MEMBERS` lists was
   * called by the plugin and checked above. A member added to that list
   * without a check here fails this line rather than passing unexamined.
   */
  const listed = Object.keys(TRACE_MEMBERS)
  assert.ok(compared.size >= listed.length, `compared ${String(compared.size)} of ${String(listed.length)}`)
  assert.deepEqual([...compared].sort(), [...listed].sort())
})

test('a factory that registers a listener and then throws leaves no listener', async () => {
  const { realm, tree } = mountedRealm()
  hits().length = 0
  await tree.mount({
    pluginId: '01-bad',
    version: 1,
    code: "iris.card.eventOn('t-bad', () => { globalThis.__irisTeardownHits.push('bad') }); throw new Error('no')",
  })
  assert.ok(realm.posted.some(message => message.type === 'plugin:failed'))
  const emit = realm.sandbox.cardSurface('another-owner').members['eventEmit'] as (event: string) => Promise<void>
  await emit('t-bad')
  // The tooth: drop `clearMemberTraces` from the tree's `abandon`.
  assert.deepEqual(hits(), [])
})

test('a mount that arrives before the frame has a context waits for it', async () => {
  /*
   * Measured on a real host (8796): the shell posts `plugin:mount` as soon as
   * the frame is ready, before the first `context` message, and the plugin's
   * `apply` ran with no conversation at all. Its owner id could not be formed
   * and its script-scope write was refused. The tooth is to call `tree.mount`
   * straight from the message handler in `plugin-entry.ts`, as before.
   */
  const realm = pluginRealm()
  const document = {
    head: { append: () => undefined },
    body: { append: () => undefined },
    createElement: (tag: string) => ({ tag, setAttribute: () => undefined, remove: () => undefined, textContent: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const inbound: ((message: never) => void)[] = []
  installSandboxPluginTree({
    token: 'tok',
    document: document as never,
    post: message => realm.posted.push(message),
    onMessage: listener => { inbound.push(listener as never) },
    cardSurface: owner => realm.sandbox.cardSurface(owner),
    origin: 'https://iris.test',
  })
  const seen = globalThis as { __irisOwnerAtApply?: unknown }
  delete seen.__irisOwnerAtApply
  for (const listener of inbound) {
    listener({
      iris: 'tok', type: 'plugin:mount', pluginId: '01-x', version: 1,
      code: 'return { apply() { globalThis.__irisOwnerAtApply = iris.card.getScriptId() } }',
    } as never)
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal('__irisOwnerAtApply' in seen, false, 'apply ran before the frame had a context')

  realm.send({ iris: 'tok', type: 'context', context: contextFor(CHAT) })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(seen.__irisOwnerAtApply, sandboxPluginOwnerId(CHAT, '01-x'))
})
