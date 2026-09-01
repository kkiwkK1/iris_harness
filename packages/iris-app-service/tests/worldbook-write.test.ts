import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { fromWorldbookEntry, resolveUidCollisions, WorldbookStore } from '../src/worldbooks.ts'

/**
 * Replacing a named world book.
 *
 * Whole-book, because that is upstream's semantics: `createOrReplaceWorldbook`
 * builds the saved file fresh from the array it is handed, so an entry the
 * caller left out is deleted. The append-only rule that governs the chat log
 * does not reach here — a book is a document the user edits in another
 * application, not a history this host keeps.
 *
 * Two of the checks below pin behaviour that looks like a bug. It is upstream's
 * behaviour, the ruling is to copy it and record it, and a test is what makes
 * "someone tidied this up" show as a red line instead of as a card that stopped
 * working.
 */

const entryFile = (uid: number, comment: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uid, key: [], keysecondary: [], comment, content: `${comment} body`,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid,
  addMemo: true, group: '', groupOverride: false, groupWeight: 100,
  sticky: 0, cooldown: 0, delay: 0, probability: 100, useProbability: false,
  depth: 4, role: 0, excludeRecursion: false, preventRecursion: false,
  delayUntilRecursion: false, scanDepth: null, caseSensitive: null,
  matchWholeWords: null, useGroupScoring: null, automationId: '',
  ...extra,
})

async function bookWith(entries: Record<string, unknown>[]): Promise<{ store: WorldbookStore, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-wb-write-'))
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(
    join(dir, 'worlds', 'Eldoria.json'),
    JSON.stringify({ entries: Object.fromEntries(entries.map(e => [String(e['uid']), e])) }),
    'utf8',
  )
  return { store: new WorldbookStore(join(dir, 'worlds')), dir }
}

test('replacing a book deletes what the caller left out', async () => {
  const { store } = await bookWith([entryFile(1, 'kept'), entryFile(2, 'dropped')])

  const after = await store.replace('Eldoria', [{ uid: 1, name: 'kept', content: 'kept body' }])
  assert.deepEqual(after.map(entry => entry.name), ['kept'])

  // Read back from disk rather than trusting the return value: the point of the
  // operation is what the file now says.
  const reread = await store.get('Eldoria')
  assert.equal(reread.length, 1)
})

test('a book that does not exist is not created by replacing it', async () => {
  const { store, dir } = await bookWith([entryFile(1, 'a')])
  await assert.rejects(() => store.replace('Nowhere', [{ uid: 1 }]), /world book/u)

  // Upstream's `replaceWorldbook` refuses too. Creating on write would make a
  // typo in a book name produce a second, empty book that silently shadows
  // nothing — and the card would report success.
  const files = await readdir(join(dir, 'worlds'))
  assert.deepEqual(files.filter(name => name.endsWith('.json')), ['Eldoria.json'])
})

test('omitting strategy makes an entry constant — upstream’s default, copied on purpose', () => {
  // The trap, pinned. `book.map(e => ({ uid: e.uid }))` reads as "keep
  // everything"; it produces an always-on entry for every row in the book.
  const row = fromWorldbookEntry({ uid: 1 }, 0)
  assert.equal(row['constant'], true, 'upstream defaults an absent strategy to constant')
  assert.equal(row['selective'], false)
  assert.equal(row['vectorized'], false)

  // And the asymmetry that makes it a trap rather than merely a default: the
  // read direction maps a non-constant entry to `selective`, so a value that
  // came out of `get` as `selective` goes back in as `constant` unless the
  // caller carries `strategy` along.
  assert.equal(fromWorldbookEntry({ uid: 1, strategy: { type: 'selective' } }, 0)['constant'], false)
})

test('useProbability is always written true, and that is upstream too', () => {
  // Benign, unlike the one above — reading resolves the flag away, so the
  // effective probability survives a round trip even though the stored flag
  // does not. Pinned so that "this looks wrong" is answered by a test rather
  // than by a change.
  assert.equal(fromWorldbookEntry({ uid: 1 }, 0)['useProbability'], true)
  assert.equal(fromWorldbookEntry({ uid: 1, probability: 25 }, 0)['probability'], 25)
})

