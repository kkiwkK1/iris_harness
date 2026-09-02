/**
 * The storage a frame has to invent, and the shapes real cards reach it by.
 *
 * @module iris-web/tests/card-storage
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STORAGE_QUOTA_BYTES,
  createCardStorage,
  describeBytes,
  storageBytes,
} from '../src/sandbox/card-storage.ts'

/** A facade over a store a test can inspect, with the host's answers stubbed. */
function facade(seed: Record<string, string> = {}, options?: {
  writeFails?: string
  clearFails?: boolean
}) {
  let snapshot = { ...seed }
  const writes: { key: string, value: string }[] = []
  const removals: string[] = []
  const reports: { message: string, failed: boolean }[] = []
  let clears = 0

  const storage = createCardStorage({
    snapshot: () => snapshot,
    write: async (key, value) => {
      writes.push({ key, value })
      if (options?.writeFails !== undefined) throw new Error(options.writeFails)
      // The host's own store moves too, which is what makes a later snapshot
      // agree with the overlay rather than fighting it.
      snapshot = { ...snapshot, [key]: value }
    },
    remove: async key => {
      removals.push(key)
      const { [key]: _gone, ...rest } = snapshot
      snapshot = rest
    },
    clear: async () => {
      clears += 1
      if (options?.clearFails === true) throw new Error('refused')
      const removed = Object.keys(snapshot).length
      snapshot = {}
      return { removed, foreign: 2 }
    },
    report: (message, failed) => reports.push({ message, failed }),
  })

  return {
    storage,
    writes,
    removals,
    reports,
    clears: () => clears,
    snapshot: () => snapshot,
  }
}

/** Wait for the write-through promises to settle. */
const settled = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

test('both spellings answer, because the corpus uses both', () => {
  /*
   * 44's four bare startup points are **property** accesses
   * (`localStorage.x` at module top level), and the rest of the corpus uses
   * `getItem`/`setItem`. A plain object with the methods would serve half of
   * them and silently answer `undefined` to the other half — which is the shape
   * of failure this file exists to prevent, since a card reading `undefined`
   * takes its first-run path and overwrites whatever was there.
   */
  const { storage } = facade({ wallpaper: 'data:abc', theme: 'dark' })

  assert.equal(storage.getItem('wallpaper'), 'data:abc')
  assert.equal((storage as Record<string, unknown>)['wallpaper'], 'data:abc')
  assert.equal(storage.length, 2)
  assert.equal(storage.getItem('nothing'), null)
})

test('a missing key is null through getItem and undefined through a property', () => {
  /*
   * The difference looks like a detail and decides two real guard shapes: a
   * card writing `localStorage.x || fallback` cannot tell, but one writing
   * `localStorage.x === null` or `'x' in localStorage` can, and a real `Storage`
   * answers exactly this way.
   */
  const { storage } = facade()
  assert.equal(storage.getItem('absent'), null)
  assert.equal((storage as Record<string, unknown>)['absent'], undefined)
  assert.equal('absent' in storage, false)
  assert.equal('getItem' in storage, true)
})

test('a write is visible to the next read in the same frame', async () => {
  /*
   * **The overlay's whole reason.** The snapshot is whatever the host last sent;
   * a write goes to the host asynchronously, so without a local overlay
   * "write then read" fails *inside one frame* — the card stores a value and
   * immediately cannot find it, which no card checks for because it cannot
   * happen upstream.
   */
  const { storage, writes } = facade()

  storage.setItem('k', 'v')
  assert.equal(storage.getItem('k'), 'v', 'the write was not visible to the next read')
  assert.equal((storage as Record<string, unknown>)['k'], 'v')

  await settled()
  assert.deepEqual(writes, [{ key: 'k', value: 'v' }])
})

