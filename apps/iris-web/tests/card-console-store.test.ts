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
  await store.getState().reportCardConsole('warn', 'warn: "careful"', 1_700_000_000_123, 'script-a')
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
  await store.getState().reportCardConsole('log', 'log: hi', 0, undefined)
  const call = calls.find(entry => entry.method === 'script.report')
  assert.deepEqual(call?.params, { chatId: 'chat-7', level: 'log', message: 'log: hi', at: 0 })
  dispose()
})

test('W7: a line with no open chat is dropped, not filed against a made-up one', async () => {
  const { store, calls, dispose } = wired()
  store.setState({ chatId: undefined })
  await store.getState().reportCardConsole('log', 'log: nowhere', 0, undefined)
  assert.equal(calls.some(entry => entry.method === 'script.report'), false,
    'a console line was sent with no conversation to attribute it to')
  dispose()
})

test('W7: a host that refuses the report is named on the card report list', async () => {
  const { store, dispose } = wired({ refuse: 'script.report' })
  await store.getState().reportCardConsole('info', 'info: something', 0, undefined)
  // The failure is visible where the reader is already looking, rather than
  // swallowed — the frame cannot see it and must not be made to wait for it.
  const text = store.getState().cardReports.map(report => report.text).join(' ')
  assert.match(text, /console output could not be filed/u, 'a refused forward left no trace')
  assert.match(text, /the host refused it/u, 'the refusal did not carry the host\'s reason')
  dispose()
})