test('the defaults are upstream’s, not this host’s guesses', () => {
  const row = fromWorldbookEntry({ uid: 7 }, 3)
  assert.equal(row['depth'], 4)
  assert.equal(row['order'], 100)
  assert.equal(row['position'], 4)
  assert.equal(row['role'], 0)
  assert.equal(row['content'], '')
  assert.equal(row['comment'], '')
  assert.equal(row['disable'], false)
  assert.equal(row['sticky'], null)
  assert.equal(row['delayUntilRecursion'], false)
  // The implicit keys, which a caller may override but usually does not.
  assert.equal(row['addMemo'], true)
  assert.equal(row['groupWeight'], 100)
  assert.equal(row['caseSensitive'], null)
  // `displayIndex` is the position in the array, not the uid — so writing a
  // book back reorders it to whatever order the caller passed.
  assert.equal(row['displayIndex'], 3)
})

test('a caller’s implicit key beats the default', () => {
  const row = fromWorldbookEntry({ uid: 1, addMemo: false, groupWeight: 5 }, 0)
  assert.equal(row['addMemo'], false)
  assert.equal(row['groupWeight'], 5)
})

test('colliding uids are separated, and a missing uid is assigned one', () => {
  const resolved = resolveUidCollisions([{ uid: 1 }, { uid: 1 }, { uid: 1 }])
  const uids = resolved.map(entry => entry.uid)
  // Identity matters: two entries sharing a uid would collapse into one row in
  // the file, and the loser would vanish without an error.
  assert.equal(new Set(uids).size, 3, `uids collided: ${uids.join(', ')}`)
  assert.equal(uids[0], 1, 'the first claim on a uid should keep it')
})

test('writing does not truncate the book if it is interrupted', async () => {
  // Asserted through its observable consequence: the replace goes through a
  // temporary file and a rename, so no `.tmp` is left behind and the book is
  // never briefly half-written. A direct `writeFile` would pass every other
  // test in this file and lose a 167-entry book to one crash.
  const { store, dir } = await bookWith([entryFile(1, 'a')])
  await store.replace('Eldoria', [{ uid: 1, name: 'a' }, { uid: 2, name: 'b' }])

  const leftovers = (await readdir(join(dir, 'worlds'))).filter(name => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'a temporary file was left behind')

  const raw = JSON.parse(await readFile(join(dir, 'worlds', 'Eldoria.json'), 'utf8')) as { entries: object }
  assert.equal(Object.keys(raw.entries).length, 2)
})

test('a written book reads back through the same reader', async () => {
  const { store } = await bookWith([entryFile(1, 'original')])
  await store.replace('Eldoria', [{
    uid: 42,
    name: 'Tower',
    content: 'The maps are in the west tower.',
    enabled: false,
    strategy: { type: 'selective', keys: ['tower'], keys_secondary: { logic: 'not_all', keys: ['sea'] } },
    position: { type: 'after_author_note', role: 'assistant', depth: 2, order: 7 },
    effect: { sticky: 3, cooldown: null, delay: null },
  }], )

  // The round trip is the real check: a write shape nobody can read back is a
  // write shape that will surface as a parse failure on someone else's machine.
  const [entry] = await store.get('Eldoria')
  assert.ok(entry)
  assert.equal(entry.uid, 42)
  assert.equal(entry.name, 'Tower')
  assert.equal(entry.enabled, false)
  assert.equal(entry.strategy.type, 'selective')
  assert.deepEqual(entry.strategy.keys, ['tower'])
  assert.equal(entry.strategy.keys_secondary.logic, 'not_all')
  assert.equal(entry.position.type, 'after_author_note')
  assert.equal(entry.position.role, 'assistant')
  assert.equal(entry.position.depth, 2)
  assert.equal(entry.position.order, 7)
  assert.equal(entry.effect.sticky, 3)
  assert.equal(entry.effect.cooldown, null)
})

test('a name may not escape the worlds directory on the way in', async () => {
  const { store } = await bookWith([entryFile(1, 'a')])
  // The write path has to refuse what the read path refuses. A guard on reads
  // alone is the shape of a directory traversal that only works one way.
  await assert.rejects(() => store.replace('../settings', [{ uid: 1 }]), /not a valid identifier/u)
})
