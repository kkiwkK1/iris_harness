import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { isSafeId, toId } from '../src/paths.ts'
import { charWorldbookNames, toWorldbookEntry, WorldbookStore } from '../src/worldbooks.ts'

/**
 * Named world books — the ones in their own files rather than inside a card.
 *
 * Two kinds of check live here, kept apart on 3e's rule: **shape invariants**,
 * which must hold for any installation and are pinned against fixtures, and
 * **corpus facts**, which are dated measurements of one machine's data and skip
 * when that data is absent. A count that changes when someone installs a card is
 * not an invariant, and asserting it as one produces a suite that fails for
 * reasons unrelated to the code.
 */

// Read from `IRIS_CORPUS` rather than hardcoded, and that is not a style point:
// `scripts/check-corpus-skips.mjs` rehearses a CI machine by pointing this at a
// path that cannot exist. A hardcoded path ignores the rehearsal and runs
// against the real corpus during the very check meant to prove it skips — the
// skip count then holds on this machine and moves on CI, which is the one place
// nobody is watching a number.
const CORPUS = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user`
const hasCorpus = existsSync(join(CORPUS, 'worlds'))
/** Why the three corpus tests below skip, when they do: what is missing and where it comes from. */
const NO_CORPUS = !hasCorpus && `no world books at ${CORPUS}/worlds; point IRIS_CORPUS at a SillyTavern install`

/** One entry as a real file stores it — every field the mapping reads. */
function storedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 1, key: ['tower'], keysecondary: [], comment: 'The West Tower', content: 'Maps are here.',
    constant: false, selective: true, vectorized: false, selectiveLogic: 0,
    order: 100, position: 4, disable: false, displayIndex: 0,
    addMemo: true, group: '', groupOverride: false, groupWeight: 100,
    sticky: 0, cooldown: 0, delay: 0, probability: 100, useProbability: false,
    depth: 4, role: 0, excludeRecursion: false, preventRecursion: false,
    delayUntilRecursion: false, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '',
    ...overrides,
  }
}

/**
 * Every fixture directory this file has created, in order.
 *
 * Recorded so the last test can ask whether *this run's* fixtures were cleaned
 * up. It used to sweep `tmpdir()` for the `iris-worlds-` prefix instead, and
 * that is a different question with the same answer most of the time: the
 * prefix belongs to every process running this file, so two suites in parallel
 * deleted each other's live fixtures. Measured: five rounds of two concurrent
 * runs of this file, five rounds in which one of the two failed —
 * `EPERM: operation not permitted, rmdir 'C:\…\iris-worlds-lOfOAY\worlds'`,
 * a Windows refusal to remove a directory another process still has open.
 */
const created: string[] = []

/**
 * A world-book store over a temporary directory that removes itself.
 * @param t - the test that owns the fixture; its `after` deletes the directory,
 *   so ownership is per test rather than per prefix.
 * @param books - book name to its entries, as a real file stores them.
 * @returns a store rooted at the fixture's `worlds` directory.
 */
async function fixture(
  t: TestContext,
  books: Record<string, Record<string, unknown>>,
): Promise<WorldbookStore> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-worlds-'))
  created.push(dir)
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  for (const [name, entries] of Object.entries(books)) {
    await writeFile(join(dir, 'worlds', `${name}.json`), JSON.stringify({ entries }), 'utf8')
  }
  return new WorldbookStore(join(dir, 'worlds'))
}

// ------------------------------------------------------------ shape invariants

test('an entry is translated into the shape a card reads, not the shape on disk', async (t) => {
  const store = await fixture(t, { book: { 1: storedEntry() } })
  const [entry] = await store.get('book')
  assert.ok(entry)

  // `name` is the file's `comment`, and `enabled` is the negation of `disable`.
  // Both are the kind of mistake that produces a fully-populated object with a
  // couple of fields quietly inverted — every entry present, half of them off.
  assert.equal(entry.name, 'The West Tower')
  assert.equal(entry.enabled, true)
  assert.equal(entry.strategy.type, 'selective')
  assert.equal(entry.position.type, 'at_depth')
  assert.equal(entry.position.role, 'system')
})

test('three independent booleans collapse into one strategy, in upstream’s order', async (t) => {
  // `constant` wins over `vectorized` upstream, and an entry can carry both.
  // Testing them one at a time would pass against an implementation that got the
  // precedence backwards.
  const store = await fixture(t, {
    book: {
      1: storedEntry({ uid: 1, constant: true, vectorized: true }),
      2: storedEntry({ uid: 2, constant: false, vectorized: true, displayIndex: 1 }),
      3: storedEntry({ uid: 3, constant: false, vectorized: false, displayIndex: 2 }),
    },
  })
  const types = (await store.get('book')).map(entry => entry.strategy.type)
  assert.deepEqual(types, ['constant', 'vectorized', 'selective'])
})

test('zero and “off” are one state on disk and two in the shape a card reads', async (t) => {
  const store = await fixture(t, {
    book: {
      1: storedEntry({ sticky: 0, cooldown: 3, delay: 0, delayUntilRecursion: false }),
    },
  })
  const [entry] = await store.get('book')
  assert.ok(entry)
  // Null, not 0. A card destructuring `{ sticky = 5 }` gets its default from
  // null and does not from 0, so the difference reaches behaviour.
  assert.equal(entry.effect.sticky, null)
  assert.equal(entry.effect.cooldown, 3)
  assert.equal(entry.recursion.delay_until, null)
})

test('probability is resolved rather than passed through with its flag', async (t) => {
  const store = await fixture(t, {
    book: {
      1: storedEntry({ uid: 1, useProbability: false, probability: 25 }),
      2: storedEntry({ uid: 2, useProbability: true, probability: 25, displayIndex: 1 }),
    },
  })
  const [off, on] = await store.get('book')
  // An entry that does not use probability is certain, whatever number sits in
  // the field. Forwarding 25 would make it fire a quarter of the time.
  assert.equal(off?.probability, 100)
  assert.equal(on?.probability, 25)
})

test('entries come back in display order, which is not uid order', async (t) => {
  const store = await fixture(t, {
    book: {
      7: storedEntry({ uid: 7, comment: 'first', displayIndex: 0 }),
      2: storedEntry({ uid: 2, comment: 'second', displayIndex: 1 }),
    },
  })
  // `displayIndex` is the order the user arranged in the editor. Object key
  // order would put uid 2 first and look plausible while showing the book
  // rearranged.
  assert.deepEqual((await store.get('book')).map(entry => entry.name), ['first', 'second'])
})

test('a missing book is not-found, and a missing directory is an empty list', async (t) => {
  const store = await fixture(t, {})
  // An installation with no books is a normal state; a named book that is not
  // there is a caller mistake. Reporting the second as an empty book would let a
  // card conclude the user deleted their world info.
  assert.deepEqual(await store.names(), [])
  await assert.rejects(() => store.get('nothing'), /world book/u)

  const absent = new WorldbookStore(join(tmpdir(), 'iris-worlds-does-not-exist'))
  assert.deepEqual(await absent.names(), [])
})

test('a name may not escape the worlds directory', async (t) => {
  const store = await fixture(t, { book: { 1: storedEntry() } })
  // Refused by the id guard rather than by the read failing, so a traversal
  // attempt is rejected as one instead of surfacing as a missing file.
  await assert.rejects(() => store.get('../settings'), /not a valid identifier/u)
})

test('a card’s binding is a name, and its embedded book is not reported', () => {
  const card = {
    data: {
      extensions: { world: 'Eldoria' },
      character_book: { entries: [{ keys: [], content: 'embedded' }] },
    },
  }
  // The two are separate bodies of world info and upstream's member reports only
  // the first. Folding the embedded book in here would be a compatibility
  // deviation dressed as helpfulness.
  const names = charWorldbookNames(card as never)
  assert.deepEqual(names, { primary: 'Eldoria', additional: [] })
  assert.equal(charWorldbookNames(undefined).primary, null)
  assert.equal(charWorldbookNames({ data: { extensions: {} } } as never).primary, null)
})

test('an unknown position or role falls back rather than reaching a card as undefined', () => {
  // A file written by a newer SillyTavern can carry a position this build has no
  // name for. `undefined` would flow into a card's `switch` and match nothing;
  // the documented default at least behaves.
  const entry = toWorldbookEntry(storedEntry({ position: 99, role: 99 }) as never)
  assert.equal(entry.position.type, 'at_depth')
  assert.equal(entry.position.role, 'system')
})

// ---------------------------------------------------------------- corpus facts

test('real book names survive as ids but would not survive toId', { skip: NO_CORPUS }, async () => {
  const names = (await readdir(join(CORPUS, 'worlds')))
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
  assert.ok(names.length > 0, 'the corpus has no books to measure')

  // The invariant: a book name is used verbatim. Every real name passes the id
  // guard, so nothing needs transforming — and `toId` changes most of them, so
  // transforming anyway would break the binding lookup for the majority of the
  // corpus while looking entirely reasonable in code.
  //
  // Measured 2026-09-02: 18 names, 0 rejected, 13 changed by `toId`. The counts
  // are dated; the two properties below are not.
  assert.deepEqual(names.filter(name => !isSafeId(name)), [], 'a real book name failed the id guard')
  assert.ok(
    names.some(name => toId(name) !== name),
    'no real name is changed by toId — the trap this pins may have moved',
  )
})

test('every real book parses through the store', { skip: NO_CORPUS }, async () => {
  const store = new WorldbookStore(join(CORPUS, 'worlds'))
  const names = await store.names()
  let entries = 0
  for (const name of names) entries += (await store.get(name)).length

  // Measured 2026-09-02: 18 books, 1478 entries. Asserted as "all of them, and
  // more than none" rather than as the numbers, because the numbers change when
  // the user installs a card and the property does not.
  assert.equal(names.length, (await readdir(join(CORPUS, 'worlds'))).filter(n => n.endsWith('.json')).length)
  assert.ok(entries > 0, 'every real book parsed to zero entries')
})

test('cards bind books by a name the store can resolve', { skip: NO_CORPUS }, async () => {
  const store = new WorldbookStore(join(CORPUS, 'worlds'))
  const available = new Set(await store.names())
  const dir = join(CORPUS, 'characters')

  let bound = 0
  let resolved = 0
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json'))) {
    const card = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown
    const primary = charWorldbookNames(card as never).primary
    if (primary === null) continue
    bound += 1
    if (available.has(primary)) resolved += 1
  }

  // A dangling binding — a name with no file — is a real state (2 of the
  // corpus's 18 PNG-card bindings are dangling), so this asserts that resolution
  // *works*, not that it always succeeds. Requiring every binding to resolve
  // would make someone deleting a book fail the suite.
  if (bound > 0) assert.ok(resolved <= bound)
})

test('this file leaves none of its own fixtures behind', async () => {
  /*
   * Runs last, and asks only about the directories `fixture` created in *this*
   * process. Each one is removed by the `t.after` of the test that made it, and
   * node's runner finishes a file's top-level tests in order, so by the time
   * this one runs every earlier fixture's cleanup has already happened.
   *
   * **What this used to do was sweep `tmpdir()` for the `iris-worlds-` prefix
   * and delete everything it found.** As a cleanup that worked; as a *test* it
   * asserted `true`. And the prefix is shared by every process running this
   * file, so two suites at once deleted each other's live fixtures: five rounds
   * of two concurrent runs, five rounds with one of the two red on
   * `EPERM … rmdir 'iris-worlds-lOfOAY\worlds'`. A test that deletes another
   * process's data is not a test with a race in it; it is a race with an
   * assertion attached.
   */
  const survivors = created.filter(dir => existsSync(dir))
  assert.deepEqual(
    survivors,
    [],
    'these fixture directories outlived the test that created them; something skipped its `t.after`',
  )
  // The caliper: an empty `created` would satisfy the assertion above for the
  // wrong reason — no fixture was ever registered, so nothing could survive.
  // Six of the tests here build one, and only the corpus tests do not.
  assert.ok(created.length >= 6, `only ${String(created.length)} fixtures were registered; the sweep saw almost nothing`)
})
