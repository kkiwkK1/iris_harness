import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { IrisEvent, RpcResponseFrame } from '@iris/protocol'
import { WebSocket } from 'ws'

import IrisRpcHost, { type Config } from '../src/index.ts'

/**
 * The transport, exercised over a real socket.
 *
 * Every assertion here goes through the wire rather than calling the service
 * directly, because the parts worth guarding are the ones the browser sees: the
 * content-type gate, the fact that a malformed frame answers instead of
 * disconnecting, and that disposing the plugin releases both routes.
 */

/** A booted host and the facts a test needs to talk to it. */
interface Host {
  ctx: Context
  rpc: IrisRpcHost
  origin: string
  wsUrl: string
}

/** Boot a Context with the carrier and the transport, disposed when the test ends. */
async function startHost(t: TestContext, config: Partial<Config> = {}): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(IrisRpcHost, { heartbeatMs: 0, ...config })
  t.after(async () => { await ctx.fiber.dispose() })

  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  return { ctx, rpc: ctx.irisRpc, origin, wsUrl: `ws://127.0.0.1:${String(ctx.webServer.port)}${ctx.irisRpc.eventsPath}` }
}

/** POST one raw body, so a test can send frames the client library would refuse to build. */
async function post(host: Host, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${host.origin}${host.rpc.rpcPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

/** POST a well-formed frame and read the response frame back. */
async function call(host: Host, method: string, params: unknown): Promise<RpcResponseFrame> {
  const response = await post(host, JSON.stringify({ id: 'req-1', method, params }))
  return await response.json() as RpcResponseFrame
}

/** Open an event socket and resolve once it is attached. */
async function connect(host: Host, headers: Record<string, string> = {}): Promise<WebSocket> {
  const socket = new WebSocket(host.wsUrl, { headers })
  await once(socket, 'open')
  return socket
}

/** The next frame pushed to a socket. */
async function nextEvent(socket: WebSocket): Promise<IrisEvent> {
  const [data] = await once(socket, 'message') as [Buffer]
  return JSON.parse(data.toString('utf8')) as IrisEvent
}

test('a registered method answers over POST', async (t) => {
  const host = await startHost(t)
  host.rpc.register('chat.rename', params => {
    return { chats: [{ chatId: params.chatId, title: params.title, updatedAt: 0, messageCount: 0 }] }
  })

  const frame = await call(host, 'chat.rename', { chatId: 'c1', title: 'Renamed' })

  assert.equal(frame.ok, true)
  assert.deepEqual(frame.ok ? frame.result : undefined, {
    chats: [{ chatId: 'c1', title: 'Renamed', updatedAt: 0, messageCount: 0 }],
  })
  assert.equal(frame.id, 'req-1')
})

test('params are validated before a handler ever sees them', async (t) => {
  const host = await startHost(t)
  let reached = false
  host.rpc.register('chat.send', () => {
    reached = true
    return { turn: 0 }
  })

  // `text` is required and non-empty; the browser is a separate trust domain,
  // so this is refused at the boundary rather than inside the application.
  const response = await post(host, JSON.stringify({ id: 'req-1', method: 'chat.send', params: { chatId: 'c1' } }))
  const frame = await response.json() as RpcResponseFrame

  assert.equal(response.status, 200, 'a refusal is still a well-formed answer')
  assert.equal(frame.ok, false)
  assert.equal(frame.ok ? undefined : frame.error.code, 'invalid-request')
  assert.equal(reached, false)
})

test('an unknown method is unsupported, not a crash', async (t) => {
  const host = await startHost(t)
  const frame = await call(host, 'chat.explode', {})

  assert.equal(frame.ok, false)
  assert.equal(frame.ok ? undefined : frame.error.code, 'unsupported')
})

test('a known method with no handler is unsupported too', async (t) => {
  const host = await startHost(t)
  const frame = await call(host, 'chat.list', {})

  assert.equal(frame.ok, false)
  assert.equal(frame.ok ? undefined : frame.error.code, 'unsupported')
})

test('a non-JSON content type is refused, which is what blocks a cross-site POST', async (t) => {
  const host = await startHost(t)
  host.rpc.register('chat.delete', () => ({}))

  // `text/plain` is a CORS simple request: a hostile page can send it with no
  // preflight. Requiring `application/json` is what makes that impossible.
  const response = await post(
    host,
    JSON.stringify({ id: 'req-1', method: 'chat.delete', params: { chatId: 'c1' } }),
    { 'content-type': 'text/plain;charset=UTF-8' },
  )

  assert.equal(response.status, 415)
  const frame = await response.json() as RpcResponseFrame
  assert.equal(frame.ok, false)
})

test('a GET is refused with the allowed method', async (t) => {
  const host = await startHost(t)
  const response = await fetch(`${host.origin}${host.rpc.rpcPath}`)

  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
  await response.arrayBuffer()
})

test('a body past the cap is refused rather than buffered', async (t) => {
  const host = await startHost(t, { maxBodyBytes: 64 })
  host.rpc.register('chat.open', () => ({ view: { chatId: 'c1', title: 't', messages: [] } }))

  const response = await post(host, JSON.stringify({
    id: 'req-1',
    method: 'chat.open',
    params: { chatId: 'x'.repeat(500) },
  }))

  assert.equal(response.status, 413)
  await response.arrayBuffer()
})

test('unparsable JSON answers a frame instead of tearing anything down', async (t) => {
  const host = await startHost(t)
  const response = await post(host, '{not json')
  const frame = await response.json() as RpcResponseFrame

  assert.equal(response.status, 400)
  assert.equal(frame.ok, false)
  assert.equal(frame.ok ? undefined : frame.error.code, 'invalid-request')
})

test('a handler failure carrying a wire code keeps that code', async (t) => {
  const host = await startHost(t)
  host.rpc.register('chat.open', () => {
    const error = new Error('no such chat') as Error & { code: string }
    error.code = 'not-found'
    throw error
  })

  const frame = await call(host, 'chat.open', { chatId: 'gone' })

  assert.equal(frame.ok, false)
  assert.deepEqual(frame.ok ? undefined : frame.error, { code: 'not-found', message: 'no such chat' })
})

test('an unclassified handler failure becomes internal', async (t) => {
  const host = await startHost(t)
  host.rpc.register('chat.open', () => { throw new TypeError('undefined is not a function') })

  const frame = await call(host, 'chat.open', { chatId: 'c1' })

  assert.equal(frame.ok, false)
  assert.equal(frame.ok ? undefined : frame.error.code, 'internal')
})

test('a duplicate registration is a composition error', async (t) => {
  const host = await startHost(t)
  host.rpc.register('chat.abort', () => ({}))

  assert.throws(() => host.rpc.register('chat.abort', () => ({})), /already registered/)
})

test('disposing a handler stops it answering', async (t) => {
  const host = await startHost(t)
  const dispose = host.rpc.register('chat.abort', () => ({}))

  assert.equal((await call(host, 'chat.abort', { chatId: 'c1' })).ok, true)
  dispose()
  assert.equal((await call(host, 'chat.abort', { chatId: 'c1' })).ok, false)
})

test('events reach every attached page', async (t) => {
  const host = await startHost(t)
  const first = await connect(host)
  const second = await connect(host)
  t.after(() => { first.close(); second.close() })

  assert.equal(host.rpc.connections, 2)

  const arrivals = Promise.all([nextEvent(first), nextEvent(second)])
  const event: IrisEvent = { type: 'stream.text', chatId: 'c1', turn: 0, delta: 'Hello' }
  host.rpc.broadcast(event)

  assert.deepEqual(await arrivals, [event, event])
})

test('a malformed frame from one page does not disconnect another', async (t) => {
  const host = await startHost(t)
  const watcher = await connect(host)
  t.after(() => { watcher.close() })

  const frame = await post(host, '{"id":"req-1","method":42}')
  assert.equal((await frame.json() as RpcResponseFrame).ok, false)
  await post(host, 'garbage')

  // The page that did nothing wrong is still attached and still receiving.
  assert.equal(watcher.readyState, watcher.OPEN)
  const arrival = nextEvent(watcher)
  host.rpc.broadcast({ type: 'chats.updated', chats: [] })
  assert.deepEqual(await arrival, { type: 'chats.updated', chats: [] })
})

test('an upgrade from a foreign origin is refused', async (t) => {
  const host = await startHost(t)
  const socket = new WebSocket(host.wsUrl, { headers: { origin: 'https://evil.example' } })
  const [error] = await once(socket, 'error') as [Error]

  assert.match(error.message, /403/)
  assert.equal(host.rpc.connections, 0)
})

test('an upgrade from an explicitly allowed origin is accepted', async (t) => {
  const host = await startHost(t, { allowedOrigins: ['http://localhost:5173'] })
  const socket = await connect(host, { origin: 'http://localhost:5173' })
  t.after(() => { socket.close() })

  assert.equal(host.rpc.connections, 1)
})

test('disposing the plugin releases both routes and detaches every page', async (t) => {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const fiber = await ctx.plugin(IrisRpcHost, { heartbeatMs: 0 })
  t.after(async () => { await ctx.fiber.dispose() })

  const port = ctx.webServer.port
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/iris/events`)
  await once(socket, 'open')

  const closed = once(socket, 'close')
  await fiber.dispose()
  await closed

  // The carrier is still listening; it just has no routes left to serve.
  const response = await fetch(`http://127.0.0.1:${String(port)}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"id":"req-1","method":"chat.list","params":{}}',
  })
  assert.equal(response.status, 404)
  await response.arrayBuffer()
})

test('the heartbeat probes a live page without dropping it', async (t) => {
  // Worth a real timer: a heartbeat that mistakes a healthy socket for a dead
  // one would terminate every connected page on a fixed interval, and the
  // symptom — a UI that reconnects every thirty seconds — looks like a network
  // problem rather than a bug here.
  const host = await startHost(t, { heartbeatMs: 20 })
  const socket = await connect(host)
  t.after(() => { socket.close() })

  const pings = once(socket, 'ping')
  await pings

  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(socket.readyState, socket.OPEN, 'a page that answers its pings stays attached')
  assert.equal(host.rpc.connections, 1)

  const arrival = nextEvent(socket)
  host.rpc.broadcast({ type: 'chats.updated', chats: [] })
  assert.deepEqual(await arrival, { type: 'chats.updated', chats: [] })
})
