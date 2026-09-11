import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { IrisEvent, RpcResponseFrame } from '@iris/protocol'
import { WebSocket } from 'ws'

import IrisRpcHost, { type Config } from '../src/index.ts'
import { onFetchablePort } from '../../iris-app-service/tests/support/fetchable-port.ts'

/**
 * The transport, exercised over a real socket.
 *
 * Every assertion here goes through the wire rather than calling the service
 * directly, because the parts worth guarding are the ones the browser sees: the
 * content-type gate, the fact that a malformed frame answers instead of
 * disconnecting, and that disposing the plugin releases both routes.
 */

/**
 * Boot the carrier on a port `fetch` will actually talk to.
 *
 * `port: 0` can hand out one of the ports WHATWG Fetch refuses outright, and
 * the resulting `bad port` reads as a host bug rather than as the client
 * declining to dial — it failed this file once in six paired full-suite runs.
 * The table and the retry live in
 * `iris-app-service/tests/support/fetchable-port.ts`, shared with
 * every other test that binds an ephemeral port and then fetches itself; the
 * retry is a re-bind rather than a search for a free port, because looking one
 * up and then claiming it leaves a window in which somebody else claims it.
 * @param ctx - the context to plug the carrier into.
 * @returns the port it settled on.
 */
async function startCarrier(ctx: Context): Promise<number> {
  const { port } = await onFetchablePort(async () => {
    const fiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    return { value: fiber, port: ctx.webServer.port, release: () => fiber.dispose() }
  })
  return port
}

/** A booted host and the facts a test needs to talk to it. */
interface Host {
  ctx: Context
  rpc: IrisRpcHost
  origin: string
  wsUrl: string
  port: number
}

/**
 * Speak one request this host by hand and read the response head back.
 *
 * `fetch` forbids setting `Host` and `ws` writes its own, so the header the
 * allow-list is *about* is the one no client library will let a test choose.
 * @param port - the bound port to dial.
 * @param request - the full request text, CRLF line endings included.
 * @returns the bytes read back.
 */
async function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.write(request) })
    let seen = ''
    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      if (seen.includes('\r\n\r\n')) { socket.destroy(); resolve(seen) }
    })
    socket.on('error', reject)
    socket.on('close', () => { resolve(seen) })
  })
}

/** The numeric status of a raw response. */
function statusOf(response: string): number {
  return Number(response.split(' ')[1] ?? '0')
}

