import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { describeUnconfiguredBind } from '@iris/rpc-host'

/**
 * The DNS-rebinding exploit, fired at a booted host, and refused.
 *
 * **What is being defended.** `nip.io` and `sslip.io` are public wildcard DNS
 * services that resolve any name of the shape `127.0.0.1.nip.io` to
 * `127.0.0.1`. So an attacker can serve a page from
 * `http://127.0.0.1.nip.io:8787` — an origin they own, in the victim's browser
 * — and every request it makes goes to the Iris host on the victim's own
 * machine. After the browser has accepted that name as loopback the page is
 * *same-origin* with the host, which means none of the cross-site defences
 * apply: no preflight is required, the absence of CORS headers stops nothing,
 * and a `new WebSocket('ws://127.0.0.1.nip.io:8787/iris/events')` reads every
 * `stream.text` delta of every conversation. It takes no interaction beyond
 * visiting a page, and Firefox and Safari ship no Private Network Access check
 * to fall back on.
 *
 * Measured against the code before this file existed, on a real socket
 * (`packages/iris-rpc-host` on an ephemeral port): the POST answered
 * `200 OK` and the handler ran, the upgrade answered `101 Switching Protocols`
 * and the socket attached. The old `Origin` rule compared the `Origin` against
 * the `Host` header, and the rebinding page sends the two in agreement.
 *
 * **Why raw sockets.** `fetch` forbids setting `Host`, and `ws` builds its own.
 * The header this test is about is exactly the one those libraries will not let
 * a caller write, so the requests here are typed out and the response's status
 * line is read back. That also makes the duplicate-`Host` case expressible,
 * which no client library will produce.
 *
 * @module apps/iris/tests/host-allowlist
 */

let ctx: Context
let dataDir: string
let distDir: string
let port: number
/** The rebinding authority, on this run's actual port. */
let rebinding: string

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'iris-hostguard-'))
  await mkdir(join(dataDir, 'default-user', 'characters'), { recursive: true })

  // A dist tree just real enough to mount the sandbox route and have one file
  // in it; the route resolves `<dirname(webDistIndex)>/sandbox`.
  distDir = await mkdtemp(join(tmpdir(), 'iris-hostguard-dist-'))
  await mkdir(join(distDir, 'sandbox'), { recursive: true })
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>t</title>', 'utf8')
  await writeFile(join(distDir, 'sandbox', 'preset.js'), 'globalThis.x = 1\n', 'utf8')

  process.env.IRIS_TEST_DATA_DIR = dataDir
  process.env.IRIS_TEST_WEB_DIST = join(distDir, 'index.html')

  ctx = await boot('iris-host-allowlist', fileURLToPath(new URL('./fixtures/host-allowlist.cordis.yml', import.meta.url)))
  port = ctx.webServer.port
  rebinding = `127.0.0.1.nip.io:${String(port)}`
})

