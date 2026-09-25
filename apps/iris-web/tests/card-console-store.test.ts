/**
 * W7's shell hop: a card console line is forwarded to `script.report`, and a
 * failure to file it lands where the reader is looking.
 *
 * The frame captures and serializes; the host files. Between them is this store
 * action, which is the only piece that can be got wrong invisibly: the frame
 * cannot see the host's answer and must not wait for it, so a store that
 * swallowed the call would make "the host recorded the card's lines" and "the
 * host recorded nothing" read identically.
 *
 * @module iris-web/tests/card-console-store
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeClient } from '@iris/client-fake'
import type { IrisClient } from '@iris/protocol'

import { createIrisStore } from '../src/client/store.ts'
import type { FrameBinding } from '../src/client/card-gateway.ts'

/** The frame that printed the lines, bound to the chat the store has open. */
const FRAME: FrameBinding = { kind: 'script', chatId: 'chat-7', characterId: 'aria' }

interface RecordedCall { method: string, params: unknown }

/** A wired store whose client records every call, with a chat already open. */
function wired(options: { refuse?: string } = {}): {
  store: ReturnType<typeof createIrisStore>['store']
  calls: RecordedCall[]
  dispose: () => void
} {
  const client = createFakeClient({ chunkDelayMs: 0 })
  const calls: RecordedCall[] = []
  const recorder = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (options.refuse === method) throw new Error('the host refused it')
      return await (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call(method, params)
    },
    subscribe: (listener: Parameters<IrisClient['subscribe']>[0]) => client.subscribe(listener),
    get connected() { return client.connected },
    onConnectionChange: (listener: Parameters<IrisClient['onConnectionChange']>[0]) => client.onConnectionChange(listener),
  } as unknown as IrisClient
  const { store, dispose } = createIrisStore(recorder, { transport: 'fake', origin: 'card console store test' })
  store.setState({ chatId: 'chat-7' })
  return { store, calls, dispose: () => { dispose(); client.dispose() } }
}

test('W7: a console line is forwarded with its level, frame time and script id', async () => {
  const { store, calls, dispose } = wired()
  await store.getState().reportCardConsole('warn', 'warn: "careful"', 1_700_000_000_123, 'script-a', FRAME)
  const call = calls.find(entry => entry.method === 'script.report')
  assert.ok(call !== undefined, 'the console line never reached the host')
  assert.deepEqual(call.params, {
    chatId: 'chat-7',
    level: 'warn',
    message: 'warn: "careful"',
    at: 1_700_000_000_123,
    scriptId: 'script-a',
  })
  dispose()
})

test('W7: a console line with no script id omits the field rather than sending undefined', async () => {
  const { store, calls, dispose } = wired()
  await store.getState().reportCardConsole('log', 'log: hi', 0, undefined, FRAME)
  const call = calls.find(entry => entry.method === 'script.report')
  assert.deepEqual(call?.params, { chatId: 'chat-7', level: 'log', message: 'log: hi', at: 0 })
  dispose()
})

test('W7: a line is filed under the frame’s own chat, whatever is open when it lands', async () => {
  /*
   * Restated. This used to read the open chat at call time and drop the line
   * when none was open — and so file a line printed in the switch window under
   * the chat that had just opened. The frame's binding names the conversation
   * whose card printed it, which exists because the frame was built for it.
   */
  const { store, calls, dispose } = wired()
  store.setState({ chatId: 'chat-8' })
  await store.getState().reportCardConsole('log', 'log: from the old frame', 0, undefined, FRAME)
  store.setState({ chatId: undefined })
  await store.getState().reportCardConsole('log', 'log: after close', 0, undefined, FRAME)
  const filed = calls.filter(entry => entry.method === 'script.report')
  assert.equal(filed.length, 2)
  for (const entry of filed) {
    assert.equal((entry.params as { chatId: string }).chatId, 'chat-7', 'filed under the open chat, not the frame’s')
  }
  dispose()
})

test('W7: a host that refuses the report is named on the card report list', async () => {
  const { store, dispose } = wired({ refuse: 'script.report' })
  await store.getState().reportCardConsole('info', 'info: something', 0, undefined, FRAME)
  // The failure is visible where the reader is already looking, rather than
  // swallowed — the frame cannot see it and must not be made to wait for it.
  const text = store.getState().cardReports.map(report => report.text).join(' ')
  assert.match(text, /console output could not be filed/u, 'a refused forward left no trace')
  assert.match(text, /the host refused it/u, 'the refusal did not carry the host\'s reason')
  dispose()
})
