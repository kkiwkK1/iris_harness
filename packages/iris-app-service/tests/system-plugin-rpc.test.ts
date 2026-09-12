import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { parseRequest, registerRequestSchema } from '@iris/protocol'

import { SystemPluginRuntime } from '../src/system-plugins.ts'
import type { SystemPluginDefinition } from '@iris/plugin-api'

/**
 * `scope.registerRpc`'s lifecycle, exercised through the real runtime: the
 * registration lives exactly as long as the activation that made it, every
 * call is admitted through the plugin's lease, and a disable drains in-flight
 * calls before the registration goes.
 *
 * The transport half stands behind a stub registrar provided on the harness
 * context under `'irisRpc'` — the same provide/read pair the runtime's
 * capability face uses — so these tests check the runtime's contract, not
 * HTTP plumbing the rpc-host suite already owns.
 */
interface RegistrarStub {
  handlers: Map<string, (params: unknown) => unknown>
  register(method: string, handler: (params: unknown) => unknown): () => void
}

function registrarStub(): RegistrarStub {
  const handlers = new Map<string, (params: unknown) => unknown>()
  return {
    handlers,
    register(method, handler) {
      if (handlers.has(method)) throw new Error(`a handler for "${method}" is already registered`)
      handlers.set(method, handler)
      return () => {
        if (handlers.get(method) === handler) handlers.delete(method)
      }
    },
  }
}

interface Harness {
  runtime: SystemPluginRuntime
  registrar: RegistrarStub
}

async function harness(
  t: TestContext,
  definitions: readonly SystemPluginDefinition[],
  defaultEnabled: readonly string[] = definitions.map(row => row.id),
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugin-rpc-'))
  const context = new Context()
  const registrar = registrarStub()
  context.provide('irisRpc', registrar)
  const runtime = new SystemPluginRuntime({
    context,
    file: join(dir, 'system-plugins.json'),
    definitions,
    defaultEnabled,
  })
  t.after(async () => {
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return { runtime, registrar }
}

/** Send one request the way the transport would: schema first, handler second. */
async function request(
  value: Harness,
  method: string,
  params: unknown,
): Promise<{ ok: true, result: unknown } | { ok: false, code: string, message: string }> {
  const parsed = parseRequest(method, params)
  if (!parsed.ok) return { ok: false, code: parsed.error.code, message: parsed.error.message }
  const handler = value.registrar.handlers.get(method)
  if (handler === undefined) {
    return { ok: false, code: 'unsupported', message: `no handler is registered for "${method}"` }
  }
  try {
    return { ok: true, result: await handler(parsed.params) }
  } catch (error: unknown) {
    const wire = error as { code?: unknown, message?: unknown }
    return {
      ok: false,
      code: typeof wire.code === 'string' ? wire.code : 'internal',
      message: String(wire.message ?? error),
    }
  }
}

/**
 * A schema written by hand, not by zod — deliberately, twice over.
 *
 * `@iris/app-service` does not depend on zod (the protocol owns it), and the
 * `registerRpc` contract claims any schema library works because it reads
 * only `safeParse`. This object is that claim, exercised.
 */
const demoSchema = {
  safeParse(input: unknown) {
    const floor = (input as { floor?: unknown } | null)?.floor
    if (input !== null && typeof input === 'object' && Number.isSafeInteger(floor) && (floor as number) >= 0) {
      return { success: true as const, data: input as { floor: number } }
    }
    return {
      success: false as const,
      error: { issues: [{ message: 'floor must be a nonnegative integer' }] },
    }
  },
}

test('an activation registers a callable method and disable takes it away', async (t) => {
  let calls = 0
  const plugin: SystemPluginDefinition = {
    id: 'demo',
    name: 'Demo',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('demo.count', demoSchema, params => {
        calls += 1
        return { floor: (params as { floor: number }).floor, pluginId: scope.pluginId }
      })
    },
  }
  const value = await harness(t, [plugin])
  await value.runtime.initialize()

  assert.equal(value.registrar.handlers.has('demo.count'), true)
  const answer = await request(value, 'demo.count', { floor: 2, pluginRevision: value.runtime.snapshot().revision })
  assert.deepEqual(answer, { ok: true, result: { floor: 2, pluginId: 'demo' } })
  assert.equal(calls, 1)

  // Malformed params are refused by the registered schema before the handler.
  const malformed = await request(value, 'demo.count', { floor: -1 })
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.equal(malformed.code, 'invalid-request')

  await value.runtime.disable('demo')
  assert.equal(value.registrar.handlers.has('demo.count'), false, 'the registration outlived its activation')
  const refused = await request(value, 'demo.count', { floor: 0 })
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.equal(refused.code, 'unsupported')
    // The schema half left with the handler half, so the refusal names the
    // method at the validation gate — an unregistered method, whole.
    assert.match(refused.message, /demo\.count/)
  }
})

test('a request fenced to a stale runtime revision is refused', async (t) => {
  const plugin: SystemPluginDefinition = {
    id: 'fenced',
    name: 'Fenced',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('fenced.echo', demoSchema, params => params)
    },
  }
  const value = await harness(t, [plugin])
  await value.runtime.initialize()

  const current = value.runtime.snapshot().revision
  const fresh = await request(value, 'fenced.echo', { floor: 0, pluginRevision: current })
  assert.equal(fresh.ok, true)

  const stale = await request(value, 'fenced.echo', { floor: 0, pluginRevision: current - 1 })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.equal(stale.code, 'unsupported')
    assert.match(stale.message, /stale runtime revision/)
  }
})