/** POST one frame under a chosen `Host`. */
async function postAs(host: Host, hostHeader: string, frame: unknown): Promise<string> {
  const body = JSON.stringify(frame)
  return raw(
    host.port,
    `POST ${host.rpc.rpcPath} HTTP/1.1\r\nHost: ${hostHeader}\r\ncontent-type: application/json\r\n`
    + `content-length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
  )
}

/** Boot a Context with the carrier and the transport, disposed when the test ends. */
async function startHost(t: TestContext, config: Partial<Config> = {}): Promise<Host> {
  const ctx = new Context()
  const port = await startCarrier(ctx)
  await ctx.plugin(IrisRpcHost, { heartbeatMs: 0, ...config })
  t.after(async () => { await ctx.fiber.dispose() })

  const origin = `http://127.0.0.1:${String(port)}`
  return { ctx, rpc: ctx.irisRpc, origin, port, wsUrl: `ws://127.0.0.1:${String(port)}${ctx.irisRpc.eventsPath}` }
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

test('a POST whose Host is a rebinding name is refused before any handler', async (t) => {
  /*
   * The exploit at transport level. `127.0.0.1.nip.io` is a public wildcard DNS
   * name that resolves to loopback, so this is a page an attacker serves,
   * running in the victim's browser, reaching the victim's own host — and after
   * the browser accepts that name the page is *same-origin*, so the JSON
   * content-type gate two tests above is not in its path at all. The `Host`
   * header is the one thing it cannot forge.
   *
   * Measured on the code before this: `200 OK`, and the handler ran.
   */
  const host = await startHost(t)
  let reached = false
  host.rpc.register('chat.delete', () => { reached = true; return {} })

  const refused = await postAs(host, `127.0.0.1.nip.io:${String(host.port)}`, {
    id: 'evil-1', method: 'chat.delete', params: { chatId: 'c1' },
  })

  assert.equal(statusOf(refused), 403)
  assert.equal(reached, false, 'a refused request must not have side effects')
  assert.match(refused, /allow-list/, 'the body names the rule')

  // And the same call under the host's real name still works, so the 403 above
  // is the guard rather than a broken route.
  const accepted = await postAs(host, `127.0.0.1:${String(host.port)}`, {
    id: 'ok-1', method: 'chat.delete', params: { chatId: 'c1' },
  })
  assert.equal(statusOf(accepted), 200)
  assert.equal(reached, true)
})

test('an upgrade whose Host is a rebinding name is refused, Origin or no Origin', async (t) => {
  const host = await startHost(t)
  const evil = `127.0.0.1.nip.io:${String(host.port)}`
  const handshake = (hostHeader: string, origin?: string): Promise<string> => raw(
    host.port,
    `GET ${host.rpc.eventsPath} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\n`
    + 'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
    + (origin === undefined ? '' : `Origin: ${origin}\r\n`) + '\r\n',
  )

  // The pair a rebound page sends. The old rule was "these two agree", which
  // this satisfies — it answered 101 and attached.
  assert.equal(statusOf(await handshake(evil, `http://${evil}`)), 403)
  // An absent Origin used to be allowed outright. It still is, but only after
  // the Host guard, so it is no longer a way in.
  assert.equal(statusOf(await handshake(evil)), 403)
  assert.equal(host.rpc.connections, 0)

  assert.equal(statusOf(await handshake(`127.0.0.1:${String(host.port)}`)), 101, 'a local tool still connects')
})

test('a configured allowedHosts entry is answered, and its neighbours are not', async (t) => {
  const host = await startHost(t, { allowedHosts: ['iris.example.com:4321'] })
  host.rpc.register('chat.abort', () => ({}))

  const frame = { id: 'req-1', method: 'chat.abort', params: { chatId: 'c1' } }
  assert.equal(statusOf(await postAs(host, 'iris.example.com:4321', frame)), 200)
  assert.equal(statusOf(await postAs(host, 'IRIS.EXAMPLE.COM:4321', frame)), 200, 'host names are case-insensitive')
  assert.equal(statusOf(await postAs(host, 'iris.example.com:4322', frame)), 403, 'a different port is not the entry')
  assert.equal(statusOf(await postAs(host, 'evil.iris.example.com:4321', frame)), 403, 'no suffix matching')
})

/** A carrier that claims a network bind without opening one. */
interface StandInCarrier {
  host: string
  port: number
  register: () => () => void
  registerUpgrade: () => () => void
}

test('a network bind with no allowedHosts fails the fiber instead of mounting a route', async () => {
  /*
   * A **stand-in carrier**, not a real `0.0.0.0` listen: binding every
   * interface on a development machine is a real exposure for the lifetime of
   * the test, and the behaviour under test happens before any socket is
   * touched — `[Service.init]` reads `ctx.webServer.host` and throws, which
   * fails the fiber.
   *
   * What the stand-in buys over calling `describeUnconfiguredBind` directly is
   * the **mounting**: it counts registrations, so a version of the service that
   * computed the refusal and then registered the routes anyway goes red here.
   */
  const ctx = new Context()
  let mounted = 0
  const carrier: StandInCarrier = {
    host: '0.0.0.0',
    port: 8787,
    register: () => { mounted += 1; return () => {} },
    registerUpgrade: () => { mounted += 1; return () => {} },
  }
  ctx.provide('webServer', carrier as never)

  // Wrapped in a function: `ctx.plugin` hands back a `Fiber`, which is awaitable
  // but is not a `Promise`, and `assert.rejects` refuses to take it directly.
  await assert.rejects(
    async () => { await ctx.plugin(IrisRpcHost, { heartbeatMs: 0 }) },
    (error: Error) => {
      assert.match(error.message, /allowedHosts/, 'the sentence names the config to set')
      assert.match(error.message, /reverse proxy/, 'and why a proxied deployment needs it')
      return true
    },
  )
  assert.equal(mounted, 0, 'nothing was served while the composition was in that state')

  await ctx.fiber.dispose()
})

test('a network bind that names its hosts starts, and answers exactly those', async () => {
  const ctx = new Context()
  let mounted = 0
  const carrier: StandInCarrier = {
    host: '0.0.0.0',
    port: 8787,
    register: () => { mounted += 1; return () => {} },
    registerUpgrade: () => { mounted += 1; return () => {} },
  }
  ctx.provide('webServer', carrier as never)

  await ctx.plugin(IrisRpcHost, { heartbeatMs: 0, allowedHosts: ['iris.example.com'] })
  assert.equal(mounted, 2, 'the POST route and the upgrade route')

  // A network bind derives loopback for its own port too — that is harmless,
  // because on a machine reachable from outside the dangerous name is the one
  // an attacker can put in a URL, and `127.0.0.1:8787` in a victim's browser
  // reaches the victim's own machine, not this one.
  const { hosts } = ctx.irisRpc.allowance()
  assert.equal(hosts.has('iris.example.com'), true)
  assert.equal(hosts.has('evil.example.com'), false)

  await ctx.fiber.dispose()
})

test('an upgrade from an explicitly allowed origin is accepted', async (t) => {
  const host = await startHost(t, { allowedOrigins: ['http://localhost:5173'] })
  const socket = await connect(host, { origin: 'http://localhost:5173' })
  t.after(() => { socket.close() })

  assert.equal(host.rpc.connections, 1)
})

test('disposing the plugin releases both routes and detaches every page', async (t) => {
  const ctx = new Context()
  // Its own boot rather than `startHost`, because this test disposes the
  // transport's fiber while leaving the carrier up — but through the same
  // blocked-port guard, since the assertion below is a `fetch`.
  const port = await startCarrier(ctx)
  const fiber = await ctx.plugin(IrisRpcHost, { heartbeatMs: 0 })
  t.after(async () => { await ctx.fiber.dispose() })

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

/** Ticks a live page must survive for this test to have seen the loop repeat. */
const HEARTBEAT_TICKS = 3

/**
 * How long a run may take before the *heartbeat itself* is declared missing.
 *
 * A smoke bound, in 21eb3cc's sense: it is 250× the 20 ms period, so it says
 * nothing about the machine's speed and everything about whether the timer
 * exists. Its only job is to fail a dead heartbeat instead of hanging the file
 * for ever — `node --test` puts no deadline on a test that simply never
 * resolves, and "the suite hung" is the least diagnosable red there is.
 */
const HEARTBEAT_SMOKE_MS = 5000

test('the heartbeat probes a live page without dropping it', async (t) => {
  // A heartbeat that mistakes a healthy socket for a dead one would terminate
  // every connected page on a fixed interval, and the symptom — a UI that
  // reconnects every thirty seconds — looks like a network problem rather than a
  // bug here. So the invariant is *survives repeated probing*, and the way to
  // ask that is to count probes, not to sleep.
  //
  // **This used to sleep 80 ms after the first ping and then assert OPEN**, and
  // that made the pass conditional on the machine: 80 ms of wall clock is four
  // ticks on an idle box and an unknown number under a parallel suite, so the
  // test's own premise moved with the load. Waiting for `HEARTBEAT_TICKS` pings
  // asks the same question in the mechanism's unit — a broken `#probe`
  // terminates the socket on its second tick, so the third ping never arrives
  // — and a slow machine only makes this test slower, never redder.
  const host = await startHost(t, { heartbeatMs: 20 })
  const socket = await connect(host)
  t.after(() => { socket.close() })

  let pings = 0
  const probed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => { reject(new Error(`only ${String(pings)} pings in ${String(HEARTBEAT_SMOKE_MS)}ms: no heartbeat`)) },
      HEARTBEAT_SMOKE_MS,
    )
    const done = (error?: Error): void => {
      clearTimeout(timer)
      socket.off('ping', onPing)
      socket.off('close', onClose)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onPing = (): void => {
      pings += 1
      if (pings >= HEARTBEAT_TICKS) done()
    }
    // The failing case, named rather than left to time out: the hub terminated a
    // socket that had answered every ping.
    const onClose = (): void => { done(new Error(`the heartbeat dropped a live page after ${String(pings)} pings`)) }
    socket.on('ping', onPing)
    socket.on('close', onClose)
  })
  await probed

  assert.equal(socket.readyState, socket.OPEN, 'a page that answers its pings stays attached')
  assert.equal(host.rpc.connections, 1)

  // And it is still a working stream, not merely an undropped handle.
  const arrival = nextEvent(socket)
  host.rpc.broadcast({ type: 'chats.updated', chats: [] })
  assert.deepEqual(await arrival, { type: 'chats.updated', chats: [] })
})
