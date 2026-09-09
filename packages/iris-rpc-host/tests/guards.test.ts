import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeHubError } from '../src/errors.ts'

import type { RpcError } from '@iris/protocol'

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

test('every code the contract defines is recognised at run time', () => {
  /*
   * The list this guards used to be a `Set` whose type annotation checked each
   * element without requiring all of them, so a code added to the contract
   * compiled cleanly while the runtime list lacked it — and `toRpcError` then
   * downgraded that code to `internal`. Invisible from both ends: the thrower
   * sees its own code, the reader sees a generic internal failure, and the
   * copy written for the real code never appears. It happened with
   * `quota-exceeded`.
   *
   * The source list is a `Record` keyed by the union now, so the compiler
   * catches an omission. This asserts the other half — that the runtime guard
   * agrees with the contract — because the two could still drift if someone
   * rebuilt the set from something narrower.
   */
  const codes: RpcError['code'][] = [
    'not-found', 'invalid-request', 'provider-error', 'busy', 'unsupported', 'quota-exceeded',
    'no-provider', 'internal',
  ]
  for (const code of codes) {
    assert.equal(isRpcErrorCode(code), true, `${code} is in the contract but not recognised`)
  }

  // And a code carried end to end keeps its identity rather than becoming
  // `internal` — which is the failure the omission actually produced.
  const refused = new Error('card storage is full') as Error & { code: string }
  refused.code = 'quota-exceeded'
  assert.deepEqual(toRpcError(refused), { code: 'quota-exceeded', message: 'card storage is full' })
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

test('the error sink survives everything that has actually reached it', () => {
  // A reporting path that throws turns a logged warning into a dead host, and it
  // does so at the moment something is already going wrong. This is not
  // hypothetical: `ws.send` calls back with `null` on success, a looser guard
  // reported every successful broadcast as a failure, and the sink reading
  // `.message` off that `null` is what took the process down mid-generation.
  //
  // The fix was one line and went in unpinned, so until now its correctness
  // rested on the same reading that had produced the crash.
  assert.equal(describeHubError(new Error('a real failure')), 'a real failure')
  assert.match(describeHubError(null), /non-error value reached the error sink: null/u)
  assert.match(describeHubError(undefined), /non-error value reached the error sink: undefined/u)
  assert.equal(describeHubError('a bare string'), 'a bare string')
  assert.equal(describeHubError(42), '42')
  // `String(null)` alone would render the exact text that made the original bug
  // read as a logger fault instead of a success reported as a failure.
  assert.notEqual(describeHubError(null), 'null')
})
