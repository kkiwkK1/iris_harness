import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { CharacterCard } from '@iris/character'

import {
  embeddedHash,
  materialiseEmbeddedBook,
  WorldbookBindingStore,
} from '../src/materialise.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

/**
 * Materialising a card's embedded book into a named one.
 *
 * SillyTavern's assembly layer reads one character-book channel — the bound
 * name — and an embedded book gets there by being materialised first, on an
 * explicit user action. Iris read the embedded book directly at assembly time,
 * which is a channel upstream does not have and the source of the duplication
 * the old "choose one" rule existed to hide.
 *
 * Two rules here are the ones that can destroy user data if wrong, and both are
 * pinned:
 *
 * - **Never overwrite a book this card did not materialise.** The link is the
 *   binding table, not the filename, so a colliding name gives way instead.
 *   Upstream is *less* careful here: `importEmbeddedWorldInfo` calls
 *   `saveWorldInfo(name, …, true)` and overwrites a same-named book silently,
 *   on a path where `skipPopup` is true. This is deliberately stricter.
 * - **Never overwrite a book the user edited.** Determined by comparing the
 *   file's bytes against the hash recorded when it was written.
 */

interface Fixture {
  dir: string
  worldbooks: WorldbookStore
  bindings: WorldbookBindingStore
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-mat-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return {
    dir,
    worldbooks: new WorldbookStore(join(dir, 'worlds')),
    bindings: new WorldbookBindingStore(join(dir, 'worldbook-bindings.json')),
  }
}

/** A card carrying an embedded book, and optionally a bound name. */
function cardWith(contents: readonly string[], world?: string): CharacterCard {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      ...world === undefined ? {} : { extensions: { world } },
      character_book: {
        entries: contents.map((content, index) => ({
          keys: ['k'], content, comment: `entry ${String(index)}`,
          enabled: true, constant: false, insertion_order: index, extensions: {},
        })),
      },
    },
  } as unknown as CharacterCard
}

test('a card with no bound name materialises under a minted one', async (t) => {
  const fixed = await fixture(t)
  const done = await materialiseEmbeddedBook('aria', cardWith(['lore']), fixed.worldbooks, fixed.bindings)

  assert.equal(done?.name, "Aria's Lorebook")
  assert.deepEqual(done?.reports, [])
  assert.deepEqual((await fixed.worldbooks.get("Aria's Lorebook")).map(e => e.content), ['lore'])
})

test('the card’s own name is used, so both hosts point at the same book', async (t) => {
  const fixed = await fixture(t)

  // Most cards already carry the name their embedded book should have — that is
  // SillyTavern's post-materialisation state recorded in the card, with the
  // book file simply never travelling alongside. Using it makes the two hosts
  // converge instead of inventing a parallel name.
  const done = await materialiseEmbeddedBook(
    'aria', cardWith(['lore'], 'Eldoria'), fixed.worldbooks, fixed.bindings)

  assert.equal(done?.name, 'Eldoria')
  assert.match(done?.reports[0] ?? '', /was not imported with it/u)
  assert.match(done?.reports[0] ?? '', /importing the original book will take precedence/u)
})

test('a colliding name gives way; the other card’s book is untouched', async (t) => {
  const fixed = await fixture(t)

  await materialiseEmbeddedBook('first', cardWith(['first card'], 'Shared'), fixed.worldbooks, fixed.bindings)
  const second = await materialiseEmbeddedBook(
    'second', cardWith(['second card'], 'Shared'), fixed.worldbooks, fixed.bindings)

  // The only path in this design that could destroy user data, closed by giving
  // up the name rather than the book. Upstream overwrites here, silently.
  assert.equal(second?.name, 'Shared (2)')
  assert.match(second?.reports[0] ?? '', /already the name of another world book/u)
  assert.deepEqual((await fixed.worldbooks.get('Shared')).map(e => e.content), ['first card'])
  assert.deepEqual((await fixed.worldbooks.get('Shared (2)')).map(e => e.content), ['second card'])
})

test('materialising twice is a no-op — the card has not changed', async (t) => {
  const fixed = await fixture(t)
  const card = cardWith(['lore'], 'Eldoria')

  const first = await materialiseEmbeddedBook('aria', card, fixed.worldbooks, fixed.bindings)
  const before = await readFile(join(fixed.dir, 'worlds', 'Eldoria.json'), 'utf8')

  const second = await materialiseEmbeddedBook('aria', card, fixed.worldbooks, fixed.bindings)
  const after = await readFile(join(fixed.dir, 'worlds', 'Eldoria.json'), 'utf8')

  assert.equal(second?.name, first?.name)
  assert.deepEqual(second?.reports, [], 'a quiet re-open reported something')
  assert.equal(after, before, 'an unchanged card rewrote its book')
})

test('a changed card re-materialises when nobody has edited the book', async (t) => {
  const fixed = await fixture(t)
  await materialiseEmbeddedBook('aria', cardWith(['v1'], 'Eldoria'), fixed.worldbooks, fixed.bindings)

  const done = await materialiseEmbeddedBook(
    'aria', cardWith(['v1', 'v2 added by the author'], 'Eldoria'), fixed.worldbooks, fixed.bindings)

  // No one's work is at risk here, so this is silent on purpose: a report on
  // the ordinary path is how an instrument teaches its reader to ignore it.
  assert.deepEqual(done?.reports, [])
  assert.deepEqual(
    (await fixed.worldbooks.get('Eldoria')).map(e => e.content),
    ['v1', 'v2 added by the author'],
  )
})

