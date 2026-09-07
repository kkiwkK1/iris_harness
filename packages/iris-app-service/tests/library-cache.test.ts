/**
 * A listing decodes a card file once, and knows when that stops being true.
 *
 * `script.context` carries `characters` — upstream's `getContext().characters` —
 * so `CharacterLibrary.list()` runs on every card-script snapshot. Measured on
 * the operator's own profile (13 cards, 50 MB of card PNGs) a listing cost
 * **1737 ms**, of which 28 ms was reading the files: the rest was decoding them
 * to produce 3.2 KiB of summaries. A page showing 22 message rows paid it 22
 * times, in series, because the host is single-threaded.
 *
 * ## Why these tests are shaped like this
 *
 * The cache has no observable of its own — no counter, no event — and adding one
 * for a test would be a second interface to keep true. The only thing a caller
 * can see is *whether the bytes on disk were read*, so each test changes the
 * bytes under a controlled file stamp and asks what the listing says:
 *
 * - bytes corrupted, **stamp preserved** → the card must still be listed. That
 *   can only happen if the file was not read, which is the cache working.
 * - bytes corrupted, **stamp moved** (either half) → the card must disappear.
 *   That can only happen if the file *was* read, which is the freshness the
 *   cache has to keep.
 *
 * So the "stale" reading is not a wish here, it is the instrument. The
 * boundary it measures is documented on `CharacterLibrary.#summaries`: a file
 * rewritten to the same length inside one clock tick by another process is the
 * one case the stamp cannot see, and the library's own writes are covered by
 * forgetting the path rather than by the stamp.
 *
 * Every test pins its own mtime with `utimes` before measuring, so "the same
 * stamp" is an exact equality rather than a hope about filesystem precision.
 *
 * @module @iris/app-service/tests/library-cache
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { CharacterLibrary } from '../src/library.ts'

/** The mtime every fixture is pinned to, so "unchanged" is exact. */
const PINNED = new Date(1_700_000_000_000)

/** A `.json` card body carrying both name spellings, so a rename can be size-neutral. */
function card(name: string): string {
  return JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    name,
    data: { name, description: '', tags: [], creator: '' },
  })
}

/** A one-card library, its file pinned to {@link PINNED}. */
async function fixture(t: TestContext, body: string): Promise<{
  library: CharacterLibrary
  path: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-library-cache-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const characters = join(dir, 'characters')
  await mkdir(characters, { recursive: true })
  const path = join(characters, 'sable.json')
  await writeFile(path, body, 'utf8')
  await utimes(path, PINNED, PINNED)
  return { library: new CharacterLibrary(characters, '/iris/avatar'), path }
}

/** Replace a file's bytes, then put its mtime back where it was. */
async function rewriteKeepingMtime(path: string, body: string): Promise<void> {
  await writeFile(path, body, 'utf8')
  await utimes(path, PINNED, PINNED)
}

/** Unreadable bytes of a chosen length — a card that cannot decode. */
function rubbish(length: number): string {
  return 'x'.repeat(length)
}

test('a listing does not read a card file it has already decoded', async (t) => {
  const body = card('Sable')
  const { library, path } = await fixture(t, body)

  assert.equal((await library.list())[0]?.name, 'Sable', 'the fixture must list before anything is measured')

  // Same length, same mtime, different content — so a listing that reads the
  // file sees rubbish and drops the card, and one that does not still has
  // Sable. The length equality is asserted rather than assumed: a fixture that
  // changed size would make this test pass for the wrong reason.
  await rewriteKeepingMtime(path, rubbish(Buffer.byteLength(body, 'utf8')))
  const after = await stat(path)
  assert.equal(after.size, Buffer.byteLength(body, 'utf8'), 'the corruption must be size-neutral or this proves nothing')
  assert.equal(after.mtimeMs, PINNED.getTime(), 'the corruption must be mtime-neutral or this proves nothing')

  const rows = await library.list()
  assert.equal(rows.length, 1, 'the second listing decoded the file again')
  assert.equal(rows[0]?.name, 'Sable', 'the second listing decoded the file again')
})

test('a card file whose mtime moved is decoded again', async (t) => {
  const body = card('Sable')
  const { library, path } = await fixture(t, body)
  await library.list()

  /*
   * The direction that makes the cache safe to have. Same length as before, so
   * the *only* thing that has changed is the mtime — a cache keyed on the path
   * alone, or on the size alone, would still answer "Sable" here.
   */
  await writeFile(path, rubbish(Buffer.byteLength(body, 'utf8')), 'utf8')
  const moved = new Date(PINNED.getTime() + 5_000)
  await utimes(path, moved, moved)
  assert.equal((await stat(path)).size, Buffer.byteLength(body, 'utf8'), 'only the mtime may differ in this test')

  assert.deepEqual(await library.list(), [], 'a rewritten card was answered from the cache')
})

test('a card file whose size changed is decoded again, even at the same mtime', async (t) => {
  const body = card('Sable')
  const { library, path } = await fixture(t, body)
  await library.list()

  /*
   * The other half of the stamp, and it is not redundant: a write and the
   * `stat` that follows it can land in the same clock tick — Windows stamps
   * file times from the system clock, whose granularity is about 15.6 ms — so
   * the mtime alone is not an identity.
   */
  await rewriteKeepingMtime(path, rubbish(Buffer.byteLength(body, 'utf8') + 40))
  const after = await stat(path)
  assert.equal(after.mtimeMs, PINNED.getTime(), 'only the size may differ in this test')
  assert.notEqual(after.size, Buffer.byteLength(body, 'utf8'), 'the fixture did not actually change size')

  assert.deepEqual(await library.list(), [], 'a resized card was answered from the cache')
})

test('a write through the library is not left to the file stamp to notice', async (t) => {
  /*
   * The case the stamp cannot cover, and therefore the reason `#forget` exists
   * rather than being an optimisation. A rename between two names of the same
   * length rewrites the card to the same number of bytes, and the write plus the
   * next `stat` can share a clock tick — so the stamp can come back *identical*
   * and a cache trusting it would keep serving the old name for the life of the
   * process.
   *
   * The stamp is forced back by hand here rather than raced for, because a race
   * that usually loses is a test that usually passes.
   */
  const body = card('Sable')
  const { library, path } = await fixture(t, body)
  assert.equal((await library.list())[0]?.name, 'Sable')

  await library.rename('sable', 'Amber')
  await utimes(path, PINNED, PINNED)
  const after = await stat(path)
  assert.equal(
    after.size,
    Buffer.byteLength(body, 'utf8'),
    'the rename must be size-neutral, or the stamp would notice it and this test proves nothing',
  )
  assert.equal(after.mtimeMs, PINNED.getTime(), 'the stamp was not put back')

  const rows = await library.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.name, 'Amber', 'the listing served a summary from before the library rewrote the card')
})

test('the summary the cache serves is the one a fresh decode produces', async (t) => {
  /*
   * The cheap mistake this rules out: holding something that is *nearly* the
   * summary — a shape assembled at cache-fill time rather than by `summarize`,
   * or one that lost the fields `refs()` contributes (`updatedAt`). Two
   * listings of an untouched file must agree field for field, and the second
   * one is the cached path by construction.
   */
  const { library } = await fixture(t, card('Sable'))
  const first = await library.list()
  const second = await library.list()
  assert.deepEqual(second, first, 'the cached listing differs from the decoded one')
  assert.equal(first[0]?.updatedAt, PINNED.getTime(), 'the summary lost the file stamp it reports')
})
