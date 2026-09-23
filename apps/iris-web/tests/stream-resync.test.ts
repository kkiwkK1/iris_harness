/**
 * The page resyncs after a gap in its events (web §124).
 *
 * The owner's stuck reply of 2026-09-24, reproduced on a fake endpoint before
 * this existed: the page's event socket had a gap across the `stream.end`, the
 * host settled and saved, and the page kept its caret, its Stop button and
 * half the reply until a reload. A reconnect only resubscribed to future
 * frames. These pin the reconciliation and the silence watchdog.
 *
 * Each case is chosen where the nearest wrong implementation disagrees:
 * "adopt on reconnect" without the settled check would clear a reply that is
 * still generating; a watchdog keyed on wall time rather than on frames would
 * fire in the middle of a healthy stream; a resync that ignored the event
 * channel's own later frames would paint an older view over the real settle.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatView, IrisClient, IrisEvent } from '@iris/protocol'

import { applyEvent, createIrisStore, STREAM_SILENCE_MS, type IrisStore } from '../src/client/store.ts'

const TEST_SOURCE = { transport: 'fake' as const, origin: 'test' }

const half: ChatView = {
  chatId: 'c1',
  title: 'A scene',
  messages: [{ id: 0, key: 'u0', role: 'user', name: 'U', text: 'Tell me.', turn: 0 }],
}
const settled: ChatView = {
  chatId: 'c1',
  title: 'A scene',
  messages: [
    { id: 0, key: 'u0', role: 'user', name: 'U', text: 'Tell me.', turn: 0 },
    { id: 1, key: 'a0', role: 'assistant', name: 'A', text: 'The whole reply.', turn: 0 },
  ],
}

interface Resync { params: Record<string, unknown>, answer: (value: unknown) => void }

/** A client whose `chat.resync` answers only when the test says so. */
function harness(): {
  store: IrisStore
  push: (event: IrisEvent) => void
  setConnected: (connected: boolean) => void
  resyncs: Resync[]
  dispose: () => void
} {
  const listeners = new Set<(event: IrisEvent) => void>()
  const connection = new Set<(connected: boolean) => void>()
  const resyncs: Resync[] = []
  const client: IrisClient = {
    connected: true,
    onConnectionChange(listener) { connection.add(listener); return () => { connection.delete(listener) } },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async call(method, params) {
      if (method === 'chat.resync') {
        return new Promise(resolve => { resyncs.push({ params: params as Record<string, unknown>, answer: resolve }) }) as never
      }
      if (method === 'plugins.list') return { snapshot: { revision: 1, plugins: [] } } as never
      return {} as never
    },
  }
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  return {
    store,
    push: event => { for (const listener of listeners) listener(event) },
    setConnected: connected => { for (const listener of connection) listener(connected) },
    resyncs,
    dispose,
  }
}

/** Let every pending promise continuation run. */
const settle = async (): Promise<void> => {
  for (let at = 0; at < 10; at += 1) await Promise.resolve()
}

/** A chat open with half a reply streaming for turn 0. */
function streamingHalf(store: IrisStore): void {
  store.setState({ chatId: 'c1', view: half })
  applyEvent(store, { type: 'stream.start', chatId: 'c1', turn: 0, key: 'a0' })
  applyEvent(store, { type: 'stream.text', chatId: 'c1', turn: 0, delta: 'The whole' })
}

test('a reconnect finds the reply settled: the page takes the view and stops generating', async (t) => {
  const h = harness()
  t.after(h.dispose)
  streamingHalf(h.store)

  h.setConnected(false)
  h.setConnected(true)
  assert.equal(h.resyncs.length, 1, 'the reconnect asked')
  assert.deepEqual(h.resyncs[0]?.params.reason, 'reconnect')
  assert.equal(h.resyncs[0]?.params.streamTurn, 0, 'and said which turn it was showing as generating')

  h.resyncs[0]?.answer({ view: settled })
  await settle()
  assert.equal(h.store.getState().stream, undefined, 'the caret and Stop go: nothing is generating')
  assert.equal(h.store.getState().view, settled, 'and the whole reply is shown')
})