test('property assignment and delete go through the same path as the methods', async () => {
  const { storage, writes, removals } = facade({ old: '1' })
  const bag = storage as Record<string, unknown>

  bag['wallpaper'] = 'data:xyz'
  assert.equal(storage.getItem('wallpaper'), 'data:xyz')

  delete bag['old']
  assert.equal(storage.getItem('old'), null)

  await settled()
  assert.deepEqual(writes, [{ key: 'wallpaper', value: 'data:xyz' }])
  assert.deepEqual(removals, ['old'])
})

test('values are coerced to strings, as a real Storage coerces them', async () => {
  const { storage, writes } = facade()
  const bag = storage as Record<string, unknown>

  storage.setItem('n', 7 as unknown as string)
  bag['o'] = { toString: () => 'stringified' }

  await settled()
  assert.deepEqual(writes.map(write => write.value), ['7', 'stringified'])
})

test('length is a live count that a stored key cannot shadow', () => {
  // Same as a real `Storage`: `length` is the count, not an entry, so a card
  // storing something under that name does not break every other card's loop.
  const { storage } = facade({ a: '1' })
  storage.setItem('length', 'not a number')
  assert.equal(storage.length, 2)
  assert.equal(storage.getItem('length'), 'not a number')
})

test('assigning over a method is refused rather than honoured', () => {
  /*
   * The one deliberate divergence from a real `Storage`, which lets
   * `localStorage.getItem = 1` shadow the method. Copying that would let one
   * card's typo disable storage for **every script in the frame**, and nothing
   * measured relies on it — a compatibility detail traded for a failure mode
   * that would be very hard to read.
   */
  const { storage, reports } = facade()
  const bag = storage as Record<string, unknown>

  bag['getItem'] = 1
  assert.equal(typeof storage.getItem, 'function')
  assert.equal(reports.length, 1)
  assert.match(reports[0]?.message ?? '', /part of the storage API/)
  assert.equal(reports[0]?.failed, false, 'an ignored assignment is not a failure')
})

test('a host that refuses a write reports it and keeps the value in this frame', async () => {
  /*
   * The overlay is **not** rolled back. The card was told the write succeeded
   * and has moved on; taking the value away afterwards would make a later read
   * disagree with what the card believes it stored, which is harder to reason
   * about than a value that is durable here and absent on the next load. The
   * report is what says which it is — and it says so in those terms.
   */
  const { storage, reports } = facade({}, { writeFails: 'disk is read-only' })

  storage.setItem('k', 'v')
  await settled()

  assert.equal(storage.getItem('k'), 'v', 'the value vanished from under the card')
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.failed, true)
  assert.match(reports[0]?.message ?? '', /disk is read-only/)
  assert.match(reports[0]?.message ?? '', /gone when this chat is opened again/)
})

test('clear names what it wiped before the host answers', async () => {
  /*
   * **The report is the only channel that can tell a user what a card wiped.**
   * The store is profile-wide, so `clear()` takes other cards' keys with it, and
   * upstream wipes them with no way to attribute the loss. So the naming happens
   * immediately — before the host has answered — and the host's `foreign` count
   * amends it.
   */
  const { storage, reports, clears } = facade({ mine: '1', theirs: '2', third: '3' })

  storage.clear()
  assert.equal(storage.length, 0)
  assert.equal(storage.getItem('mine'), null)

  assert.equal(reports.length, 1, 'the wipe was not named until the host answered')
  assert.match(reports[0]?.message ?? '', /mine, theirs, third/)
  assert.match(reports[0]?.message ?? '', /shared across every card/)

  await settled()
  assert.equal(clears(), 1)
  assert.equal(reports.length, 2)
  assert.match(reports[1]?.message ?? '', /2 of which another card had written/)
})