test('disable drains an in-flight call before the registration goes', async (t) => {
  let releaseCall: (() => void) | undefined
  const plugin: SystemPluginDefinition = {
    id: 'slow',
    name: 'Slow',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('slow.work', demoSchema, () => new Promise(resolve => {
        releaseCall = () => resolve({ drained: true })
      }))
    },
  }
  const value = await harness(t, [plugin])
  await value.runtime.initialize()

  const inFlight = request(value, 'slow.work', { floor: 1 })
  let settled = false
  void inFlight.then(() => { settled = true })

  const disabling = value.runtime.disable('slow')
  await new Promise(resolve => { setTimeout(resolve, 20) })
  assert.equal(settled, false, 'disable completed over an admitted call it should have drained')
  assert.equal(value.registrar.handlers.has('slow.work'), true, 'the registration left before its lease drained')

  releaseCall!()
  assert.deepEqual(await inFlight, { ok: true, result: { drained: true } })
  await disabling
  assert.equal(value.registrar.handlers.has('slow.work'), false)
})

test('reload re-registers once and the old method does not answer twice', async (t) => {
  let generations = 0
  const plugin: SystemPluginDefinition = {
    id: 'cycle',
    name: 'Cycle',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      generations += 1
      scope.registerRpc('cycle.tick', demoSchema, () => ({ generation: generations }))
    },
  }
  const value = await harness(t, [plugin])
  await value.runtime.initialize()

  const first = await request(value, 'cycle.tick', { floor: 0 })
  assert.deepEqual(first, { ok: true, result: { generation: 1 } })

  await value.runtime.reload('cycle')
  assert.equal(value.registrar.handlers.size, 1, 'reload accumulated registrations')
  const second = await request(value, 'cycle.tick', { floor: 0 })
  assert.deepEqual(second, { ok: true, result: { generation: 2 } })
})

test('a name collision fails the arriving plugin and leaves the seated one serving', async (t) => {
  const seated: SystemPluginDefinition = {
    id: 'seated',
    name: 'Seated',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('shared.name', demoSchema, () => ({ owner: 'seated' }))
    },
  }
  const arriving: SystemPluginDefinition = {
    id: 'arriving',
    name: 'Arriving',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('shared.name', demoSchema, () => ({ owner: 'arriving' }))
    },
  }
  // Both start in the enabled set; the seated one activates first (catalog
  // order), the arriving one fails its own activation — which startup
  // isolates to that plugin rather than failing the boot.
  const value = await harness(t, [seated, arriving])
  await value.runtime.initialize()

  const row = value.runtime.snapshot().plugins.find(plugin => plugin.id === 'arriving')
  assert.equal(row?.status, 'error')
  assert.match(row?.error ?? '', /already registered/)

  const answer = await request(value, 'shared.name', { floor: 0 })
  assert.deepEqual(answer, { ok: true, result: { owner: 'seated' } })
})

test('a collision with a built-in name fails inside activate, not at first call', async (t) => {
  const plugin: SystemPluginDefinition = {
    id: 'greedy',
    name: 'Greedy',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('chat.send', demoSchema, () => ({}))
    },
  }
  const value = await harness(t, [plugin])
  // Startup isolates the failure to this plugin's own activation: initialize
  // resolves, the row says error, and the built-in schema was never touched.
  await value.runtime.initialize()
  const row = value.runtime.snapshot().plugins.find(candidate => candidate.id === 'greedy')
  assert.equal(row?.status, 'error')
  assert.match(row?.error ?? '', /built-in/)

  const wire = parseRequest('chat.send', { chatId: 'c1', text: '你好' })
  assert.equal(wire.ok, true, 'the built-in schema was disturbed')
})

test('a plugin that ignores its disposer still cannot outlive the fiber', async (t) => {
  // The dispose path does not depend on the plugin's goodwill: the
  // registration is an effect of the activation's own Cordis fiber, so the
  // runtime's disposal takes it with or without the returned handle.
  const plugin: SystemPluginDefinition = {
    id: 'forgetful',
    name: 'Forgetful',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      scope.registerRpc('forgetful.once', demoSchema, () => ({}))
    },
  }
  const value = await harness(t, [plugin])
  await value.runtime.initialize()
  assert.equal(value.registrar.handlers.has('forgetful.once'), true)

  await value.runtime.uninstall('forgetful')
  assert.equal(value.registrar.handlers.has('forgetful.once'), false)
  // And the schema half went with it: the protocol table holds nothing.
  const parsed = parseRequest('forgetful.once', { floor: 0 })
  assert.equal(parsed.ok, false)
})

test('the returned disposer is idempotent and halves stay paired', async (t) => {
  // Declared before the definition: the plugin's activate runs during
  // initialize(), below, and pushes its handle here.
  const disposers: Array<() => void> = []
  const plugin: SystemPluginDefinition = {
    id: 'tidy',
    name: 'Tidy',
    description: 'rpc fixture',
    version: '1.0.0',
    apiVersion: 1,
    activate(scope) {
      // Registers through the scope but wires nothing of its own — the
      // explicit handle is the whole exercise.
      disposers.push(scope.registerRpc('tidy.tick', demoSchema, () => ({})))
    },
  }
  const value = await harness(t, [plugin])
  await value.runtime.initialize()
  assert.equal(disposers.length, 1)

  // The schema half is in the protocol's table; removing through the handle
  // takes both halves, and a second call is a no-op.
  disposers[0]!()
  disposers[0]!()
  assert.equal(value.registrar.handlers.has('tidy.tick'), false)
  assert.equal(parseRequest('tidy.tick', { floor: 0 }).ok, false)

  // The runtime's own disable of an already-deregistered method is quiet.
  await value.runtime.disable('tidy')

  // The name is free again: a direct protocol registration seats and leaves.
  const reseat = registerRequestSchema('tidy.tick', demoSchema)
  reseat()
})