test('a changed card does NOT overwrite a book the user edited, and says so', async (t) => {
  const fixed = await fixture(t)
  await materialiseEmbeddedBook('aria', cardWith(['v1'], 'Eldoria'), fixed.worldbooks, fixed.bindings)

  // The user edits their book.
  await fixed.worldbooks.replace('Eldoria', [
    { uid: 0, name: 'mine', content: 'the user rewrote this', enabled: true },
  ])

  const done = await materialiseEmbeddedBook(
    'aria', cardWith(['v1', 'v2 from the author'], 'Eldoria'), fixed.worldbooks, fixed.bindings)

  // Both parties changed the same book legitimately, and merging would betray
  // both. Keep the user's, and say so — because the symptom of silently keeping
  // it ("I updated the card and nothing appeared") is indistinguishable from an
  // update that failed.
  assert.deepEqual((await fixed.worldbooks.get('Eldoria')).map(e => e.content), ['the user rewrote this'])
  assert.equal(done?.reports.length, 1)
  assert.match(done?.reports[0] ?? '', /has been updated, but you have/u)
  assert.match(done?.reports[0] ?? '', /left as it is/u)
})

test('an edited book is left alone while the card stays the same', async (t) => {
  const fixed = await fixture(t)
  const card = cardWith(['v1'], 'Eldoria')
  await materialiseEmbeddedBook('aria', card, fixed.worldbooks, fixed.bindings)
  await fixed.worldbooks.replace('Eldoria', [
    { uid: 0, name: 'mine', content: 'user text', enabled: true },
  ])

  const done = await materialiseEmbeddedBook('aria', card, fixed.worldbooks, fixed.bindings)

  // The user's book is authoritative; the embedded copy was only ever a seed.
  assert.deepEqual((await fixed.worldbooks.get('Eldoria')).map(e => e.content), ['user text'])
  assert.deepEqual(done?.reports, [])
})

test('the card-changed hash ignores array position but not insertion order', () => {
  /*
   * Two different notions of "reordered", and only one of them is a change.
   *
   * Moving an entry within the array while its `insertion_order` stays put is
   * not a content change — nothing about assembly differs — so it must not
   * trigger a rewrite that could collide with the user's edits. But
   * `insertion_order` itself decides where an entry lands in the prompt, so
   * changing *that* is a real change and must be seen as one.
   *
   * The first version of this test conflated the two: its fixture derived
   * `insertion_order` from the array index, so "reordering" silently changed
   * the orders as well and the assertion failed for the right reason.
   */
  const book = (entries: { content: string, order: number }[]): unknown => ({
    entries: entries.map(entry => ({
      keys: ['k'], content: entry.content, comment: entry.content,
      enabled: true, constant: false, insertion_order: entry.order, extensions: {},
    })),
  })

  const a = book([{ content: 'one', order: 0 }, { content: 'two', order: 1 }])
  const moved = book([{ content: 'two', order: 1 }, { content: 'one', order: 0 }])
  assert.equal(embeddedHash(a), embeddedHash(moved), 'array position alone was read as a change')

  const reordered = book([{ content: 'one', order: 1 }, { content: 'two', order: 0 }])
  assert.notEqual(embeddedHash(a), embeddedHash(reordered), 'a real order change was missed')

  const edited = book([{ content: 'one', order: 0 }, { content: 'three', order: 1 }])
  assert.notEqual(embeddedHash(a), embeddedHash(edited))
})

test('a card with no embedded book materialises nothing', async (t) => {
  const fixed = await fixture(t)
  const bare = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Bare' } } as unknown as CharacterCard

  assert.equal(await materialiseEmbeddedBook('bare', bare, fixed.worldbooks, fixed.bindings), undefined)
  assert.deepEqual(await fixed.worldbooks.names(), [])
})

test('an empty embedded book is not materialised into an empty file', async (t) => {
  const fixed = await fixture(t)

  // A book with no entries is indistinguishable from no book at assembly time,
  // and writing one would put a file on disk that only adds a name to collide
  // with later.
  assert.equal(
    await materialiseEmbeddedBook('aria', cardWith([]), fixed.worldbooks, fixed.bindings),
    undefined,
  )
  assert.deepEqual(await fixed.worldbooks.names(), [])
})

test('the binding survives a restart, because that is what makes it a link', async (t) => {
  const fixed = await fixture(t)
  await materialiseEmbeddedBook('aria', cardWith(['lore'], 'Eldoria'), fixed.worldbooks, fixed.bindings)

  const reopened = new WorldbookBindingStore(join(fixed.dir, 'worldbook-bindings.json'))
  const binding = await reopened.get('aria')
  assert.equal(binding?.name, 'Eldoria')
  assert.equal(binding?.origin, 'seeded-from-embedded')
  assert.equal(typeof binding?.sourceHash, 'string')
  assert.notEqual(binding?.sourceHash, binding?.materialisedHash, 'the two hashes answer different questions')
})

test('a book kept for one card is never claimed by another', async (t) => {
  const fixed = await fixture(t)
  await materialiseEmbeddedBook('first', cardWith(['a'], 'Book'), fixed.worldbooks, fixed.bindings)
  await fixed.bindings.forget('first')

  // Forgetting a binding leaves the file: the user may have edited it, and a
  // card going away is not a statement about their world info. So a second card
  // wanting that name still has to give way.
  const second = await materialiseEmbeddedBook(
    'second', cardWith(['b'], 'Book'), fixed.worldbooks, fixed.bindings)
  assert.equal(second?.name, 'Book (2)')
  assert.deepEqual((await fixed.worldbooks.get('Book')).map(e => e.content), ['a'])
})
