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

test('useProbability is written true when absent, and verbatim when sent', () => {
  // Benign, unlike the constant trap — reading resolves the flag away, so the
  // effective probability survives a round trip even though the stored flag
  // does not. Pinned so that "this looks wrong" is answered by a test rather
  // than by a change. Since the view began reporting the raw flag, a caller
  // putting a stored book back may also send `false` explicitly; only the
  // *absent* case is upstream's `true`.
  assert.equal(fromWorldbookEntry({ uid: 1 }, 0)['useProbability'], true)
  assert.equal(fromWorldbookEntry({ uid: 1, probability: 25 }, 0)['probability'], 25)
  assert.equal(fromWorldbookEntry({ uid: 1, useProbability: false }, 0)['useProbability'], false)
})

test('the stored shape’s remaining fields survive a whole-book save', async () => {
  // The reason the write shape grew these fields: before it did, a whole-book
  // save — the editor's one write — rebuilt every row from a field list that
  // could not name them, and an automation binding or a budget exemption was
  // dropped by the very act of saving the book it lived in.
  const { store } = await bookWith([entryFile(1, 'seed', {
    automationId: 'my_quick_reply',
    useGroupScoring: true,
    ignoreBudget: true,
    triggers: ['swipe', 'continue'],
    characterFilter: { isExclude: true, names: ['Eldoria'], tags: ['nst'] },
  })])

  const [written] = await store.replace('Eldoria', [{
    uid: 1,
    name: 'seed',
    strategy: { type: 'selective', keys: ['tower'] },
    automationId: 'my_quick_reply',
    useGroupScoring: true,
    ignoreBudget: true,
    useProbability: false,
    probability: 40,
    triggers: ['swipe', 'continue'],
    characterFilter: { isExclude: true, names: ['Eldoria'], tags: ['nst'] },
  }])
  assert.ok(written)
  assert.equal(written.automationId, 'my_quick_reply')
  assert.equal(written.useGroupScoring, true)
  assert.equal(written.ignoreBudget, true)
  assert.equal(written.useProbability, false)
  assert.deepEqual(written.triggers, ['swipe', 'continue'])
  assert.deepEqual(written.characterFilter, { isExclude: true, names: ['Eldoria'], tags: ['nst'] })

  // And from the file, not from the return value.
  const [reread] = await store.get('Eldoria')
  assert.ok(reread)
  assert.equal(reread.automationId, 'my_quick_reply')
  assert.equal(reread.useProbability, false)
  assert.deepEqual(reread.characterFilter, { isExclude: true, names: ['Eldoria'], tags: ['nst'] })
})

test('a caller that never heard of the new fields writes the old row', () => {
  // The defaults are the ones the read side resolves an absent field to, so
  // pre-existing callers are unmoved by the extension.
  const row = fromWorldbookEntry({ uid: 1 }, 0)
  assert.equal(row['automationId'], '')
  assert.equal(row['useGroupScoring'], null)
  assert.equal(row['ignoreBudget'], false)
  assert.equal(row['useProbability'], true)
  assert.deepEqual(row['triggers'], [])
  assert.deepEqual(row['characterFilter'], { isExclude: false, names: [], tags: [] })
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

test('regex-shaped keys survive the disk leg byte for byte', async () => {
  // The other half of a round trip whose frame half f7 pinned. A card's key can
  // make three crossings — host → frame (revived to `RegExp`), frame → host
  // (flattened back to `/pattern/flags`), and host → disk → host, which is this
  // one. Each leg can fail in a way that reads as correct on its own: the
  // parser unescapes a delimiter, `RegExp.prototype.source` re-escapes it, and
  // the two cancel, so inspecting either end alone proves nothing.
  //
  // The host's job here is to be **transparent** — it stores what it was handed
  // and returns what it stored, never parsing or re-serializing a key. Asserted
  // as exact equality rather than as "still a valid regex", because a leg that
  // adds or drops one backslash still yields a valid regex.
  // `ESCAPED` is built from a char code rather than written as a literal. The
  // first version of this line was written through a shell heredoc, where the
  // backslash collapsed: `'/a\\/b/'` became `'/a\/b/'`, which JavaScript reads
  // as `/a/b/` — a key with no escape in it at all. The test still passed, and
  // a teeth-check run specifically to catch this could not, because the damage
  // was in the fixture rather than in the code under test. A mutation that
  // corrupts escaped delimiters had nothing to corrupt.
  const BACKSLASH = String.fromCharCode(92)
  const ESCAPED = `/a${BACKSLASH}/b/`
  const keys = [ESCAPED, '/gr[ae]y/i', 'plain text', 'not/a/regex', '/(?<name>x)/u']

  // DO NOT DELETE THESE TWO LINES AS REDUNDANT. They are the only thing in this
  // test that notices a degraded fixture. Measured, by replacing `ESCAPED` with
  // a bare `/a/b/` and running the file:
  //
  //     these two assertions ......................... RED
  //     the byte-exact deepEqual over five keys ...... green
  //     the same, re-read from disk .................. green
  //
  // Delete them and the test still passes, still reads as the strictest thing
  // here, and tests nothing about escaped delimiters at all.
  //
  // That is not a weakness in those assertions, it is structural. A round trip
  // asserts "what went in came out"; a plain-text key satisfies that perfectly.
  // Degrading the fixture changes *what went in*, which is the one thing a
  // round trip cannot see. So the strictest check in this file — a byte-exact
  // `deepEqual` — has exactly zero resistance to this failure, while looking
  // like the most rigorous thing here.
  //
  // Hence: guard the **identity** of the input (is this the string I think it
  // is), never its behaviour (does it survive the trip). Checked by character
  // code rather than by length, because six characters is a property several
  // wrong strings also have.
  assert.equal(ESCAPED.length, 6, 'the escaped-delimiter fixture lost its backslash again')
  assert.equal(ESCAPED.charCodeAt(2), 92, 'the third character must be a backslash, or this is just /a/b/')
  const { store } = await bookWith([entryFile(1, 'seed')])

  const [written] = await store.replace('Eldoria', [{
    uid: 1,
    name: 'Keys',
    strategy: { type: 'selective', keys, keys_secondary: { logic: 'and_any', keys } },
  }])
  assert.ok(written)
  assert.deepEqual(written.strategy.keys, keys, 'a key changed on the way to disk')
  assert.deepEqual(written.strategy.keys_secondary.keys, keys, 'a secondary key changed')

  // Re-read through the ordinary path, so the assertion covers the file rather
  // than the value `replace` happened to return.
  const [reread] = await store.get('Eldoria')
  assert.deepEqual(reread?.strategy.keys, keys)
  assert.deepEqual(reread?.strategy.keys_secondary.keys, keys)
})