test('a quota refusal throws the shape the browser throws', () => {
  /*
   * Measured, not recalled. Filling this app's own dev origin, a real `setItem`
   * refusal reads `constructor.name` / `name` `QuotaExceededError`, `code` 22,
   * and `instanceof DOMException`. Under `node --test` there is neither a
   * `QuotaExceededError` interface nor a `DOMException`, so what this can pin
   * here is the `name` — which is the field a consumer would check, and the one
   * the fallback sets explicitly rather than inheriting.
   */
  const filler = 'x'.repeat(STORAGE_QUOTA_BYTES / 2)
  const { storage, writes } = facade({ big: filler })

  let thrown: unknown
  try {
    storage.setItem('another', filler)
  } catch (error: unknown) {
    thrown = error
  }

  assert.notEqual(thrown, undefined, 'the write was accepted past the quota')
  assert.equal((thrown as Error).name, 'QuotaExceededError')
  assert.equal(writes.length, 0, 'a refused write must not reach the host')
  assert.equal(storage.getItem('another'), null, 'a refused write must not be visible either')
})

test('a quota refusal is reported as a failure, naming the key and the sizes', () => {
  /*
   * **The report has to outrank the card's own success message.** The one card
   * that can reach the quota wraps its write in an empty `catch` and then
   * unconditionally toasts "已设为壁纸", having already changed the DOM — so the
   * exception alone changes nothing a reader sees, and they believe the wallpaper
   * was saved until a later load silently shows the old one.
   */
  const filler = 'x'.repeat(STORAGE_QUOTA_BYTES / 2)
  const { storage, reports } = facade({ big: filler })

  assert.throws(() => storage.setItem('moshen-phone-wallpaper', filler))
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.failed, true, 'a refused write is a failure, not a note')
  assert.match(reports[0]?.message ?? '', /moshen-phone-wallpaper/)
  assert.match(reports[0]?.message ?? '', /MB/, 'the sizes must be readable, not raw bytes')
  assert.match(reports[0]?.message ?? '', /shared across every card/)
})

test('the quota is a property of the write, not a state the store enters', () => {
  /*
   * Measured: with the origin otherwise full, a one-character write still
   * succeeds. So "over the line" is decided per write. Two consequences are
   * pinned here — a small write is not collateral damage, and a card that frees
   * space by **overwriting** a large key with a small one is not left refused,
   * which a naive "current size + new value" check would get wrong.
   */
  const filler = 'x'.repeat(STORAGE_QUOTA_BYTES / 2 - 100)
  const { storage } = facade({ big: filler })

  assert.doesNotThrow(() => storage.setItem('tiny', 'a'))
  assert.doesNotThrow(
    () => storage.setItem('big', 'small now'),
    'overwriting a large key was charged for the value it replaces',
  )
  assert.equal(storage.getItem('big'), 'small now')
})

test('keys count toward the quota, not only values', () => {
  // The browser charges for both, and 44 found every one of these cards
  // generating key names at runtime — a card can spend real space on names.
  assert.equal(storageBytes({ ab: 'cd' }), 8)
  assert.equal(storageBytes({}), 0)
})

test('sizes are reported in units a reader can act on', () => {
  // "2411724 bytes were not written" is a number a reader has to convert before
  // it means anything, and these reports are about megabytes.
  assert.equal(describeBytes(2 * 1024 * 1024), '2.0 MB')
  assert.equal(describeBytes(4096), '4 KB')
  assert.equal(describeBytes(12), '12 bytes')
})

test('the store a card sees is the snapshot with its own changes applied', async () => {
  // Both directions of the merge: a host key it has not touched stays visible,
  // and a key it removed stops being visible even while the snapshot has it.
  const { storage } = facade({ fromHost: '1', doomed: '2' })

  storage.removeItem('doomed')
  storage.setItem('mine', '3')

  assert.deepEqual(Object.keys(storage).sort(), ['fromHost', 'mine'])
  assert.equal(storage.getItem('doomed'), null)
  await settled()
})

test('key(n) enumerates and answers null past the end', () => {
  const { storage } = facade({ a: '1', b: '2' })
  const seen = [storage.key(0), storage.key(1)].sort()
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(storage.key(2), null)
  assert.equal(storage.key(-1), null)
})
