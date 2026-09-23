/**
 * A page the hub hangs up on is reported, not dropped in silence (rpc-host §3).
 *
 * `terminate()` raises no `error` event, so the two drops the hub makes on its
 * own — a page that answered no heartbeat ping, a page too far behind — left
 * no line anywhere. The owner's stuck reply of 2026-09-24 (web §124) is the
 * case that needed one: a reconnect visible only through its side effects.
 *
 * The page here is a real `ws` client with `autoPong: false`: exactly a page
 * whose pong never comes back (a renderer too busy to read its socket, a laptop
 * asleep), and the nearest wrong implementation — terminating without telling
 * anyone — keeps this test's socket just as closed while `dropped` stays empty.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { WebSocket } from 'ws'

import { EventHub } from '../src/events.ts'

test('a page that answers no heartbeat ping is dropped and the drop is reported', async (t) => {
  const dropped: { reason: string, bufferedBytes: number }[] = []
  const hub = new EventHub({
    heartbeatMs: 20,
    maxPayloadBytes: 1024,
    allowance: () => ({ hosts: new Set([`127.0.0.1:${String(port)}`]), origins: new Set() }),
    onRefused: () => undefined,
    onError: () => undefined,
    onDropped: (reason, bufferedBytes) => { dropped.push({ reason, bufferedBytes }) },
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { hub.handleUpgrade(req, socket, head) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  t.after(async () => {
    await hub.close()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  })

  const page = new WebSocket(`ws://127.0.0.1:${String(port)}/iris/events`, { autoPong: false })
  await once(page, 'open')
  assert.equal(hub.size, 1)

  await once(page, 'close')
  assert.equal(dropped.length, 1, `one drop reported, got ${JSON.stringify(dropped)}`)
  assert.equal(dropped[0]?.reason, 'heartbeat')
})
