import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { normalizeCard, type CharacterCard } from '@iris/character'

import { cardWorldbookDigest, WorldbookStore } from '../src/worldbooks.ts'

/**
 * The character page's world book listing: every book a card involves, entry by
 * entry, and **without the text**.
 *
 * Two things are being held here, and they pull in opposite directions.
 *
 * **What is absent has to stay absent.** `content` is the bulk of a book: the
 * local corpus's books come to 841 entries, and the same eleven cards' books
 * cost 23 KB through this shape against 341 KB through `worldbook.get` for the
 * largest one alone. A field added back "for completeness" would put a megabyte
 * on a page open and nothing would go red — so the size is asserted as a
 * property of the payload, not left to a reviewer.
 *
 * **What is present has to be ST's own meaning.** The listing inverts `disable`
 * into `enabled` and flattens `constant` out of the strategy, which are exactly
 * the two fields a second implementation would get backwards
 * (`toWorldbookEntry`'s own header says so). Each is asserted against a stored
 * entry that sets it, in both directions, because a digest that reported every
 * entry as enabled would look perfectly reasonable — 622 of the corpus's 841
 * entries *are*.
 *
 * The resolution itself is not re-tested here: which book is the card's own is
 * `cardWorldbookView`'s answer and `worldbooks.test.ts` owns it. What is tested
 * is that this listing reports the same choice and adds the entries.
 */

/** One entry in the shape a book **file** stores. */
const entryJson = (
  uid: number,
  comment: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  uid,
  key: [`k${String(uid)}`],
  keysecondary: [],
  comment,
  content: `THE-BODY-OF-${comment}`,
  constant: false,
  selective: true,
  vectorized: false,
  selectiveLogic: 0,
  order: 100,
  position: 0,
  depth: 4,
  disable: false,
  displayIndex: uid,
  ...extra,
})

/** A card, optionally binding a book by name and optionally embedding one. */
function cardWith(options: {
  world?: string
  /** The V2 `character_book` shape, which is **not** a book file's shape. */
  embedded?: { entries: Record<string, unknown>[] }
}): CharacterCard {
  return normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: options.world === undefined ? {} : { world: options.world },
      ...options.embedded === undefined ? {} : { character_book: options.embedded },
    },
  })
}

/** A book store over a temp directory, holding the given files. */
async function storeWith(
  t: TestContext,
  books: Record<string, Record<string, unknown>[]>,
): Promise<WorldbookStore> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-digest-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  for (const [name, entries] of Object.entries(books)) {
    await writeFile(
      join(dir, 'worlds', `${name}.json`),
      JSON.stringify({ entries: Object.fromEntries(entries.map((row, index) => [index, row])) }),
      'utf8',
    )
  }
  return new WorldbookStore(join(dir, 'worlds'))
}

test('a named book is listed entry by entry, in the order the book presents them', async (t: TestContext) => {
  const store = await storeWith(t, {
    'Aria’s book': [
      entryJson(0, 'third', { displayIndex: 2 }),
      entryJson(1, 'first', { displayIndex: 0 }),
      entryJson(2, 'second', { displayIndex: 1 }),
    ],
  })

  const books = await cardWorldbookDigest(cardWith({ world: 'Aria’s book' }), store)

  assert.equal(books.length, 1)
  assert.equal(books[0]?.source, 'named')
  assert.equal(books[0]?.role, 'card')
  assert.equal(books[0]?.name, 'Aria’s book')
  // `displayIndex`, not uid: it is the order the reader arranged in the editor,
  // and `WorldbookStore.get` is where that ordering lives.
  assert.deepEqual(books[0]?.entries.map(entry => entry.name), ['first', 'second', 'third'])
})

test('no entry carries its content, and that is the whole size argument', async (t: TestContext) => {
  const store = await storeWith(t, {
    book: Array.from({ length: 40 }, (_unused, index) => entryJson(index, `e${String(index)}`)),
  })

  const books = await cardWorldbookDigest(cardWith({ world: 'book' }), store)
  const payload = JSON.stringify({ books })

  // The bodies are recognisable on purpose: a digest that carried them would be
  // found by name rather than by a byte count that could drift.
  assert.ok(!payload.includes('THE-BODY-OF-'), 'an entry body reached the listing')
  for (const entry of books[0]?.entries ?? []) {
    assert.equal(Object.hasOwn(entry, 'content'), false, 'a digest grew a content field')
  }
  // 40 entries in well under a kilobyte apiece. The real numbers this bound
  // stands in for: 140 entries → 23 KB here against 341 KB through
  // `worldbook.get`, measured on the local corpus's largest card.
  assert.ok(payload.length < 40 * 200, `40 entries cost ${String(payload.length)} bytes`)
})

