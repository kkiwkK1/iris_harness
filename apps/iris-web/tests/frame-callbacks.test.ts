/**
 * The callbacks both frame hosts share, driven against a recording store.
 *
 * Behaviour, not source text: each test calls the built callback the way the
 * runner would and reads what reached the host. The one source-level check at
 * the end is only that both hosts actually use the factory — the class of
 * defect it prevents (a host silently omitting a hook) is invisible to any
 * behavioural test of the factory itself.
 *
 * @module iris-web/tests/frame-callbacks
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { ChatView, IrisClient } from '@iris/protocol'

import { frameCallbacks, interfaceConsoleGate } from '../src/app/frame-callbacks.ts'
import type { FrameBinding } from '../src/client/card-gateway.ts'
import { createIrisStore } from '../src/client/store.ts'
import { RateGate } from '../src/sandbox/console-capture.ts'

/** A store whose client records every call, with chat c1 of card aria open. */
function recording(): {
  store: ReturnType<typeof createIrisStore>['store']
  calls: { method: string, params: Record<string, unknown> }[]
  dispose: () => void
} {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const view: ChatView = { chatId: 'c1', title: 'A scene', messages: [], characterId: 'aria' }
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method, params) {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      return { view } as never
    },
  }
  const { store, dispose } = createIrisStore(client, { transport: 'fake', origin: 'frame callbacks test' })
  store.setState({ chatId: 'c1', view })
  return { store, calls, dispose }
}

const INTERFACE: FrameBinding = { kind: 'interface', chatId: 'c1', characterId: 'aria' }

/** Let the store's un-awaited host calls land. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('an interface frame’s console line reaches the host, labelled, under the frame’s chat', async () => {
  const scope = recording()
  const callbacks = frameCallbacks(scope.store, INTERFACE, { label: 'interface · floor 3', gate: new RateGate(50, 0) }, () => 0)
  callbacks.onConsole?.('warn', 'warn: hp low', 5, undefined)
  await settle()
  const report = scope.calls.find(call => call.method === 'script.report')
  assert.ok(report !== undefined, 'the interface console line was dropped')
  assert.deepEqual(report.params, { chatId: 'c1', level: 'warn', message: '[interface · floor 3] warn: hp low', at: 5 })
  scope.dispose()
})

test('one card’s interface frames share one console budget, and the drop count is said', async () => {
  /*
   * Two frames of one card, one gate: the budget is the card's, not each
   * frame's. The line after the window turns carries how many were dropped,
   * the frame-side gate's own rule.
   */
  const scope = recording()
  let now = 0
  const gate = new RateGate(2, 0)
  const floorOne = frameCallbacks(scope.store, INTERFACE, { label: 'interface · floor 1', gate }, () => now)
  const floorTwo = frameCallbacks(scope.store, INTERFACE, { label: 'interface · floor 2', gate }, () => now)
  floorOne.onConsole?.('log', 'log: a', 0, undefined)
  floorTwo.onConsole?.('log', 'log: b', 0, undefined)
  floorOne.onConsole?.('log', 'log: c', 0, undefined)
  floorTwo.onConsole?.('log', 'log: d', 0, undefined)
  now = 1_000
  floorOne.onConsole?.('log', 'log: e', 1_000, undefined)
  await settle()
  const messages = scope.calls.filter(call => call.method === 'script.report').map(call => call.params['message'])
  assert.deepEqual(messages.slice(0, 2), ['[interface · floor 1] log: a', '[interface · floor 2] log: b'])
  assert.equal(messages.length, 3, 'the gate let more than the card’s budget through')
  assert.match(String(messages[2]), /^\[interface · floor 1\] log: e \(2 earlier line\(s\)/)
  scope.dispose()
})

test('the per-card gate is one object per card', () => {
  assert.equal(interfaceConsoleGate('card-x'), interfaceConsoleGate('card-x'))
  assert.notEqual(interfaceConsoleGate('card-x'), interfaceConsoleGate('card-y'))
})

test('an interface frame’s settings write is forwarded under its own card', async () => {
  // It used to be `onSettings: () => undefined`.
  const scope = recording()
  frameCallbacks(scope.store, INTERFACE).onSettings({ installed: true }, 0)
  await settle()
  const write = scope.calls.find(call => call.method === 'script.setExtensionSettings')
  assert.deepEqual(write?.params, { characterId: 'aria', settings: { installed: true } })
  scope.dispose()
})

test('calls carry the binding, so a frame of a chat that has closed is refused', async () => {
  const scope = recording()
  const callbacks = frameCallbacks(scope.store, INTERFACE)
  await callbacks.onCall('saveChat', {})
  assert.ok(scope.calls.some(call => call.method === 'script.saveChat' && call.params['chatId'] === 'c1'))
  scope.store.setState({ chatId: 'c2' })
  await assert.rejects(callbacks.onCall('saveChat', {}), /saveChat was refused/)
  await assert.rejects(callbacks.onSlash('/echo', 0), /triggerSlash was refused/)
  scope.dispose()
})

test('a dialog is a fault or a note on the report list, and a notice', () => {
  const scope = recording()
  const callbacks = frameCallbacks(scope.store, INTERFACE)
  callbacks.onDialog('alert', 'send failed')
  callbacks.onDialog('confirm', 'really?')
  const reports = scope.store.getState().cardReports.map(report => [report.text, report.grade])
  assert.deepEqual(reports.slice(-2), [
    ['send failed', 'fault'],
    ['a card asked confirm("really?") — answered "cancel"', 'note'],
  ])
  assert.ok(scope.store.getState().noticeLog.some(notice => notice.text === 'send failed'))
  scope.dispose()
})

test('both frame hosts build their shared callbacks from the factory, and neither hand-writes one', () => {
  /*
   * The defect this file exists for was a hook one host simply did not pass —
   * no behavioural test of the factory can see a host that does not call it.
   * So: both call it, and neither re-declares a hook the factory owns (a later
   * literal key would silently override the factory's).
   */
  const shared = ['onCall', 'onSlash', 'onDialog', 'onBlocked', 'onNote', 'onWindowEvent', 'onSettings', 'onConsole']
  for (const file of ['useCardScripts.tsx', 'MessageInterfaces.tsx']) {
    const source = readFileSync(fileURLToPath(new URL(`../src/app/${file}`, import.meta.url)), 'utf8')
    assert.match(source, /\.\.\.frameCallbacks\(store, binding/, `${file} does not use the shared factory`)
    for (const hook of shared) {
      assert.doesNotMatch(source, new RegExp(`^\\s+${hook}: `, 'm'), `${file} hand-writes ${hook}`)
    }
  }
})
