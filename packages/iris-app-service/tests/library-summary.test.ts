/**
 * What a library summary says about a card's *contents*.
 *
 * `CharacterSummary` grew three optional facts — a clipped `description`, the
 * embedded book's `bookEntryCount`, the card's `scriptCount` — so a character
 * page can show what a card is without the host shipping the card. Each one has
 * a rule about being **absent**, and absence is the interesting half: measured
 * over the 19 local cards, 15 carry no description, 2 embed no book and 5 carry
 * no scripts, so the branch that fires most often in the wild is the one that
 * sends nothing. These tests are written around that.
 *
 * The clip is asserted on a description whose 200th code point is astral,
 * because that is the only input where the correct implementation and the
 * obvious wrong one (`slice(0, 200)` over UTF-16 units) disagree.
 *
 * @module @iris/app-service/tests/library-summary
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { CharacterSummary } from '@iris/protocol'

import { CharacterLibrary } from '../src/library.ts'

/** A `.json` card body, V3-shaped, with only what a test overrides. */
function card(data: Record<string, unknown>): string {
  return JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Sable', description: '', tags: [], creator: '', ...data },
  })
}

/** A directory of cards, as a profile holds them. */
async function libraryOf(t: TestContext, files: Record<string, string>): Promise<CharacterLibrary> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-summary-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const characters = join(dir, 'characters')
  await mkdir(characters, { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(characters, name), text, 'utf8')
  return new CharacterLibrary(characters, '/iris/avatar')
}

/** The one summary a single-card library lists. */
async function only(library: CharacterLibrary): Promise<CharacterSummary> {
  const rows = await library.list()
  assert.equal(rows.length, 1, 'the fixture should hold exactly one readable card')
  return rows[0]!
}

/**
 * Two scripts under the object shape, one of them switched off by its author.
 *
 * The disabled one is deliberate: `scriptCount` counts what the card *contains*,
 * which is what `script.list` shows rows for, so a count that quietly dropped
 * the author's off switch would disagree with the panel beside it.
 */
const TWO_SCRIPTS = {
  tavern_helper: {
    scripts: [
      { id: 'a', name: 'core', content: 'console.log(1)', enabled: true },
      { id: 'b', name: 'extra', content: 'console.log(2)', enabled: false },
    ],
  },
}

test('a card with a book and scripts reports all three facts', async (t) => {
  const library = await libraryOf(t, {
    'sable.json': card({
      description: 'A lighthouse keeper.',
      character_book: { entries: [{ keys: ['a'] }, { keys: ['b'] }, { keys: ['c'] }], extensions: {} },
      extensions: TWO_SCRIPTS,
    }),
  })

  const summary = await only(library)
  assert.equal(summary.description, 'A lighthouse keeper.', 'a short description rides verbatim')
  assert.equal(summary.bookEntryCount, 3)
  assert.equal(summary.scriptCount, 2, 'a card-disabled script is still a script the card contains')
})

test('a plain V1 card carries a description and neither count', async (t) => {
  // No `spec`, no `data`: the flat V1 shape, which normalisation lifts. Such a
  // card has no `character_book` and no `extensions.tavern_helper`, so the two
  // counts must be *absent* rather than zero — the page renders no column for
  // them, and a zero would be a claim the card never made.
  const library = await libraryOf(t, {
    'kestrel.json': JSON.stringify({
      name: 'Kestrel',
      description: 'Keeps the harbour light.',
      personality: 'terse',
      first_mes: 'The lamp is lit.',
    }),
  })

  const summary = await only(library)
  assert.equal(summary.name, 'Kestrel')
  assert.equal(summary.description, 'Keeps the harbour light.')
  assert.equal('bookEntryCount' in summary, false, 'a V1 card was given a book it does not have')
  assert.equal('scriptCount' in summary, false, 'a V1 card was given a script count of any kind')
})

test('an empty description is dropped, an empty embedded book reports zero', async (t) => {
  /*
   * The asymmetry is the protocol's, and it is the point of this test. "No
   * description" and "an empty description" are the same fact about a card, so
   * the field goes. "No book" and "a book with nothing in it" are different
   * facts — one author shipped a book and emptied it — so the count stays and
   * says 0.
   */
  const library = await libraryOf(t, {
    'blank.json': card({ description: '', character_book: { entries: [], extensions: {} } }),
  })

  const summary = await only(library)
  assert.equal('description' in summary, false, 'a blank description reached the wire')
  assert.equal(summary.bookEntryCount, 0, 'an embedded empty book must be distinguishable from none')
})

