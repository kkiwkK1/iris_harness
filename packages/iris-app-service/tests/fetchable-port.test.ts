import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import {
  FETCH_BAD_PORTS,
  isFetchBadPort,
  listenOnFetchablePort,
  onFetchablePort,
  type Bound,
} from './support/fetchable-port.ts'

/**
 * The blocked-port guard every test that binds `listen(0)` and then fetches
 * itself now shares.
 *
 * The failure it exists to end is a false red: `fetch` refuses a fixed table of
 * ports before it opens a socket, Windows hands those out for `port: 0`, and the
 * error — `TypeError: fetch failed`, cause `bad port` — names nothing about the
 * cause. It cost this repo a red full-suite run in six, and one serial run.
 *
 * Three questions, because they fail for different reasons and one of them is
 * a tautology on its own:
 *
 * 1. **Does a bind through the helper ever land on a blocked port?** Thirty
 *    draws. On its own this proves little — the helper filters against the very
 *    set the assertion reads, and thirty draws from a 13977-wide range would
 *    likely miss all nineteen blocked ports even with no helper at all — so
 *    each draw is also *fetched*, which is the property the callers need.
 * 2. **Does the retry path work?** (1) cannot ask: it never draws a blocked
 *    port. So a bind that hands out blocked ports on purpose does.
 * 3. **Is the table still what this runtime refuses?** If Node stopped
 *    enforcing the table, every caller's retry would be dead weight and this
 *    file should say so rather than pass quietly.
 */

/** Draws in the loop below. Enough to fail a helper that filters nothing at all. */
const DRAWS = 30

/**
 * The blocked ports an ephemeral allocator can actually hand out: the table's
 * entries at or above 1024.
 *
 * Derived from the runtime rather than copied from the table it checks — every
 * port in 1..11000 was fetched on 127.0.0.1 and exactly these were refused with
 * `bad port` above 1023 (Node v24.13.0, 2026-09-07). The sub-1024 entries are
 * real and stay in the table, but no allocator offers them, so this is the
 * subset that decides whether a bind can go wrong.
 *
 * It is pinned so that an emptied or trimmed table cannot pass the check below
 * vacuously: a loop over an empty set reports "nothing was allowed", which is
 * exactly what a correct table reports. If a spec revision adds a blocked port
 * above 1023, this fails — and failing is how anyone finds out that the table
 * needs re-reading.
 */
const DRAWABLE = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]

test('every ephemeral bind through the helper answers a fetch', async () => {
  let fetched = 0
  const ports: number[] = []
  for (let draw = 0; draw < DRAWS; draw += 1) {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
      response.end('reachable')
    })
    try {
      const port = await listenOnFetchablePort(server)
      ports.push(port)
      assert.equal(isFetchBadPort(port), false, `the helper settled on blocked port ${String(port)}`)

      // The assertion that is not circular: the callers do not need "a port not
      // in a set", they need one `fetch` will dial.
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'reachable')
      fetched += 1
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  }

  // The count is asserted because the loop above could have exited early on a
  // `break` that a later edit introduces, and "no assertion failed" and "no
  // iteration ran" are the same output.
  assert.equal(fetched, DRAWS, `only ${String(fetched)} of ${String(DRAWS)} draws were actually fetched`)
  assert.equal(new Set(ports).size, DRAWS, 'the same port was handed out twice; the draws are not independent')
})

test('a blocked draw is released and drawn again, not returned', async () => {
  // 1723 (pptp) and 6667 (irc) are both on the table and both inside Windows'
  // default dynamic range, so this is the sequence a real allocator can produce.
  const drawn = [1723, 6667, 41234]
  const released: number[] = []
  let calls = 0

  const { value, port } = await onFetchablePort<string>(async () => {
    const claimed = drawn[calls] as number
    calls += 1
    const bound: Bound<string> = {
      value: `server-on-${String(claimed)}`,
      port: claimed,
      release: () => { released.push(claimed) },
    }
    return bound
  })

  assert.equal(port, 41234, 'the first fetchable draw is the one returned')
  assert.equal(value, 'server-on-41234', 'the value returned belongs to the accepted draw')
  // Both rejected binds were given back. A helper that retried without
  // releasing would leak a listener per blocked draw, and on a loaded machine
  // that is a port exhaustion nobody would trace back to here.
  assert.deepEqual(released, [1723, 6667])
  assert.equal(calls, 3)
})

test('an allocator that only offers blocked ports fails by name', async () => {
  // Not a hang and not a silent fetch failure somewhere downstream: the helper
  // is the only place that knows what went wrong, so it is the place that says
  // it, with the ports it drew.
  await assert.rejects(
    () => onFetchablePort<null>(async () => ({ value: null, port: 6666, release: () => {} })),
    /not luck: 6666/u,
  )
})

test('this runtime still refuses every port in the table, and nothing else here', async () => {
  /*
   * The premise under the whole helper, re-measured every run.
   *
   * If a future Node stops enforcing the table, the retries above become dead
   * weight — and nothing would go red, because a helper that never needs to
   * retry passes every other test in this file. So the table is checked against
   * the runtime rather than trusted: transcribed from WHATWG Fetch's `bad ports`
   * table, and confirmed here.
   *
   * `AbortSignal.timeout` matters: a refused port fails before any socket
   * opens, but if the refusal stopped happening, some of these (135 and 139 on
   * a Windows box) have a real service behind them that would hold the request
   * open. A timeout turns that into this test failing rather than the file
   * hanging.
   */
  assert.deepEqual(
    [...FETCH_BAD_PORTS].filter(port => port >= 1024).sort((left, right) => left - right),
    DRAWABLE,
    'the table no longer holds exactly the blocked ports an allocator can draw',
  )

  const allowed: number[] = []
  let checked = 0
  for (const port of FETCH_BAD_PORTS) {
    checked += 1
    let cause = ''
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(2000) })
      await response.arrayBuffer().catch(() => undefined)
    } catch (error: unknown) {
      const inner = (error as { cause?: { message?: string } }).cause
      cause = inner?.message ?? (error as Error).message
    }
    if (!/bad port/iu.test(cause)) allowed.push(port)
  }
  assert.equal(checked, FETCH_BAD_PORTS.size, 'the loop did not reach every entry in the table')
  assert.deepEqual(
    allowed,
    [],
    'these ports are on the blocked table but this runtime did not refuse them; '
    + 'either the table has drifted or fetch no longer enforces it, and the retry logic is then unnecessary',
  )

  // The caliper: the check above must be able to say "not refused". 1724 sits
  // one past a blocked port and is not itself on the table, so whatever answers
  // there — nothing, or someone's server — it must not report `bad port`.
  let controlCause = ''
  try {
    const response = await fetch('http://127.0.0.1:1724/', { signal: AbortSignal.timeout(2000) })
    await response.arrayBuffer().catch(() => undefined)
  } catch (error: unknown) {
    const inner = (error as { cause?: { message?: string } }).cause
    controlCause = inner?.message ?? (error as Error).message
  }
  assert.equal(
    /bad port/iu.test(controlCause),
    false,
    `port 1724 is not on the table but was refused as one (${controlCause})`,
  )
  assert.equal(FETCH_BAD_PORTS.has(1724), false, 'the control port joined the table; pick another')
})