test('ST’s own fields survive the mapping in both directions', async (t: TestContext) => {
  const store = await storeWith(t, {
    book: [
      entryJson(0, 'plain'),
      entryJson(1, 'switched off', { disable: true }),
      entryJson(2, 'always on', { constant: true, key: [] }),
      entryJson(3, 'deep', { position: 4, depth: 7 }),
      entryJson(4, 'paired', { keysecondary: ['a', 'b'] }),
      entryJson(5, 'in an outlet', { position: 7 }),
    ],
  })

  const entries = (await cardWorldbookDigest(cardWith({ world: 'book' }), store))[0]?.entries ?? []
  const by = (name: string): (typeof entries)[number] => {
    const found = entries.find(entry => entry.name === name)
    assert.ok(found !== undefined, `no entry called ${name}`)
    return found
  }

  // `enabled` is the negation of `disable`, which is the single most invertible
  // field in this mapping — so both values are asserted, not just the odd one.
  assert.equal(by('plain').enabled, true)
  assert.equal(by('switched off').enabled, false)
  assert.equal(by('plain').constant, false)
  assert.equal(by('always on').constant, true)
  // Keys verbatim, and an entry with none reported as having none rather than
  // as having an empty something: 307 of the corpus's 841 entries are keyless.
  assert.deepEqual(by('plain').keys, ['k0'])
  assert.deepEqual(by('always on').keys, [])
  // Secondary keys are omitted when empty and carried when set. The absence is
  // load-bearing: it is paid once per entry on every page open.
  assert.equal(Object.hasOwn(by('plain'), 'keysSecondary'), false)
  assert.deepEqual(by('paired').keysSecondary, ['a', 'b'])
  // Position by ST's number → TavernHelper's name, and `depth` only where the
  // number means anything. Every other position carries the field's default on
  // disk, and reporting it would invent a choice its author never made.
  assert.equal(by('plain').position, 'before_character_definition')
  assert.equal(Object.hasOwn(by('plain'), 'depth'), false)
  assert.equal(by('deep').position, 'at_depth')
  assert.equal(by('deep').depth, 7)
  assert.equal(by('in an outlet').position, 'outlet')
})

test('a card’s embedded book is listed from the card, in the V2 shape it is stored in', async (t: TestContext) => {
  // No store at all: this is a card nobody has opened on this host, which is
  // the state materialisation has not run for yet — and the state that had
  // nothing on screen before this listing existed.
  const card = cardWith({
    world: 'wanted name',
    embedded: {
      entries: [
        { keys: ['ash'], content: 'THE-BODY-OF-ash', comment: 'the ash', enabled: true, insertion_order: 0 },
        { keys: [], content: 'THE-BODY-OF-always', comment: 'always', enabled: false, constant: true, insertion_order: 1 },
      ],
    },
  })

  const books = await cardWorldbookDigest(card, undefined)

  assert.equal(books.length, 1)
  assert.equal(books[0]?.source, 'embedded')
  // The name the card asked for, kept even though no file carries it: "bound to
  // X, and X is not on disk yet" is the state, and blanking it hides the half a
  // reader needs to go looking.
  assert.equal(books[0]?.name, 'wanted name')
  assert.deepEqual(books[0]?.entries.map(entry => entry.name), ['the ash', 'always'])
  assert.deepEqual(books[0]?.entries.map(entry => entry.keys), [['ash'], []])
  assert.equal(books[0]?.entries[1]?.constant, true)
  assert.equal(books[0]?.entries[1]?.enabled, false)
  assert.ok(!JSON.stringify(books).includes('THE-BODY-OF-'), 'an embedded entry body reached the listing')
})

test('a binding with no book behind it is listed as missing, not dropped', async (t: TestContext) => {
  const store = await storeWith(t, { 'someone else’s book': [entryJson(0, 'x')] })

  const books = await cardWorldbookDigest(cardWith({ world: 'gone' }), store)

  // 2 of the corpus's 18 bindings are in this state. Listing it is the point: a
  // bound name that activates nothing is otherwise indistinguishable from a
  // book with no entries, and only one of those is a broken card.
  assert.deepEqual(books, [{ name: 'gone', source: 'missing', role: 'card', entries: [] }])
})

test('a card with no book and no binding lists nothing', async (t: TestContext) => {
  const store = await storeWith(t, { book: [entryJson(0, 'x')] })
  assert.deepEqual(await cardWorldbookDigest(cardWith({}), store), [])
})

test('the host’s minted name wins, and says that it is minted', async (t: TestContext) => {
  const store = await storeWith(t, { 'minted 2': [entryJson(0, 'from the mint')] })

  const books = await cardWorldbookDigest(cardWith({ world: 'wanted' }), store, 'minted 2')

  assert.equal(books[0]?.name, 'minted 2')
  assert.equal(books[0]?.materialised, true)
  assert.deepEqual(books[0]?.entries.map(entry => entry.name), ['from the mint'])
})

test('a name the host minted that equals the card’s own is not flagged', async (t: TestContext) => {
  const store = await storeWith(t, { same: [entryJson(0, 'x')] })

  const books = await cardWorldbookDigest(cardWith({ world: 'same' }), store, 'same')

  // Omitted rather than false: a materialisation that got the name it wanted is
  // invisible to the reader and should stay that way.
  assert.equal(Object.hasOwn(books[0] ?? {}, 'materialised'), false)
})

test('extra bindings follow the card’s own book, in stored order, without repeats', async (t: TestContext) => {
  const store = await storeWith(t, {
    own: [entryJson(0, 'own entry')],
    extra1: [entryJson(0, 'extra one')],
    extra2: [entryJson(0, 'extra two')],
  })

  const books = await cardWorldbookDigest(
    cardWith({ world: 'own' }),
    store,
    undefined,
    // `own` is named again as an extra, and `nowhere` has no file: the first is
    // upstream's first-occurrence rule, the second is a dangling extra.
    ['extra2', 'own', 'extra1', 'nowhere'],
  )

  assert.deepEqual(
    books.map(book => [book.name, book.source, book.role]),
    [
      ['own', 'named', 'card'],
      ['extra2', 'named', 'additional'],
      ['extra1', 'named', 'additional'],
      ['nowhere', 'missing', 'additional'],
    ],
  )
  assert.deepEqual(books[1]?.entries.map(entry => entry.name), ['extra two'])
})
