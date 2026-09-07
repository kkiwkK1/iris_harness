/**
 * The three content facts the fake reports about a card, and their agreement.
 *
 * `CharacterSummary` carries a clipped `description`, a `bookEntryCount` and a
 * `scriptCount`. A fake is only useful here if it is honest in two directions:
 *
 * - **against itself** — `character.list`'s `scriptCount` and `script.list`'s
 *   rows are two readings of one fact, and a fake where they disagree teaches
 *   the shell to tolerate a page that says "3 scripts" over a panel listing
 *   none;
 * - **against the host** — the description clip is the host's number, copied
 *   here because the browser bundle cannot import the host, and copied numbers
 *   go stale. The host's source is read below rather than remembered.
 *
 * The seeds also have to keep *differing* in which fields they carry: absence is
 * the common case in the wild (of 19 real cards, 15 have no description, 2 embed
 * no book, 5 carry no scripts), and a fake whose every card was complete would
 * leave the interface's absent branches unrendered.
 *
 * @module @iris/client-fake/tests/card-facts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { DESCRIPTION_POINTS, readCard } from '../src/card.ts'
import { FAKE_SCRIPTS, seedCharacters } from '../src/seed.ts'
import { testClient } from './helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_LIBRARY = join(HERE, '..', '..', 'iris-app-service', 'src', 'library.ts')

/** Build a PNG carrying one tEXt chunk, the way a character card does. */
function pngWithCard(keyword: string, json: string): string {
  const payload = Buffer.from(json, 'utf8').toString('base64')
  const body = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(payload, 'latin1')])

  const chunkOf = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    // The CRC is never read back — the fake's scanner walks lengths, not
    // checksums — so zeroes keep the fixture honest about what it is.
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkOf('IHDR', Buffer.alloc(13)),
    chunkOf('tEXt', body),
    chunkOf('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

test('the description clip is the host\'s number, read from the host', () => {
  // Parsed out of the source, not retyped: a retyped number is a third copy,
  // and the whole point of this assertion is that there is one.
  const text = readFileSync(HOST_LIBRARY, 'utf8')
  const match = /const DESCRIPTION_POINTS = (\d+)/.exec(text)
  assert.ok(match?.[1] !== undefined, `${HOST_LIBRARY} no longer declares DESCRIPTION_POINTS as a literal`)
  assert.equal(DESCRIPTION_POINTS, Number(match[1]), 'the fake clips descriptions at a different length than the host')
})

test('the seeded library covers all three fields, a mixed row, and none of them', () => {
  const [dense, mixed, bare] = seedCharacters()
  assert.ok(dense !== undefined && mixed !== undefined && bare !== undefined, 'the seed shrank below three cards')

  assert.ok(dense.description !== undefined && dense.description.length > 0)
  assert.ok(dense.bookEntryCount !== undefined && dense.bookEntryCount > 0)
  assert.equal(dense.scriptCount, FAKE_SCRIPTS.length, 'the dense card must claim the pack the fake can serve')

  assert.ok(mixed.description !== undefined, 'the mixed row lost its description')
  assert.equal(mixed.bookEntryCount, undefined, 'the mixed row is no longer mixed')
  assert.equal(mixed.scriptCount, undefined, 'the mixed row is no longer mixed')

  assert.equal(bare.description, undefined, 'the bare card grew a description')
  assert.equal(bare.bookEntryCount, undefined, 'the bare card grew a book count')
  assert.equal(bare.scriptCount, undefined, 'the bare card grew a script count')
})

test('every seeded description is already within the host clip', () => {
  // The fake stands in for a host, and a host never sends more than the clip.
  // A seed longer than this would put a page under a load no host produces.
  for (const row of seedCharacters()) {
    const points = [...(row.description ?? '')].length
    assert.ok(points <= DESCRIPTION_POINTS, `${row.characterId} seeds ${String(points)} code points`)
  }
})

test('scriptCount and script.list agree for every card the fake holds', async () => {
  /*
   * The invariant, over the whole library rather than one sampled card: the
   * count on the summary is the number of rows `script.list` answers with. It
   * is asserted in both directions by construction — a card with no count must
   * get an empty list, which is the state an imported card and a plain V1 card
   * are in, and the panel's "this card ships no scripts" branch exists for.
   */
  const client = testClient()
  const { characters } = await client.call('character.list', {})
  assert.ok(characters.length > 0, 'the seeded library is empty, so this test compares nothing')

  let withScripts = 0
  for (const row of characters) {
    const listed = await client.call('script.list', { characterId: row.characterId })
    assert.equal(
      listed.scripts.length,
      row.scriptCount ?? 0,
      `${row.characterId}: the page would say ${String(row.scriptCount ?? 0)} over a panel listing ${String(listed.scripts.length)}`,
    )
    if (listed.scripts.length > 0) withScripts += 1
  }
  // A floor on the sample: without this the loop above passes on a library where
  // every card carries no scripts, comparing 0 against 0 the whole way down.
  assert.ok(withScripts >= 1, 'no seeded card carries scripts, so the agreement was never tested')
})

test('an imported card reports the description and book it carries, clipped', async () => {
  const astral = '𝔘'
  const description = `${'a'.repeat(DESCRIPTION_POINTS - 1)}${astral}${'b'.repeat(40)}`
  const json = JSON.stringify({
    spec: 'chara_card_v3',
    data: {
      name: 'Imported',
      description,
      character_book: { entries: [{ keys: ['a'] }, { keys: ['b'] }] },
    },
  })

  const card = readCard('imported.png', pngWithCard('ccv3', json))
  assert.equal([...(card.description ?? '')].length, DESCRIPTION_POINTS, 'the clip is counted in code points')
  assert.ok(card.description?.endsWith(astral), 'the surrogate pair at the boundary was split or dropped')
  assert.equal(card.bookEntryCount, 2)

  const client = testClient()
  const { character } = await client.call('character.import', {
    filename: 'imported.png',
    content: pngWithCard('ccv3', json),
  })
  assert.equal(character.description, card.description, 'the import dropped what readCard found')
  assert.equal(character.bookEntryCount, 2)
  // Not guessed at: reading scripts correctly needs `@iris/script`, which this
  // package does not depend on, so the fake reports none rather than a number
  // it cannot stand behind — and its own script list agrees.
  assert.equal(character.scriptCount, undefined, 'the fake claimed a script count it cannot derive')
  const listed = await client.call('script.list', { characterId: character.characterId })
  assert.deepEqual(listed.scripts, [], 'an imported card was served the seeded script pack')
})

test('an imported card with an empty embedded book reports zero, with none reports nothing', () => {
  const empty = readCard('empty.png', pngWithCard('ccv3', JSON.stringify({
    spec: 'chara_card_v3',
    data: { name: 'Empty', character_book: { entries: [] } },
  })))
  // 0 rather than absent: the host's `normalizeBook` defaults `entries` in, so
  // a book object with nothing in it is an empty book on both sides.
  assert.equal(empty.bookEntryCount, 0)

  const none = readCard('none.png', pngWithCard('ccv3', JSON.stringify({
    spec: 'chara_card_v3',
    data: { name: 'None' },
  })))
  assert.equal(none.bookEntryCount, undefined)
  assert.equal(none.description, undefined, 'a card with no description text still produced one')
})
