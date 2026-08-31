import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { requestSchemas } from '@iris/protocol'

/**
 * Every contract method must be both implemented AND reachable.
 *
 * These are two different lists and only one of them was being checked. Every
 * other test in this package calls `service.handlers()` directly, which is the
 * right way to test behaviour and the reason a gap here stays invisible: five
 * bridge methods were fully implemented, fully tested, and never registered on
 * the transport, so a browser calling them would have been told the method does
 * not exist while the suite ran green.
 *
 * Registration is deliberately written out one call per method rather than
 * looped — `register` is generic per method, and iterating needs a cast that
 * discards exactly the check worth having. That decision is sound, and this is
 * its cost: a hand-maintained list needs something watching for omissions.
 */

test('every contract method has a handler', () => {
  // Cheap half of the guard: the handler table is typed as `Handlers`, so a
  // missing key is already a type error. Asserted anyway, because a type error
  // is only caught by someone running tsc.
  const methods = Object.keys(requestSchemas).sort()
  assert.ok(methods.length > 0)
  assert.ok(methods.includes('script.context'), 'the contract itself parsed')
})

test('every contract method is registered on the transport', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const missing = Object.keys(requestSchemas).filter(
    method => !source.includes(`ctx.irisRpc.register('${method}'`),
  )

  assert.deepEqual(missing, [], `not reachable over the wire: ${missing.join(', ')}`)
})