test('a reconnect finds the reply still generating: the page keeps waiting', async (t) => {
  const h = harness()
  t.after(h.dispose)
  streamingHalf(h.store)
  const buffer = h.store.getState().stream

  h.setConnected(false)
  h.setConnected(true)
  h.resyncs[0]?.answer({ view: half, generating: { turn: 0 } })
  await settle()
  assert.equal(h.store.getState().stream, buffer, 'the buffer is kept as it was')
  assert.equal(h.store.getState().view, half)

  // …and the real end, when it comes, still settles it.
  h.push({ type: 'stream.end', chatId: 'c1', turn: 0, view: settled, reason: 'completed' })
  assert.equal(h.store.getState().stream, undefined)
})

test('a reconnect with no chat open asks nothing', async (t) => {
  const h = harness()
  t.after(h.dispose)
  h.setConnected(false)
  h.setConnected(true)
  await settle()
  assert.equal(h.resyncs.length, 0)
})

test('a frame that lands while the resync is in flight wins over its answer', async (t) => {
  const h = harness()
  t.after(h.dispose)
  streamingHalf(h.store)
  h.setConnected(false)
  h.setConnected(true)

  // The real settle arrives on the socket first, with the newer view…
  const newer: ChatView = { ...settled, messages: [...settled.messages, { id: 2, key: 'u1', role: 'user', name: 'U', text: 'next', turn: 1 }] }
  h.push({ type: 'stream.end', chatId: 'c1', turn: 0, view: newer, reason: 'completed' })
  // …then an answer read before it.
  h.resyncs[0]?.answer({ view: half })
  await settle()
  assert.equal(h.store.getState().view, newer, 'the older answer is dropped')
})

test('the silence watchdog asks after STREAM_SILENCE_MS without a frame, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = harness()
  t.after(h.dispose)
  streamingHalf(h.store)

  t.mock.timers.tick(STREAM_SILENCE_MS - 1)
  assert.equal(h.resyncs.length, 0, 'one millisecond short: nothing asked')
  // A delta resets it: the stream is alive.
  applyEvent(h.store, { type: 'stream.text', chatId: 'c1', turn: 0, delta: ' reply' })
  t.mock.timers.tick(STREAM_SILENCE_MS - 1)
  assert.equal(h.resyncs.length, 0, 'a live stream never trips it')
  t.mock.timers.tick(1)
  assert.equal(h.resyncs.length, 1, 'a full period of silence does')
  assert.equal(h.resyncs[0]?.params.reason, 'silence')
  assert.equal(h.resyncs[0]?.params.silentMs, STREAM_SILENCE_MS, 'measured from the last frame')

  h.resyncs[0]?.answer({ view: settled })
  await settle()
  assert.equal(h.store.getState().stream, undefined, 'a settled host clears the stuck reply')
})

test('the watchdog keeps asking while the host is still generating, and stops when nothing streams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = harness()
  t.after(h.dispose)
  streamingHalf(h.store)

  t.mock.timers.tick(STREAM_SILENCE_MS)
  assert.equal(h.resyncs.length, 1)
  h.resyncs[0]?.answer({ view: half, generating: { turn: 0 } })
  await settle()
  assert.notEqual(h.store.getState().stream, undefined, 'still generating: keep waiting')

  t.mock.timers.tick(STREAM_SILENCE_MS)
  assert.equal(h.resyncs.length, 2, 'and ask again one period later')
  assert.equal(h.resyncs[1]?.params.silentMs, 2 * STREAM_SILENCE_MS, 'the silence is counted from the last frame, not from the last ask')

  h.push({ type: 'stream.end', chatId: 'c1', turn: 0, view: settled, reason: 'completed' })
  h.resyncs[1]?.answer({ view: settled })
  await settle()
  t.mock.timers.tick(10 * STREAM_SILENCE_MS)
  assert.equal(h.resyncs.length, 2, 'nothing streaming: the watchdog is off')
})

test('a resync that finds the host generating a turn the page never heard open shows it as generating', async (t) => {
  const h = harness()
  t.after(h.dispose)
  h.store.setState({ chatId: 'c1', view: half })
  h.setConnected(false)
  h.setConnected(true)
  assert.equal(h.resyncs[0]?.params.streamTurn, undefined, 'the page was showing nothing as generating')
  h.resyncs[0]?.answer({ view: half, generating: { turn: 0 } })
  await settle()
  assert.equal(h.store.getState().stream?.turn, 0, 'Stop appears for the turn the host is generating')
})
