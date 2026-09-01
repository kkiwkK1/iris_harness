import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { decodeCardPng, normalizeCard, type CharacterCard } from '@iris/character'

import { scanEntriesOf } from '../src/prompt.ts'
import { resolveCardWorldbook, WorldbookStore } from '../src/worldbooks.ts'

/**
 * Globally selected books reach every character.
 *
 * A **third source**, added to the character's own rather than chosen between —
 * which makes it the exception to this module's other rule. The embedded and
 * named books are two copies of one thing, so combining them duplicates; a
 * globally selected book is a different thing, and upstream concatenates it
 * (`world-info.js:4478`, `getSortedEntries`).
 *
 * The gap this closes was invisible for a while, and the way it hid is worth
 * recording: the selection lives at `settings.json` →
 * `world_info_settings.world_info.globalSelect`, and reading the top-level
 * `world_info` instead yields `undefined`, which reads as "nothing is globally
 * selected". That is a clean, plausible, wrong answer that produces no error and
 * no suspicious number — and nobody re-checks something already reported absent.
 * On the measured installation one book *is* selected, carrying 15 always-on
 * entries that 18 of 19 cards were not receiving.
 */

const CORPUS = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user`
const hasCorpus = existsSync(join(CORPUS, 'worlds'))

const entryJson = (uid: number, comment: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uid, key: [], keysecondary: [], comment, content: `${comment} body`,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid, ...extra,
})

const cardWith = (world?: string): CharacterCard => normalizeCard({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: '', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: world === undefined ? {} : { world },
  },
})

async function storeWith(books: Record<string, string[]>): Promise<WorldbookStore> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-global-'))
  await mkdir(join(dir, 'worlds'), { recursive: true })
  for (const [name, comments] of Object.entries(books)) {
    await writeFile(
      join(dir, 'worlds', `${name}.json`),
      JSON.stringify({ entries: Object.fromEntries(comments.map((c, i) => [i, entryJson(i, c)])) }),
      'utf8',
    )
  }
  return new WorldbookStore(join(dir, 'worlds'))
}

test('a globally selected book reaches a card that binds something else', async () => {
  const store = await storeWith({ Own: ['own entry'], Shared: ['shared entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, ['Shared'])

  assert.equal(resolved.source, 'named')
  assert.deepEqual(resolved.entries.map(e => e.comment), ['own entry'])
  assert.deepEqual(resolved.global.map(book => book.world), ['Shared'])

  // Added, not chosen between — the opposite of the embedded/named rule.
  const scanned = scanEntriesOf(undefined, resolved)
  assert.deepEqual(scanned.map(e => e.comment).sort(), ['own entry', 'shared entry'])
})

test('each book keeps its own name, because getwi matches on it', async () => {
  const store = await storeWith({ Own: ['own entry'], Shared: ['shared entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, ['Shared'])
  const scanned = scanEntriesOf(undefined, resolved)

  // Attribution, not decoration. Flattening these under one `world` would make
  // `getwi('Shared', …)` miss and `getwi('Own', …)` match too much.
  assert.equal(scanned.find(e => e.comment === 'own entry')?.world, 'Own')
  assert.equal(scanned.find(e => e.comment === 'shared entry')?.world, 'Shared')
})

test('the character’s own book comes first', async () => {
  const store = await storeWith({ Own: ['own entry'], Shared: ['shared entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, ['Shared'])

  // `world_info_character_strategy = 1` (`character_first`) on the measured
  // installation. Order decides activation ties, so it is behaviour rather than
  // presentation. Both entries share `order: 100`, so only the source order
  // separates them.
  assert.deepEqual(scanEntriesOf(undefined, resolved).map(e => e.comment), ['own entry', 'shared entry'])
})

test('a card binding a globally selected book does not get it twice', async () => {
  const store = await storeWith({ Shared: ['shared entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Shared'), store, ['Shared'])

  // Upstream's dedup (`world-info.js:4387`): the character path is skipped for a
  // book already active globally. Without it this card gets every entry twice —
  // the same duplication failure this module exists to prevent, arriving from a
  // second direction.
  assert.deepEqual(resolved.entries, [])
  assert.deepEqual(scanEntriesOf(undefined, resolved).map(e => e.comment), ['shared entry'])
})

test('a selected book that no longer exists is skipped, not fatal', async () => {
  const store = await storeWith({ Own: ['own entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, ['deleted book'])

  // A user can delete a book without clearing the selection. Upstream's
  // `loadWorldInfo` returns nothing and contributes no entries; refusing to open
  // the chat would be stricter than the thing being reproduced.
  assert.deepEqual(resolved.global, [])
  assert.deepEqual(scanEntriesOf(undefined, resolved).map(e => e.comment), ['own entry'])
})

test('no selection leaves every card exactly as it was', async () => {
  const store = await storeWith({ Own: ['own entry'], Shared: ['shared entry'] })
  const before = await resolveCardWorldbook(cardWith('Own'), store, [])
  assert.deepEqual(before.global, [])
  assert.deepEqual(scanEntriesOf(undefined, before).map(e => e.comment), ['own entry'])
})

// ---------------------------------------------------------------- corpus facts

test('the measured selection reaches every card but is not doubled', { skip: !hasCorpus }, async () => {
  const settings = JSON.parse(await readFile(join(CORPUS, 'settings.json'), 'utf8')) as {
    world_info_settings?: { world_info?: { globalSelect?: string[] } }
  }
  const selection = settings.world_info_settings?.world_info?.globalSelect ?? []
  assert.ok(selection.length > 0, 'the installation selects no book — this acceptance case has nothing to measure')

  const store = new WorldbookStore(join(CORPUS, 'worlds'))
  const dir = join(CORPUS, 'characters')

  /** Entries that are injected on every turn regardless of what was said. */
  const alwaysOn = async (card: CharacterCard, global: readonly string[]): Promise<number> =>
    scanEntriesOf(undefined, await resolveCardWorldbook(card, store, global))
      .filter(entry => entry.constant && !entry.disable).length

  let gained = 0
  let unchanged = 0
  const deltas = new Set<number>()

  for (const file of await readdir(dir)) {
    let card: CharacterCard
    try {
      card = file.endsWith('.png')
        ? normalizeCard(decodeCardPng(await readFile(join(dir, file))))
        : file.endsWith('.json')
          ? normalizeCard(JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown)
          : (() => { throw new Error('not a card') })()
    } catch { continue }

    const delta = await alwaysOn(card, selection) - await alwaysOn(card, [])
    const binds = selection.includes(String(card.data.extensions?.['world'] ?? ''))

    if (binds) {
      // The strongest assertion available, and the reason it is: this card
      // already had the book through its binding. A dedup that failed would show
      // here as a positive delta, and nowhere else — every other card gains
      // legitimately, so only this one can tell a fix from a duplication.
      assert.equal(delta, 0, `${file} binds a globally selected book and gained entries — the dedup failed`)
      unchanged += 1
    } else {
      assert.ok(delta > 0, `${file} gained nothing from the global selection`)
      gained += 1
      deltas.add(delta)
    }
  }

  // Measured 2026-09-02: one book selected (尸变纪元 v0.5（NSFW）), 15 always-on
  // entries, 18 cards gaining exactly 15 and 1 unchanged. Asserted as "every
  // gaining card gains the same amount" rather than as 15, because the number
  // changes when the user edits that book and the property does not.
  assert.equal(deltas.size, 1, `cards gained differing amounts: ${[...deltas].join(', ')}`)
  assert.ok(gained > 0 && unchanged > 0, `gained ${String(gained)}, unchanged ${String(unchanged)}`)
})
