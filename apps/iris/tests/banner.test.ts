import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describePortDrift, describePortInUse } from '../banner.ts'

/**
 * The startup banner's two port sentences.
 *
 * A unit on the formatting functions rather than on `bin.ts`, because `bin.ts`
 * boots a composition on import and there is no way to ask it what it would
 * print without starting a host.
 *
 * @module apps/iris/tests/banner
 */

test('a configured port that is not the bound one is announced', () => {
  const line = describePortDrift(8787, 8801)
  assert.ok(line !== undefined, 'drift must not be silent')
  assert.ok(line.includes('8787'), line)
  assert.ok(line.includes('8801'), line)
  assert.ok(/another iris instance/iu.test(line), `the line must name the likeliest cause: ${line}`)
})

test('port 0 is a request, not drift', () => {
  // `port: 0` asks for any free port. Every headless test in this repository
  // configures it, and a warning on all of them would be a warning nobody reads.
  assert.equal(describePortDrift(0, 51234), undefined)
})

test('no configured port means no comparison', () => {
  // The default lives in `cordis.yml`; restating `8787` in the bin would be a
  // second copy of one constant.
  assert.equal(describePortDrift(undefined, 8787), undefined)
  assert.equal(describePortDrift(8787, undefined), undefined)
})

test('a port that was honoured says nothing', () => {
  assert.equal(describePortDrift(8787, 8787), undefined)
})

test('an EADDRINUSE boot failure becomes one sentence naming the address and the two ways out', () => {
  // The wrapper shape measured 2026-09-11 against `apps/iris/cordis.yml`: the
  // outer error carries no `code` at all, and only its message names the cause.
  const wrapped = new Error(
    'iris: plugin tree failed to load: failed to apply loader entry include (cordis:include): '
    + 'failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): '
    + 'listen EADDRINUSE: address already in use 127.0.0.1:8787',
  )
  const line = describePortInUse(wrapped)
  assert.ok(line !== undefined, 'the taken-port failure must not reach the person as a stack trace')
  assert.ok(line.includes('127.0.0.1:8787'), line)
  assert.ok(line.includes('IRIS_PORT'), line)
  assert.ok(line.includes('data directory'), `it must not be confused with the lock's refusal: ${line}`)
})

test('the cause chain is walked, and a code alone is enough', () => {
  const inner = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8790'), { code: 'EADDRINUSE' })
  const outer = new Error('boot failed', { cause: new Error('entry failed', { cause: inner }) })
  const line = describePortInUse(outer)
  assert.ok(line?.includes('127.0.0.1:8790'), String(line))
})

test('anything that is not a taken port is left alone', () => {
  assert.equal(describePortInUse(new Error('ENOENT: no such file')), undefined)
  assert.equal(describePortInUse(undefined), undefined)
  assert.equal(describePortInUse('a string'), undefined)
  // A cycle in the cause chain must not hang the bin's error path.
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  ;(a as { cause?: unknown }).cause = b
  assert.equal(describePortInUse(a), undefined)
})
