import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RpcError } from '@iris/protocol'

import { testClient } from './helpers.ts'

/**
 * `registerPluginMethod` — the fake of the host's dynamic half. Held to the
 * same rule as everything here: behave like the host, not like a convenience.
 * So the schema gate refuses what the schema refuses, a disabled owner
 * answers `unsupported`, and a name cannot shadow the static surface.
 */

/** A schema in the smallest shape the gate reads: `safeParse`. */
const schema = {
  safeParse(input: unknown) {
    const floor = (input as { floor?: unknown } | null)?.floor
    if (input !== null && typeof input === 'object' && Number.isSafeInteger(floor)) {
      return { success: true as const, data: input as { floor: number } }
    }
    return { success: false as const, error: { issues: [{ message: 'floor must be an integer' }] } }
  },
}

function refusalOf(promise: Promise<unknown>): Promise<RpcError> {
  return promise.then(() => {
    throw new Error('the call resolved where the host would have refused')
  }, (error: unknown) => error as RpcError)
}

test('a registered method answers with its handler and validates params', async () => {
  const client = testClient()
  const seen: unknown[] = []
  const dispose = client.registerPluginMethod('demo.echo', schema, params => {
    seen.push(params)
    return { ok: true }
  })

  const answer = await client.call('demo.echo', { floor: 3 })
  assert.deepEqual(answer, { ok: true })
  assert.deepEqual(seen, [{ floor: 3 }])

  const refused = await refusalOf(client.call('demo.echo', { floor: 'three' }))
  assert.equal(refused.code, 'invalid-request')
  assert.deepEqual(seen, [{ floor: 3 }], 'a refused payload reached the handler')

  dispose()
  client.dispose()
})

test('the fence reaches a runtime method\'s handler, preserved', async () => {
  const client = testClient()
  let fence: number | undefined
  const dispose = client.registerPluginMethod('demo.fenced', schema, params => {
    fence = (params as { pluginRevision?: number }).pluginRevision
    return {}
  })

  await client.call('demo.fenced', { floor: 1, pluginRevision: 9 })
  assert.equal(fence, 9)

  dispose()
  client.dispose()
})

test('a gated method answers unsupported while its plugin is disabled', async () => {
  const client = testClient()
  const dispose = client.registerPluginMethod(
    'demo.gated',
    schema,
    () => ({}),
    { pluginId: 'tavern-helper' },
  )

  // While the owner is enabled the method answers like any other.
  await client.call('demo.gated', { floor: 0 })

  // The catalog's own dependency rule applies: MVU sits on Tavern Helper, so
  // the dependent comes down first — the same order the plugin center would
  // demand of a person doing this by hand.
  await client.call('plugin.disable', { id: 'mvu' })
  await client.call('plugin.disable', { id: 'tavern-helper' })
  const refused = await refusalOf(client.call('demo.gated', { floor: 0 }))
  assert.equal(refused.code, 'unsupported')
  assert.match(refused.message, /tavern-helper/)

  await client.call('plugin.enable', { id: 'tavern-helper' })
  await client.call('plugin.enable', { id: 'mvu' })
  await client.call('demo.gated', { floor: 0 })

  dispose()
  client.dispose()
})

test('the disposer removes both halves and the name is free again', async () => {
  const client = testClient()
  const dispose = client.registerPluginMethod('demo.once', schema, () => ({}))
  await client.call('demo.once', { floor: 0 })

  dispose()
  const refused = await refusalOf(client.call('demo.once', { floor: 0 }))
  assert.equal(refused.code, 'unsupported')

  // And re-registerable — one registration per name at a time, not forever.
  const reseat = client.registerPluginMethod('demo.once', schema, () => ({ again: true }))
  assert.deepEqual(await client.call('demo.once', { floor: 0 }), { again: true })
  reseat()
  client.dispose()
})

test('a builtin name or a taken name is refused at registration', () => {
  const client = testClient()
  assert.throws(
    () => client.registerPluginMethod('chat.send', schema, () => ({})),
    /built-in/,
  )

  const dispose = client.registerPluginMethod('demo.taken', schema, () => ({}))
  assert.throws(
    () => client.registerPluginMethod('demo.taken', schema, () => ({})),
    /already registered/,
  )
  dispose()
  client.dispose()
})

test('a dynamic name nobody registered is unsupported, not a fallthrough', async () => {
  const client = testClient()
  const refused = await refusalOf(client.call('demo.ghost', { floor: 0 }))
  assert.equal(refused.code, 'unsupported')
  assert.match(refused.message, /demo\.ghost/)
  client.dispose()
})
