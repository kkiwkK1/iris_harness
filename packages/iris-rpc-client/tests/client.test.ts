import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { IrisEvent, RpcResponseFrame } from '@iris/protocol'

import { IrisHttpClient, RpcCallError, backoffDelay, type FetchLike, type SocketLike } from '../src/index.ts'

/**
 * The client against fakes.
 *
 * Everything the client owns that is worth guarding is invisible over a real
 * socket: that a refusal becomes a typed rejection rather than a resolved
 * value, that `connected` is not optimistic, that one throwing subscriber does
 * not silence the rest, and that a reconnect is actually scheduled. The
 * transport itself is proven against a running host in `apps/iris/tests`.
 */

/** A socket whose lifecycle the test drives. */
class FakeSocket {
  readonly handlers = new Map<string, ((event: { data: unknown }) => void)[]>()
  closed = false

  /**
   * Record one listener.
   * @param type - the event name.
   * @param listener - the listener.
   */
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(listener)
    this.handlers.set(type, list)
  }

  /** Close from the page's side, as the real API does. */
  close(): void {
    this.closed = true
    this.emit('close')
  }

  /**
   * Fire one event at the client.
   * @param type - the event name.
   * @param event - the payload, for `message`.
   */
  emit(type: string, event: { data: unknown } = { data: '' }): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event)
  }
}

/** A scheduler the test steps by hand. */
class FakeClock {
  readonly pending: { callback: () => void, delayMs: number }[] = []

  /**
   * Queue a callback instead of waiting for it.
   * @param callback - what to run.
   * @param delayMs - the delay that would have applied.
   */
  schedule = (callback: () => void, delayMs: number): unknown => {
    this.pending.push({ callback, delayMs })
    return 0
  }

  /** Run every queued callback, in order. */
  fire(): void {
    const due = this.pending.splice(0, this.pending.length)
    for (const entry of due) entry.callback()
  }
}

/** A `fetch` that answers with one prepared frame and records what it was sent. */
function stubFetch(frame: RpcResponseFrame | string, status = 200): {
  fetch: FetchLike
  calls: { url: string, headers: Record<string, string>, body: string }[]
} {
  const calls: { url: string, headers: Record<string, string>, body: string }[] = []
  const fetchLike: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body })
    return Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(typeof frame === 'string' ? frame : JSON.stringify({
        ...frame,
        // Echo the caller's id so the correlation check passes by default.
        id: (JSON.parse(init.body) as { id: string }).id,
      })),
    })
  }
  return { fetch: fetchLike, calls }
}

/** Build a client wired to fakes, connected by default. */
function makeClient(options: {
  fetch?: FetchLike
  sockets?: FakeSocket[]
  clock?: FakeClock
  autoConnect?: boolean
} = {}): { client: IrisHttpClient, sockets: FakeSocket[], clock: FakeClock, errors: Error[] } {
  const sockets = options.sockets ?? []
  const clock = options.clock ?? new FakeClock()
  const errors: Error[] = []
  const client = new IrisHttpClient({
    baseUrl: 'http://127.0.0.1:4321',
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
    ...options.autoConnect === undefined ? {} : { autoConnect: options.autoConnect },
    socket: (): SocketLike => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    schedule: clock.schedule,
    onError: (error) => { errors.push(error) },
  })
  return { client, sockets, clock, errors }
}

test('the endpoints are derived from one base url', () => {
  const { client } = makeClient({ autoConnect: false })

  assert.equal(client.rpcUrl, 'http://127.0.0.1:4321/iris/rpc')
  // The socket scheme has to track the page's, or an https deployment mixes
  // content and the browser refuses the connection outright.
  assert.equal(client.eventsUrl, 'ws://127.0.0.1:4321/iris/events')
  assert.equal(new IrisHttpClient({ baseUrl: 'https://iris.example', autoConnect: false }).eventsUrl, 'wss://iris.example/iris/events')
})

test('a call posts a correlated JSON frame and resolves with the result', async () => {
  const stub = stubFetch({ id: '', ok: true, result: { turn: 3 } })
  const { client } = makeClient({ fetch: stub.fetch, autoConnect: false })

  const result = await client.call('chat.send', { chatId: 'c1', text: 'Hello?' })

  assert.deepEqual(result, { turn: 3 })
  const call = stub.calls[0]
  // The content type is the host's cross-site guard; sending anything else
  // would make every call fail with a 415.
  assert.equal(call?.headers['content-type'], 'application/json')
  const sent = JSON.parse(call?.body ?? '{}') as { id: string, method: string, params: unknown }
  assert.equal(sent.method, 'chat.send')
  assert.deepEqual(sent.params, { chatId: 'c1', text: 'Hello?' })
  assert.equal(typeof sent.id, 'string')
})

test('a refusal rejects with the host’s own code', async () => {
  const stub = stubFetch({ id: '', ok: false, error: { code: 'busy', message: 'that chat is already generating' } })
  const { client } = makeClient({ fetch: stub.fetch, autoConnect: false })

  await assert.rejects(
    () => client.call('chat.send', { chatId: 'c1', text: 'Hi' }),
    (error: unknown) => {
      assert.ok(error instanceof RpcCallError)
      assert.equal(error.code, 'busy')
      assert.equal(error.message, 'that chat is already generating')
      return true
    },
  )
})

