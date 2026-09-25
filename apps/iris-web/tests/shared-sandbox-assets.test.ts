/**
 * The interface host's shared asset supply forgets a failure.
 *
 * It used to memoise the promise including a rejection, so one transient
 * manifest failure left every message frame dead until a page reload.
 *
 * @module iris-web/tests/shared-sandbox-assets
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sharedSandboxAssets } from '../src/app/sandbox-assets.ts'

test('a failed manifest fetch is retried by the next caller, and a success is shared', async () => {
  let asked = 0
  let failing = true
  const manifest = JSON.stringify({ bootstrap: 'b.js', members: 'm.js', preset: 'p.js', 'message-preset': 'mp.js' })
  const fetchImpl = (async () => {
    asked += 1
    if (failing) return new Response('down', { status: 503 })
    return new Response(manifest, { status: 200 })
  }) as unknown as typeof fetch

  await assert.rejects(sharedSandboxAssets(fetchImpl), /HTTP 503/)
  // The rejection's own handler runs on a microtask; let it clear the slot.
  await Promise.resolve()
  failing = false
  const first = sharedSandboxAssets(fetchImpl)
  const second = sharedSandboxAssets(fetchImpl)
  assert.equal(first, second, 'concurrent callers did not share one flight')
  assert.equal((await first).messagePreset, '/sandbox/mp.js')
  assert.equal(asked, 2, 'the failure was cached instead of asked again')
  await sharedSandboxAssets(fetchImpl)
  assert.equal(asked, 2, 'a success was not shared')
})
