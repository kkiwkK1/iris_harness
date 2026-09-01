/**
 * One host event, one snapshot fetch — however many interfaces are on screen.
 *
 * @module iris-web/tests/snapshot-sharing
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { snapshotFor } from '../src/app/shared-snapshot.ts'

/** Counts the calls a set of rows makes, and answers them all the same way. */
function reader(): { read: () => Promise<never>, calls: () => number } {
  let calls = 0
  return {
    read: async () => {
      calls += 1
      return undefined as never
    },
    calls: () => calls,
  }
}

test('every row watching the same event shares one fetch', async () => {
  /*
   * Each displayed interface has its own subscription, and the host hands the
   * same event to all of them. Without sharing, a conversation showing eight
   * interfaces makes eight identical round trips per event — and a card with
   * several blocks multiplies that again.
   */
  const host = reader()
  const event = { type: 'chat.updated' }

  await Promise.all([
    snapshotFor(event, host.read),
    snapshotFor(event, host.read),
    snapshotFor(event, host.read),
  ])

  assert.equal(host.calls(), 1, 'one event asked the host more than once')
})

test('a later event fetches again', async () => {
  /*
   * The direction that makes the sharing safe to have. If a new event reused
   * the previous fetch, every interface would redraw the first snapshot
   * forever — the exact staleness this mechanism exists to end.
   */
  const host = reader()
  await snapshotFor({ type: 'chat.updated' }, host.read)
  await snapshotFor({ type: 'stream.end' }, host.read)

  assert.equal(host.calls(), 2, 'a second event reused the first answer')
})

test('identity is the key, not shape', async () => {
  /*
   * Two events can look identical — two edits to the same floor produce equal
   * objects — and they are still two occasions. Keying on the object the host
   * actually dispatched makes that distinction free.
   */
  const host = reader()
  await snapshotFor({ type: 'chat.updated', chatId: 'c' }, host.read)
  await snapshotFor({ type: 'chat.updated', chatId: 'c' }, host.read)

  assert.equal(host.calls(), 2, 'two separate events were collapsed because they looked alike')
})