after(async () => {
  await ctx.fiber.dispose()
  // Windows keeps a handle inside the profile for a moment after disposal; the
  // same retry the other host tests use.
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  await rm(distDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

/** The real authority this host bound, i.e. what a legitimate page sends. */
function real(): string {
  return `127.0.0.1:${String(port)}`
}

/**
 * Speak one raw request and return everything up to the end of the head.
 * @param request - the full request text, CRLF line endings included.
 * @returns the bytes read back, decoded as UTF-8.
 */
async function raw(request: string): Promise<string> {
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
function status(response: string): number {
  return Number(response.split(' ')[1] ?? '0')
}

/** GET one path under a chosen `Host`. */
async function get(path: string, host: string): Promise<string> {
  return raw(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
}

/** POST one RPC frame under a chosen `Host`, as a browser would. */
async function rpc(frame: unknown, host: string): Promise<string> {
  const body = JSON.stringify(frame)
  return raw(
    `POST /iris/rpc HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\n`
    + `content-length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
  )
}

/** Attempt the event-socket handshake with a chosen `Host` and `Origin`. */
async function upgrade(host: string, origin?: string): Promise<string> {
  return raw(
    `GET /iris/events HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
    + (origin === undefined ? '' : `Origin: ${origin}\r\n`)
    + '\r\n',
  )
}

test('the exploit: a POST from a rebound page is refused, and nothing ran', async () => {
  /*
   * `chat.create` rather than a read, because the point is not the status code
   * — it is that the side effect did not happen. A 403 with the chat created
   * anyway would look identical from the attacker's side of a `no-cors` fetch,
   * which is the only view they have.
   */
  const attempt = await rpc({ id: 'evil-1', method: 'chat.create', params: { characterId: 'aria' } }, rebinding)

  assert.equal(status(attempt), 403, 'a rebinding Host must not be answered')
  assert.match(attempt, /Host header/i, 'and the refusal says which rule refused it')

  const listed = await rpc({ id: 'ok-1', method: 'chat.list', params: {} }, real())
  assert.equal(status(listed), 200, 'the legitimate page is unaffected')
  const frame = JSON.parse(listed.split('\r\n\r\n')[1] ?? '{}') as { ok: boolean, result?: { chats: unknown[] } }
  assert.equal(frame.ok, true)
  assert.deepEqual(frame.result?.chats, [], 'the refused call created nothing')
})

test('the exploit: the event socket refuses the rebound origin it used to accept', async () => {
  /*
   * The pair the browser writes for a page at `http://127.0.0.1.nip.io:<port>`:
   * `Host` and `Origin` name the same authority, and the old rule was exactly
   * "those two agree". This is the single assertion that would have gone red on
   * the vulnerable code.
   */
  const attempt = await upgrade(rebinding, `http://${rebinding}`)

  assert.equal(status(attempt), 403, 'the conversation stream is not readable from a rebound origin')
  assert.equal(ctx.irisRpc.connections, 0, 'and no socket was attached')
})

test('a legitimate same-origin page still opens the event socket', async () => {
  const accepted = await upgrade(real(), `http://${real()}`)

  // The status line is the whole assertion: this helper hangs up as soon as it
  // has read the head, so `connections` is a race by the time it returns — and
  // a 101 means the handshake was completed, which is the thing being asked.
  assert.equal(status(accepted), 101, 'the product itself must keep working')
})

test('an opted-into dev origin still opens the event socket, and a foreign one does not', async () => {
  const dev = await upgrade(real(), 'http://iris.test')
  assert.equal(status(dev), 101, 'allowedOrigins is still the way a dev server gets in')

  const foreign = await upgrade(real(), 'https://evil.example')
  assert.equal(status(foreign), 403, 'a correct Host does not excuse a foreign Origin')

  // A non-browser client sends no `Origin` at all. It is still allowed — but
  // only after the `Host` guard, which it must satisfy like anything else.
  assert.equal(status(await upgrade(real())), 101)
  assert.equal(status(await upgrade(rebinding)), 403, 'an absent Origin is not a way past the Host guard')
})

test('a Host that is absent or repeated is refused on the upgrade', async () => {
  const twice = await raw(
    `GET /iris/events HTTP/1.1\r\nHost: ${real()}\r\nHost: ${rebinding}\r\n`
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  )
  assert.equal(status(twice), 403, 'two Host headers have no single meaning, so there is nothing to allow')
})

test('every route the application registers refuses a foreign Host and answers the real one', async () => {
  /*
   * The four routes `@iris/app-service` puts on the same carrier. They are not
   * the RPC endpoint, and a guard that lived only there would leave the user's
   * character library (avatars), the card code running in their sandbox (the
   * bundle and the sandbox assets) and the build identity (`/version`) readable
   * to the same rebound page.
   *
   * The accepted side asserts "not 403" rather than 200: `/version` answers a
   * body, the sandbox asset answers a file, and the other two answer 404 for a
   * name that does not exist — which is the right answer and is not a refusal.
   */
  const routes = ['/version', '/iris/avatar/aria.png', '/iris/script-bundle/nothing.js', '/sandbox/preset.js']

  for (const path of routes) {
    assert.equal(status(await get(path, rebinding)), 403, `${path} must refuse a rebinding Host`)
    assert.notEqual(status(await get(path, real())), 403, `${path} must answer the real host`)
  }

  // And the one that exists really is served, so the loop above is not passing
  // on four 404s.
  const asset = await get('/sandbox/preset.js', real())
  assert.equal(status(asset), 200, 'the sandbox asset a card frame loads is still served')
  assert.match(asset, /access-control-allow-origin/i, 'with the CORS header its opaque-origin frame needs')
})

test('the allow-set is built from the port that was bound, not one next door', async () => {
  /*
   * This composition asks for `port: 0`, so the number below was chosen by the
   * OS at boot — nothing in the fixture, the schema or this file knows it in
   * advance. That is the whole point: a second Iris on the same machine (this
   * project's parallel-work convention) listens on a different port, and its
   * authority is not this host's.
   */
  const neighbour = `127.0.0.1:${String(port + 1)}`
  assert.equal(status(await get('/version', neighbour)), 403)
  assert.equal(status(await rpc({ id: 'n-1', method: 'chat.list', params: {} }, neighbour)), 403)

  // The names that *are* this host, all three of them, derived from that port.
  for (const host of [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`, `[::1]:${String(port)}`]) {
    assert.notEqual(status(await get('/version', host)), 403, `${host} is this host`)
  }
})

test('a network bind with no allowedHosts refuses to start, and says what to set', () => {
  /*
   * Asserted on the check the composition calls rather than by booting a
   * carrier on `0.0.0.0`: binding every interface on a development machine is
   * a real exposure for the lifetime of the test and trips the Windows firewall
   * prompt, and the behaviour under test is entirely this function's — the
   * service calls it in `[Service.init]` before either route is registered, and
   * throwing there fails the fiber.
   *
   * The mounting is what `packages/iris-rpc-host/tests/transport.test.ts`
   * covers, with a stand-in carrier that claims `0.0.0.0`.
   */
  assert.equal(describeUnconfiguredBind('127.0.0.1', []), undefined, 'the product composition is loopback')

  const refusal = describeUnconfiguredBind('0.0.0.0', [])
  assert.ok(refusal !== undefined)
  assert.match(refusal, /allowedHosts/)
  assert.match(refusal, /IRIS_ALLOWED_HOSTS/)
  assert.match(refusal, /reverse proxy/)
})
