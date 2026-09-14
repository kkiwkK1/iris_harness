import assert from 'node:assert/strict'
import { test } from 'node:test'

import { z } from 'zod'

import {
  lookupRequestSchema,
  parseRequest,
  registerRequestSchema,
} from '../src/index.ts'

/** A schema shaped like a plugin's contribution, small enough to read. */
const pingSchema = z.object({ floor: z.number().int().min(0) })

test('a registered method parses, validates, and keeps its pluginRevision', async () => {
  // The handoff named this preservation as the thing dynamic registration
  // must not lose: zod strips unknown keys, and the fence does not live in
  // any schema, so `parseRequest` re-attaches it by hand. That code is
  // method-agnostic — this test is the proof a runtime method rides it too.
  // (The params read back through a cast: a runtime method's type is its
  // registered schema, which the type system never sees.)
  const dispose = registerRequestSchema('demo.ping', pingSchema)
  try {
    const result = parseRequest('demo.ping', { floor: 3, pluginRevision: 7 })
    assert.equal(result.ok, true)
    if (result.ok) {
      const params = result.params as { floor: number, pluginRevision?: number }
      assert.equal(params.floor, 3)
      assert.equal(params.pluginRevision, 7)
    }

    const bare = parseRequest('demo.ping', { floor: 1 })
    assert.equal(bare.ok, true)
    if (bare.ok) {
      assert.equal((bare.params as { pluginRevision?: number }).pluginRevision, undefined)
    }
  } finally {
    dispose()
  }
})

test('a runtime method is held to its schema exactly as a built-in is', () => {
  const dispose = registerRequestSchema('demo.strict', pingSchema)
  try {
    const result = parseRequest('demo.strict', { floor: -1 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'invalid-request')

    const malformed = parseRequest('demo.strict', { floor: 'three' })
    assert.equal(malformed.ok, false)
  } finally {
    dispose()
  }
})

test('an unregistered name is still unsupported, built-in or dynamic', () => {
  // Two readings of "we do not speak it", split since the registry landed:
  // a name the static vocabulary never knew, and a name whose runtime
  // registration is gone. Both answer `unsupported`; neither reaches a
  // handler.
  const builtin = parseRequest('chat.teleport' as never, {})
  assert.equal(builtin.ok, false)
  if (!builtin.ok) assert.equal(builtin.error.code, 'unsupported')

  const dynamic = parseRequest('demo.never-registered', {})
  assert.equal(dynamic.ok, false)
  if (!dynamic.ok) {
    assert.equal(dynamic.error.code, 'unsupported')
    assert.match(dynamic.error.message, /demo\.never-registered/)
  }
})

test('a refused pluginRevision is refused for a runtime method too', () => {
  const dispose = registerRequestSchema('demo.fenced', pingSchema)
  try {
    const result = parseRequest('demo.fenced', { floor: 0, pluginRevision: -2 })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid-request')
      assert.match(result.error.message, /pluginRevision/)
    }
  } finally {
    dispose()
  }
})

test('built-in names and taken names are refused at registration', () => {
  assert.throws(
    () => registerRequestSchema('chat.send', pingSchema),
    /built-in/,
  )

  const dispose = registerRequestSchema('demo.taken', pingSchema)
  try {
    assert.throws(
      () => registerRequestSchema('demo.taken', pingSchema),
      /already registered/,
    )
  } finally {
    dispose()
  }
})

test('the disposer removes the registration and cannot evict a replacement', () => {
  const first = registerRequestSchema('demo.recycle', pingSchema)
  assert.notEqual(lookupRequestSchema('demo.recycle'), undefined)
  first()
  assert.equal(lookupRequestSchema('demo.recycle'), undefined)
  // Disposing twice is the plugin's own business, not a crash.
  first()

  // A fresh schema object, so identity is the thing under test: a disposer
  // from a replaced registration must not evict the replacement.
  const second = registerRequestSchema('demo.recycle', z.object({ floor: z.number().int().min(0) }))
  // The stale disposer from the replaced registration removes nothing.
  first()
  assert.notEqual(lookupRequestSchema('demo.recycle'), undefined)
  second()
  assert.equal(lookupRequestSchema('demo.recycle'), undefined)
})
