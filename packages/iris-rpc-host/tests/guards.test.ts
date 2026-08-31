import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isJsonContentType, isOriginAllowed, isRpcErrorCode, toRpcError } from '../src/index.ts'

/**
 * The two guards and the error projection, at the edges.
 *
 * These are table-driven because each one is a boundary check whose failure
 * mode is silent: a content type that should not have been accepted, or an
 * origin that should not have been let in, looks exactly like a working system.
 */

test('a content type names JSON only when the media type matches exactly', () => {
  const cases: [string | undefined, boolean][] = [
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['  APPLICATION/JSON  ', true],
    ['application/json-patch+json', false],
    ['text/plain;charset=UTF-8', false],
    ['multipart/form-data', false],
    ['application/x-www-form-urlencoded', false],
    ['', false],
    [undefined, false],
  ]
  for (const [header, expected] of cases) {
    assert.equal(isJsonContentType(header), expected, `content-type: ${String(header)}`)
  }
})

test('an origin is allowed when it matches the host, is opted into, or is absent', () => {
  const allowed = ['http://localhost:5173']
  const cases: [string | undefined, string | undefined, boolean][] = [
    // No Origin at all: a browser always sends one, so this is a local tool.
    [undefined, '127.0.0.1:8080', true],
    ['http://127.0.0.1:8080', '127.0.0.1:8080', true],
    // Same host, different scheme: still the same authority to the carrier,
    // which serves plain HTTP and has no way to distinguish them.
    ['https://127.0.0.1:8080', '127.0.0.1:8080', true],
    ['http://127.0.0.1:9999', '127.0.0.1:8080', false],
    ['https://evil.example', '127.0.0.1:8080', false],
    ['http://localhost:5173', '127.0.0.1:8080', true],
    ['null', '127.0.0.1:8080', false],
    ['http://127.0.0.1:8080', undefined, false],
  ]
  for (const [origin, host, expected] of cases) {
    assert.equal(isOriginAllowed(origin, host, allowed), expected, `origin ${String(origin)} host ${String(host)}`)
  }
})

test('only the contract’s own codes are wire codes', () => {
  assert.equal(isRpcErrorCode('not-found'), true)
  assert.equal(isRpcErrorCode('busy'), true)
  // A provider-level code from `dsh-llm` is not a protocol code.
  assert.equal(isRpcErrorCode('TRANSPORT'), false)
  assert.equal(isRpcErrorCode(404), false)
  assert.equal(isRpcErrorCode(undefined), false)
})

test('a thrown value becomes a wire error without inventing a code', () => {
  const tagged = new Error('chat is generating') as Error & { code: string }
  tagged.code = 'busy'
  assert.deepEqual(toRpcError(tagged), { code: 'busy', message: 'chat is generating' })

  const foreign = new Error('endpoint refused the connection') as Error & { code: string }
  foreign.code = 'ECONNREFUSED'
  assert.deepEqual(toRpcError(foreign), { code: 'internal', message: 'endpoint refused the connection' })

  assert.deepEqual(toRpcError('a bare string'), { code: 'internal', message: 'a bare string' })
})