test('an unreachable host is an internal failure, not a hang', async () => {
  const fetchLike: FetchLike = () => Promise.reject(new Error('fetch failed'))
  const { client } = makeClient({ fetch: fetchLike, autoConnect: false })

  await assert.rejects(
    () => client.call('chat.list', {}),
    (error: unknown) => error instanceof RpcCallError && error.code === 'internal',
  )
})

test('a body that is not a frame does not resolve as one', async () => {
  const stub = stubFetch('<!doctype html><title>404</title>', 404)
  const { client } = makeClient({ fetch: stub.fetch, autoConnect: false })

  await assert.rejects(
    () => client.call('chat.list', {}),
    (error: unknown) => error instanceof RpcCallError && /not a response frame/.test(error.message),
  )
})

test('an answer to a different request is refused rather than returned', async () => {
  const fetchLike: FetchLike = () => Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ id: 'somebody-elses-request', ok: true, result: { chats: [] } })),
  })
  const { client } = makeClient({ fetch: fetchLike, autoConnect: false })

  await assert.rejects(
    () => client.call('chat.list', {}),
    (error: unknown) => error instanceof RpcCallError && /different request/.test(error.message),
  )
})

test('subscribers receive frames and their disposers actually detach', () => {
  const { client, sockets } = makeClient()
  const socket = sockets[0]
  assert.ok(socket !== undefined)

  const seen: IrisEvent[] = []
  const dispose = client.subscribe(event => { seen.push(event) })

  socket.emit('open')
  const event: IrisEvent = { type: 'stream.text', chatId: 'c1', turn: 0, delta: 'Hel' }
  socket.emit('message', { data: JSON.stringify(event) })
  dispose()
  socket.emit('message', { data: JSON.stringify({ ...event, delta: 'lo' }) })

  assert.deepEqual(seen, [event])
})

test('one throwing subscriber does not silence the others', () => {
  const { client, sockets, errors } = makeClient()
  const socket = sockets[0]
  assert.ok(socket !== undefined)

  client.subscribe(() => { throw new Error('a render bug') })
  const seen: IrisEvent[] = []
  client.subscribe(event => { seen.push(event) })

  socket.emit('message', { data: JSON.stringify({ type: 'chats.updated', chats: [] }) })

  assert.deepEqual(seen, [{ type: 'chats.updated', chats: [] }])
  assert.equal(errors.length, 1)
  assert.match(errors[0]?.message ?? '', /a render bug/)
})

test('connected reflects the socket rather than the intent to connect', () => {
  const { client, sockets } = makeClient()
  const socket = sockets[0]
  assert.ok(socket !== undefined)

  const states: boolean[] = []
  client.onConnectionChange(connected => { states.push(connected) })

  // Constructed and connecting is NOT connected: a UI that trusts this shows a
  // send button that would fail.
  assert.equal(client.connected, false)
  socket.emit('open')
  assert.equal(client.connected, true)
  socket.emit('close')
  assert.equal(client.connected, false)

  assert.deepEqual(states, [true, false], 'one notification per actual change')
})

test('a dropped connection is retried, and the new socket delivers', () => {
  const { client, sockets, clock } = makeClient()
  const first = sockets[0]
  assert.ok(first !== undefined)
  first.emit('open')

  const seen: IrisEvent[] = []
  client.subscribe(event => { seen.push(event) })

  first.emit('close')
  assert.equal(client.connected, false)
  assert.equal(clock.pending.length, 1, 'the drop scheduled exactly one retry')

  clock.fire()
  const second = sockets[1]
  assert.ok(second !== undefined, 'the retry opened a fresh socket')
  second.emit('open')
  assert.equal(client.connected, true)

  second.emit('message', { data: JSON.stringify({ type: 'chats.updated', chats: [] }) })
  assert.deepEqual(seen, [{ type: 'chats.updated', chats: [] }])
})

test('close stops the retry loop, and connect resumes it', () => {
  const { client, sockets, clock } = makeClient()
  sockets[0]?.emit('open')

  client.close()
  assert.equal(client.connected, false)
  clock.fire()
  assert.equal(sockets.length, 1, 'a closed client does not reconnect behind the user’s back')

  client.connect()
  assert.equal(sockets.length, 2)
})

test('a frame that is not JSON is reported, not thrown at the page', () => {
  const { client, sockets, errors } = makeClient()
  const seen: IrisEvent[] = []
  client.subscribe(event => { seen.push(event) })

  sockets[0]?.emit('message', { data: 'not json at all' })

  assert.deepEqual(seen, [])
  assert.equal(errors.length, 1)
})

test('the retry schedule doubles towards its ceiling and stays jittered', () => {
  const options = { initialDelayMs: 300, maxDelayMs: 10_000, jitter: 0.25 }

  // Mid-jitter is the schedule itself.
  assert.equal(backoffDelay(0, options, () => 0.5), 300)
  assert.equal(backoffDelay(1, options, () => 0.5), 600)
  assert.equal(backoffDelay(2, options, () => 0.5), 1200)
  assert.equal(backoffDelay(20, options, () => 0.5), 10_000, 'capped, not exponential forever')

  // The spread is what keeps every page from reconnecting in lockstep.
  assert.equal(backoffDelay(1, options, () => 0), 450)
  assert.equal(backoffDelay(1, options, () => 0.999_999), 750)

  assert.equal(backoffDelay(0, { initialDelayMs: 0, maxDelayMs: 0, jitter: 1 }, () => 0), 0)
})
