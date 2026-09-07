/**
 * One request in the air per question — however many message rows ask it.
 *
 * Two layers, and both are needed. The first half tests `inFlight` itself. The
 * second half asks the **store** how many times the client was called, because
 * the mechanism only pays off if the call sites agree on the key: a helper that
 * shares perfectly and two call sites that spell the key differently would leave
 * every test here green and the traffic exactly where it was. That is the seam,
 * so it is measured from the store's side, through the real actions.
 *
 * @module iris-web/tests/snapshot-sharing
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChatView, IrisClient } from '@iris/protocol'

import { actionsOf, createIrisStore } from '../src/client/store.ts'
import { inFlight, requestKey } from '../src/client/in-flight.ts'

const TEST_SOURCE = { transport: 'fake' as const, origin: 'test' }

/** Counts the calls a set of rows makes, and answers them all the same way. */
function reader(): { read: () => Promise<number>, calls: () => number } {
  let calls = 0
  return {
    read: async () => {
      calls += 1
      // A tick of latency, because that is the whole premise: the host is slow
      // enough that the other rows ask while the first request is still out.
      await Promise.resolve()
      return calls
    },
    calls: () => calls,
  }
}

/** A distinct scope object, standing in for one client. */
function scope(): object {
  return {}
}

test('callers asking at the same moment share one request', async () => {
  const host = reader()
  const client = scope()

  const answers = await Promise.all([
    inFlight(client, 'k', host.read),
    inFlight(client, 'k', host.read),
    inFlight(client, 'k', host.read),
  ])

  assert.equal(host.calls(), 1, 'one question was asked more than once')
  assert.deepEqual(answers, [1, 1, 1], 'the joiners did not all get the flight’s answer')
})

test('a caller arriving after the flight settled asks again', async () => {
  /*
   * The direction that makes the sharing safe to have, and the reason no
   * invalidation rule is needed anywhere: the entry lives only while the
   * request is in the air. If a settled flight were reused, every interface
   * would redraw the first snapshot forever — the staleness this must not
   * introduce.
   */
  const host = reader()
  const client = scope()

  assert.equal(await inFlight(client, 'k', host.read), 1)
  assert.equal(await inFlight(client, 'k', host.read), 2, 'a settled flight was handed out again')
})

test('a different question is a different flight', async () => {
  const host = reader()
  const client = scope()

  await Promise.all([
    inFlight(client, requestKey('script.context', { chatId: 'a', characterId: 'c' }), host.read),
    inFlight(client, requestKey('script.context', { chatId: 'b', characterId: 'c' }), host.read),
  ])

  assert.equal(host.calls(), 2, 'two chats were answered from one request')
})

test('two clients never share a flight', async () => {
  /*
   * A hot reload leaves two stores alive and the tests stand up several clients
   * at once — one of them a fake, which is a different host altogether. Sharing
   * across them would hand a caller an answer about somewhere else.
   */
  const host = reader()

  await Promise.all([
    inFlight(scope(), 'k', host.read),
    inFlight(scope(), 'k', host.read),
  ])

  assert.equal(host.calls(), 2, 'one client answered for another')
})

test('a failed flight is shared, then forgotten', async () => {
  /*
   * Both halves matter. Every joiner has to see the failure — silently
   * resolving one of them would be an invented answer — and the *next* caller
   * has to be allowed to try, because a host that refused a second ago may well
   * answer now, and a remembered rejection would turn one bad moment into a
   * permanently broken page.
   */
  let calls = 0
  const client = scope()
  const failing = async (): Promise<never> => {
    calls += 1
    await Promise.resolve()
    throw new Error(`refused ${String(calls)}`)
  }

  const both = await Promise.allSettled([
    inFlight(client, 'k', failing),
    inFlight(client, 'k', failing),
  ])
  assert.deepEqual(both.map(one => one.status), ['rejected', 'rejected'], 'a joiner was not told about the failure')
  assert.equal(calls, 1, 'the failing question was asked twice at once')

  await assert.rejects(inFlight(client, 'k', failing), /refused 2/, 'a rejection was remembered')
})

// --- the seam: the store's own call sites ----------------------------------

/** A client that counts each RPC method, answering the ones the store needs. */
function counting(): { client: IrisClient, counts: Map<string, number> } {
  const counts = new Map<string, number>()
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method) {
      counts.set(method, (counts.get(method) ?? 0) + 1)
      // A tick, so concurrent callers really are concurrent: with a synchronous
      // answer the first flight would settle before the second caller ran and
      // this file would be testing nothing.
      await Promise.resolve()
      if (method === 'script.list') {
        return { scripts: [{ id: 's', name: 'core' }], documentGranted: true, scriptsAllowed: true } as never
      }
      if (method === 'script.context') {
        return { context: { chat: [], chatId: 'c1', variableLayers: {} } } as never
      }
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: [] } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      const empty: ChatView = { chatId: 'c1', title: 'A scene', messages: [] }
      return { view: empty } as never
    },
  }
  return { client, counts }
}

test('every message row asking for the snapshot at once costs one round trip', async () => {
  /*
   * The measured fault, in miniature. Each displayed row's `MessageInterfaces`
   * effect calls `scriptContext` in the same React commit; on 8789 that was 22
   * calls inside one millisecond, ~145 KB each, answered in series at ~1.75 s
   * apiece — so the last row waited 47 s and an unrelated `connection.test`
   * queued behind all of them for 30.7 s.
   *
   * Twenty-two callers here rather than three, because the number is the
   * finding: an assertion of "fewer than before" would pass at 21.
   */
  const { client, counts } = counting()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  const rows = await Promise.all(
    Array.from({ length: 22 }, async () => actions.scriptContext('c1', 'aria')),
  )

  assert.equal(counts.get('script.context'), 1, 'the rows did not share one snapshot request')
  assert.equal(rows.filter(row => row !== undefined).length, 22, 'a row was left without a snapshot')
  dispose()
})

test('the panel and the rows share one script.list', async () => {
  /*
   * Three unrelated callers want this at the same moment — `loadScripts` for
   * the panel, `resolveScripts` for the script frame, and one `resolveScripts`
   * per displayed row — and they reach the client through different actions.
   * This is the assertion that would catch the two call sites drifting to
   * different keys, which is the one failure the helper's own tests cannot see.
   */
  const { client, counts } = counting()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  await Promise.all([
    actions.loadScripts('aria'),
    actions.resolveScripts('aria'),
    actions.resolveScripts('aria'),
    actions.resolveScripts('aria'),
  ])

  assert.equal(counts.get('script.list'), 1, 'the panel and the rows asked separately')
  // And the shared reading still answered each caller's own question: the panel
  // reads consent off it, the runner reads the grant.
  assert.equal(store.getState().scriptsAllowed, 'allowed', 'the panel lost the consent field to the sharing')
  assert.equal(store.getState().scripts.length, 1)
  dispose()
})

test('a later batch asks again', async () => {
  /*
   * The freshness half at the store's level: a second commit — a new message
   * row, a re-run effect — must reach the host, or a card would keep drawing
   * the state of the turn it first mounted in.
   */
  const { client, counts } = counting()
  const { store, dispose } = createIrisStore(client, TEST_SOURCE)
  const actions = actionsOf(store)

  await Promise.all([actions.scriptContext('c1', 'aria'), actions.scriptContext('c1', 'aria')])
  await Promise.all([actions.scriptContext('c1', 'aria'), actions.scriptContext('c1', 'aria')])

  assert.equal(counts.get('script.context'), 2, 'a later batch was answered from the first flight')
  dispose()
})
