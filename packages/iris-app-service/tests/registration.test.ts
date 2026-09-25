import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RPC_METHODS, requestSchemas, type RpcMethod } from '@iris/protocol'

import { registerHandlers, type RegisterMethod } from '../src/registration.ts'
import type { Handlers } from '../src/service.ts'

/**
 * Every contract method must be both implemented AND reachable.
 *
 * These are two different lists and only one of them used to be checked. Every
 * other test in this package calls `service.handlers()` directly, which is the
 * right way to test behaviour and the reason a gap here stays invisible: five
 * bridge methods were fully implemented, fully tested, and never registered on
 * the transport, so a browser calling them would have been told the method does
 * not exist while the suite ran green.
 *
 * Registration was then written out one call per method, on the premise that a
 * loop "needs a cast that discards exactly the check worth having", and this
 * file searched `index.ts` as text for one `ctx.irisRpc.register('<m>'` per
 * method — a search a commented-out line passed. The premise was false of a
 * generic per-method helper (`../src/registration.ts` records the reversal),
 * so registration is a loop and this test drives that loop with a recording
 * transport instead of reading source text. The wire half — that the booted
 * host really answers every method — is `apps/iris/tests/rpc-transport.test.ts`.
 */

/** A handler table whose every entry is a distinct, identifiable function. */
function fakeHandlers(): Handlers {
  const table: Record<string, () => Promise<unknown>> = {}
  for (const method of Object.keys(requestSchemas)) {
    table[method] = async () => ({ method })
  }
  // A structural stand-in: the entries are real functions, one per key, and
  // only their identity is read below.
  return table as unknown as Handlers
}

test('RPC_METHODS is exactly the contract\'s key list', () => {
  assert.deepEqual([...RPC_METHODS], Object.keys(requestSchemas))
  assert.equal(new Set(RPC_METHODS).size, RPC_METHODS.length, 'a method appears twice')
  assert.ok(RPC_METHODS.includes('script.context'), 'the contract itself parsed')
  assert.ok(Object.isFrozen(RPC_METHODS), 'a consumer could push onto the shared list')
})

test('every contract method is registered once, with its own handler', () => {
  const handlers = fakeHandlers()
  const registered: Array<{ method: string, handler: unknown }> = []
  const register: RegisterMethod = (method, handler) => {
    registered.push({ method, handler })
    return () => {}
  }

  registerHandlers(register, handlers)

  const methods = Object.keys(requestSchemas)
  // A floor, not the incidental count: an empty or truncated walk must fail.
  assert.ok(methods.length > 100, `read ${String(methods.length)} methods from the contract`)
  assert.deepEqual(registered.map(entry => entry.method).sort(), [...methods].sort())
  const mispaired = registered.filter(entry => entry.handler !== handlers[entry.method as RpcMethod])
  assert.deepEqual(mispaired.map(entry => entry.method), [], 'a name was registered with another method\'s handler')
})

test('the returned disposer revokes every method, last-registered first', () => {
  const order: string[] = []
  const revoked: string[] = []
  const register: RegisterMethod = method => {
    order.push(method)
    return () => { revoked.push(method) }
  }

  const unregister = registerHandlers(register, fakeHandlers())
  assert.deepEqual(revoked, [], 'nothing is revoked before the disposer runs')
  unregister()

  assert.deepEqual(revoked, [...order].reverse())
  assert.equal(revoked.length, RPC_METHODS.length)
})
