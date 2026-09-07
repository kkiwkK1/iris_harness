/**
 * The library filter searches the description too, and survives its absence.
 *
 * `CharacterSummary.description` arrived after the search box did, so the box
 * matched names and tags only — a reader who remembers what a card *is* but not
 * what it is called got nothing. The two cases that matter are here: a query
 * that can only be answered by the description, and a card that carries none,
 * which is the majority case (15 of the 19 local cards) and therefore the
 * branch that runs on almost every keystroke.
 *
 * @module iris-web/tests/library-search
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import type { CharacterSummary } from '@iris/protocol'

import { matchesLibraryQuery } from '../src/app/library-search.ts'

/** A card carrying all three searchable fields. */
const described: CharacterSummary = {
  characterId: 'luoluo',
  name: '络络',
  tags: ['原创', '都市'],
  description: '巷口修灯的人。工具箱里没有一把是买来的。',
}

/** A plain V1 card: no description at all, which is the common shape. */
const bare: CharacterSummary = {
  characterId: 'the-archivist',
  name: 'The Archivist',
  tags: ['original', 'mystery'],
}

test('the fixture keeps the words apart, or nothing below discriminates', () => {
  /*
   * Every assertion here rests on 修灯 appearing *only* in the description. If a
   * later edit put it in the name or a tag, the description case below would go
   * on passing while testing the name matcher — the failure mode where a green
   * test has quietly changed subject.
   */
  assert.ok(described.description?.includes('修灯'))
  assert.equal(described.name.includes('修灯'), false)
  assert.equal(described.tags.some(tag => tag.includes('修灯')), false)
})

test('a query only the description can answer finds the card', () => {
  assert.equal(matchesLibraryQuery(described, '修灯'), true)
})

test('a card with no description is filtered, not crashed', () => {
  /*
   * The field is optional and usually absent, so this is the path taken by the
   * whole library on a query that misses. `?.` rather than a truthiness test:
   * the protocol drops the key when a card's description is empty, and an
   * absent key must read as "no match", never as an exception on keystroke one.
   */
  assert.equal(matchesLibraryQuery(bare, '修灯'), false)
  assert.equal(matchesLibraryQuery(bare, 'archivist'), true)
})

test('matching is case-folded on both sides, in all three fields', () => {
  const english: CharacterSummary = {
    characterId: 'aria-vance',
    name: 'Aria Vance',
    tags: ['Nautical'],
    description: 'Harbour pilot, third generation.',
  }
  assert.equal(matchesLibraryQuery(english, 'ARIA'), true)
  assert.equal(matchesLibraryQuery(english, 'nautical'), true)
  assert.equal(matchesLibraryQuery(english, 'HARBOUR'), true)
})

test('a match in any field is the same match: no field is weighted or excluded', () => {
  // The function answers a boolean on purpose. A score would let the description
  // rank a row below a name hit, moving rows for a reason nothing on screen
  // explains while the list is already sorted by the reader's chosen order.
  for (const needle of ['络络', '都市', '修灯']) {
    assert.equal(matchesLibraryQuery(described, needle), true, `${needle} should match`)
  }
})

test('a blank or whitespace query shows the whole library', () => {
  for (const query of ['', '   ', '\t']) {
    assert.equal(matchesLibraryQuery(described, query), true)
    assert.equal(matchesLibraryQuery(bare, query), true)
  }
})

test('a substring inside the description matches, not only its opening', () => {
  // Prefix matching was never the rule for names, and the description is the
  // field where it would bite hardest — its first words are a scene, not a name.
  assert.equal(matchesLibraryQuery(described, '工具箱'), true)
})

test('the sidebar routes its filter through this function', () => {
  /*
   * Without this, everything above could pass over a module the interface no
   * longer calls — the filter would be back inline in the component, untested,
   * and the suite would be green about dead code. Source-pinned because Node
   * cannot import the `.tsx` to ask it.
   */
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'Sidebar.tsx'),
    'utf8',
  )
  assert.match(source, /matchesLibraryQuery\(character, libraryQuery\)/, 'the library list is filtered elsewhere')
  assert.ok(
    !source.includes('character.name.toLowerCase().includes('),
    'an inline name/tag filter is back in the sidebar, so this module may not be what the reader sees',
  )
})