test('a description is clipped to 200 code points without splitting a surrogate pair', async (t) => {
  // 199 plain characters, then one astral character, then filler. A clip over
  // UTF-16 units would cut this one in half and emit a lone high surrogate: it
  // survives JSON, structuredClone and the DOM, and renders as `�`.
  const astral = '𝔘'
  assert.equal(astral.length, 2, 'the fixture character must actually be a surrogate pair')
  const description = `${'a'.repeat(199)}${astral}${'b'.repeat(80)}`
  const library = await libraryOf(t, { 'long.json': card({ description }) })

  const summary = await only(library)
  const clipped = summary.description ?? ''
  assert.equal([...clipped].length, 200, 'the clip is counted in code points')
  assert.ok(clipped.endsWith(astral), 'the astral character at the boundary was dropped or split')
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped),
    false,
    'the clipped description carries a lone surrogate',
  )
})

test('a description at the limit is passed through unchanged', async (t) => {
  const description = 'x'.repeat(200)
  const library = await libraryOf(t, { 'exact.json': card({ description }) })
  assert.equal((await only(library)).description, description, 'a description exactly at the limit was touched')
})

test('the three fields are optional on the wire type', () => {
  /*
   * The protocol's acceptance, checked by the compiler rather than at run time:
   * `@iris/protocol` carries zod schemas for **requests** only — results are
   * types — so "the schema accepts this" means tsc accepts it. Both projects'
   * `tsc --noEmit` include this file.
   *
   * The rejection half is the `@ts-expect-error` below: if the field ever
   * accepts a string, that line stops being an error and the build fails here,
   * which is the only way a type-level negative can have teeth.
   */
  const bare = { characterId: 'a', name: 'A', tags: [] } satisfies CharacterSummary
  const full = {
    characterId: 'b',
    name: 'B',
    tags: [],
    description: 'x',
    bookEntryCount: 0,
    scriptCount: 3,
  } satisfies CharacterSummary
  // @ts-expect-error a count is a number; a numeric string is a different fact
  const wrong = { characterId: 'c', name: 'C', tags: [], bookEntryCount: '3' } satisfies CharacterSummary

  assert.equal('description' in bare, false)
  assert.equal(full.scriptCount, 3)
  assert.equal(wrong.bookEntryCount, '3')
})

const CORPUS = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user/characters`

test('the real corpus lists with all three facts, clipped and whole', {
  skip: !existsSync(CORPUS) && `no characters folder at ${CORPUS}; point IRIS_CORPUS at a SillyTavern install`,
}, async () => {
  const rows = await new CharacterLibrary(CORPUS, '/iris/avatar').list()
  assert.ok(rows.length >= 10, `expected a corpus of cards, listed ${String(rows.length)}`)

  /*
   * Floors rather than the measured counts (4, 17 and 14 of 19 as of
   * 2026-09-07). The exact numbers change when the install changes, and a test
   * pinning them fails on a correct change; what must not happen is a *clean
   * zero* — every field absent, which is what a wrong field name or a summary
   * that never reads the card would produce, and which no other assertion here
   * would notice.
   */
  const withDescription = rows.filter(row => row.description !== undefined)
  assert.ok(withDescription.length >= 1, 'no real card produced a description')
  assert.ok(rows.filter(row => row.bookEntryCount !== undefined).length >= 1, 'no real card produced a book count')
  assert.ok(rows.filter(row => row.scriptCount !== undefined).length >= 1, 'no real card produced a script count')

  // And every description that arrived obeys the clip. Measured: the four real
  // descriptions are 730, 779, 1744 and 2851 code points, so all of them are
  // clipped and this is not a vacuous check.
  for (const row of withDescription) {
    const description = row.description ?? ''
    assert.ok(
      [...description].length <= 200,
      `${row.characterId} sent ${String([...description].length)} code points`,
    )
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(description),
      false,
      `${row.characterId} sent a lone surrogate`,
    )
  }
  assert.ok(
    withDescription.some(row => [...(row.description ?? '')].length === 200),
    'no real description was long enough to be clipped, so the clip is untested here',
  )
})
