import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { decodeCardPng, normalizeCard, type CharacterCard } from '@iris/character'
import { fromCharacterBook } from '@iris/lorebook'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { resolveCardWorldbook, WorldbookStore } from '../src/worldbooks.ts'

/**
 * A card's world info comes from **one** book, chosen — never from both merged.
 *
 * The rule and the reason, because the reason is what makes the rule
 * non-obvious. SillyTavern's embedded `character_book` is an *import-time*
 * source: `world-info.js:5618` prompts the user, converts it, saves it as a
 * named book and binds it back onto the card, after which
 * `world-info.js:4363 getCharacterLore()` reads named books only and never looks
 * at `character_book` again. So on a real installation the bound book **is** the
 * embedded book, copied — and a host that reads both puts every entry in the
 * prompt twice.
 *
 * That failure is the reason these tests exist rather than a count. Duplication
 * does not throw, does not show in a diff, and reaches a reader as a model that
 * has started repeating itself — attributed to the model, or to the preset, or
 * to anything except the assembly step that caused it.
 *
 * The corpus checks below are written as **properties**, not as the measured
 * numbers. "This card gains 19 entries" stops being true the moment someone
 * edits that book; "a card with no embedded book reads its bound book, and a
 * card with both reads exactly one of them" stays true.
 */

const CORPUS = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user`
const hasCorpus = existsSync(join(CORPUS, 'worlds'))

/** Content identity, because importing a book re-keys every uid. */
const fingerprint = (entry: { comment: string, content: string }): string =>
  `${entry.comment}\u0000${entry.content}`

const entryJson = (uid: number, comment: string, content: string): Record<string, unknown> => ({
  uid, key: [], keysecondary: [], comment, content,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid,
})

const cardWith = (options: { world?: string, embedded?: string[] }): CharacterCard =>
  normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: options.world === undefined ? {} : { world: options.world },
      ...options.embedded === undefined ? {} : {
        character_book: {
          entries: options.embedded.map((text, index) => ({
            keys: [], content: text, comment: text, enabled: true,
            constant: false, insertion_order: index, extensions: {},
          })),
        },
      },
    },
  })

async function storeWith(books: Record<string, string[]>): Promise<WorldbookStore> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-src-'))
  await mkdir(join(dir, 'worlds'), { recursive: true })
  for (const [name, texts] of Object.entries(books)) {
    await writeFile(
      join(dir, 'worlds', `${name}.json`),
      JSON.stringify({
        entries: Object.fromEntries(texts.map((text, i) => [i, entryJson(i, text, text)])),
      }),
      'utf8',
    )
  }
  return new WorldbookStore(join(dir, 'worlds'))
}

// ------------------------------------------------------------ the three rules

test('a binding that resolves wins over the embedded book', async () => {
  const store = await storeWith({ Eldoria: ['named A', 'named B'] })
  const resolved = await resolveCardWorldbook(cardWith({ world: 'Eldoria', embedded: ['old A'] }), store)

  // Upstream's semantics, and also the copy the user edits: when the two
  // disagree it is because the named one was changed after the import.
  assert.equal(resolved.source, 'named')
  assert.equal(resolved.world, 'Eldoria')
  assert.deepEqual(resolved.entries.map(e => e.content), ['named A', 'named B'])
})

test('the two sources are never combined', async () => {
  const store = await storeWith({ Eldoria: ['shared', 'named only'] })
  const resolved = await resolveCardWorldbook(
    cardWith({ world: 'Eldoria', embedded: ['shared', 'embedded only'] }),
    store,
  )

  // The failure this guards is duplication, so it is asserted as an absence:
  // nothing from the book that lost. A union would be 4 entries here and 2246
  // across the corpus, 1122 of them the same text twice.
  assert.equal(resolved.entries.length, 2)
  assert.equal(resolved.entries.some(e => e.content === 'embedded only'), false)
})

test('a binding with no file behind it resolves to nothing — assembly reads one channel', async () => {
  const store = await storeWith({ Somewhere: ['unrelated'] })
  const resolved = await resolveCardWorldbook(
    cardWith({ world: 'no such book', embedded: ['still playable'] }),
    store,
  )

  /*
   * This test asserted the opposite until 2026-09-03, and the reversal is the
   * point. Reading the embedded book here was a **second assembly channel that
   * upstream does not have**: SillyTavern's `getCharacterLore` reads only the
   * bound name, and an embedded book reaches assembly only after being
   * materialised into a named book. The duplication the old "choose one" rule
   * guarded against — 1122 of 2246 entries — was produced by that second
   * channel and by nothing else.
   *
   * So the embedded book is not lost; it is materialised *before* resolution
   * runs, and by the time this function is asked the card is bound to a real
   * named book. That happens on the import and open paths, not here — see
   * `materialise.ts`. This function's job is now exactly upstream's: one
   * channel, the bound name.
   */
  assert.equal(resolved.source, 'none')
  assert.deepEqual(resolved.entries, [])
})

test('a materialised binding outranks the name written on the card', async () => {
  const store = await storeWith({ 'Aria (2)': ['the materialised copy'] })

  // When the wanted name collided, materialisation minted a different one and
  // recorded it. The binding table is the link between card and book, so it is
  // what resolution follows — the card's own `extensions.world` may name a book
  // belonging to someone else entirely.
  const resolved = await resolveCardWorldbook(
    cardWith({ world: 'Eldoria', embedded: ['unused now'] }),
    store,
    [],
    'Aria (2)',
  )

  assert.equal(resolved.source, 'named')
  assert.equal(resolved.world, 'Aria (2)')
  assert.deepEqual(resolved.entries.map(e => e.content), ['the materialised copy'])
})

test('a card with no books at all resolves to nothing, not to an error', async () => {
  const store = await storeWith({})
  const resolved = await resolveCardWorldbook(cardWith({}), store)
  assert.deepEqual(resolved, { entries: [], source: 'none', world: 'Aria', global: [] })

  // A host with no store has nowhere to materialise into and therefore no
  // world-info channel at all. It answers empty rather than throwing on every
  // chat it opens — but it does not quietly fall back to the embedded book,
  // because that is the second channel this change removed.
  const noStore = await resolveCardWorldbook(cardWith({ world: 'Eldoria', embedded: ['x'] }), undefined)
  assert.equal(noStore.source, 'none')
})

// ---------------------------------------------------------------- corpus facts

test('choosing changes nothing for cards whose two books agree', { skip: !hasCorpus }, async () => {
  const store = new WorldbookStore(join(CORPUS, 'worlds'))
  const dir = join(CORPUS, 'characters')

  let agreed = 0
  let gained = 0
  let needsMaterialising = 0

  for (const file of await readdir(dir)) {
    let card: CharacterCard
    try {
      card = file.endsWith('.png')
        ? normalizeCard(decodeCardPng(await readFile(join(dir, file))))
        : file.endsWith('.json')
          ? normalizeCard(JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown)
          : (() => { throw new Error('not a card') })()
    } catch { continue }

    const resolved = await resolveCardWorldbook(card, store)
    const embedded = card.data.character_book === undefined
      ? []
      : Object.values(fromCharacterBook(card.data.character_book).entries)

    const before = new Set(embedded.map(fingerprint))
    const after = new Set(resolved.entries.map(fingerprint))

    if (embedded.length > 0 && resolved.source === 'named') {
      // The claim the ruling asked to be pinned: for a card whose named book is
      // the imported copy of its embedded book, choosing between them is a
      // no-op. Most of the corpus is this case, and "nothing changed" is the
      // strongest evidence that the choice was made correctly — a wrong choice
      // here would be visible as content appearing or vanishing.
      const identical = after.size === before.size && [...after].every(key => before.has(key))
      if (identical) agreed += 1

      // Compared against the named book itself, read independently. The two
      // assertions this replaced were tautologies — `x <= max(y, x)` and a
      // difference guaranteed by the enclosing condition — so they passed for
      // every possible implementation, including a union. Checking against the
      // book that was supposed to win is the claim that actually has content.
      // `read`, not `get`: `get` returns the card-facing shape, where the title
      // is `name` rather than `comment`, so fingerprinting it hashed every entry
      // as `undefined` and reported the whole embedded book as unmatched. The
      // same "one entity, two namings" trap the fingerprint was built to survive
      // — it only survives it when both sides are the same shape.
      const namedBook = await store.read(String(card.data.extensions?.['world']))
      const named = Object.values(namedBook.entries)
      assert.equal(
        resolved.entries.length,
        named.length,
        `${file} did not resolve to exactly its named book`,
      )
      const namedKeys = new Set(named.map(fingerprint))
      const onlyEmbedded = [...before].filter(key => !namedKeys.has(key))
      for (const key of onlyEmbedded) {
        assert.equal(
          after.has(key),
          false,
          `${file} kept an entry that exists only in the embedded book — that is the union`,
        )
      }
    }
    if (embedded.length === 0 && resolved.entries.length > 0) gained += 1
    // Cards whose binding does not resolve but which carry an embedded book:
    // before 2026-09-03 these were read through the second assembly channel.
    // Now they resolve to nothing *here* and are covered by materialisation on
    // the import and open paths instead — so this counts the exact set that
    // migration has to reach, which is a sharper claim than the old one.
    if (resolved.source === 'none' && embedded.length > 0) needsMaterialising += 1
  }

  // Measured 2026-09-02: 14 agreed, 1 gained (19 entries), 2 previously fell
  // back (102 and 153 entries) and are now the materialisation set. Asserted as
  // "the buckets are non-empty and the majority is unchanged", because the
  // numbers move when the user edits a book and the shape does not.
  assert.ok(agreed > 0, 'no card had its two books agree — the import relationship may have changed')
  assert.ok(gained > 0, 'no card gained a book it could not previously read')
  assert.ok(
    needsMaterialising > 0,
    'no card needs materialising — either the corpus changed or resolution is still reading embedded books',
  )
})

test('the chosen book reaches prompt assembly, not just the resolver', async () => {
  // The resolver being right is worth nothing if nothing calls it. This is the
  // end-to-end claim: a card whose only world info is in a named book gets that
  // book's constant entry into its itemization — which, before this change,
  // was unreachable because assembly read `character_book` and that card has
  // none.
  const dir = await mkdtemp(join(tmpdir(), 'iris-src-e2e-'))
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(
    join(dir, 'characters', 'aria.json'),
    JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: 'Aria', description: 'A cartographer.', personality: '', scenario: '',
        first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
        post_history_instructions: '', alternate_greetings: [], tags: [],
        creator: '', character_version: '1',
        // Bound, with no embedded book at all — the corpus's one real gap.
        extensions: { world: 'Eldoria' },
      },
    }),
    'utf8',
  )
  await writeFile(
    join(dir, 'worlds', 'Eldoria.json'),
    JSON.stringify({
      entries: {
        0: { ...entryJson(0, 'Tower', 'The maps are in the west tower.'), constant: true },
      },
    }),
    'utf8',
  )

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const chats = new ChatStore(join(dir, 'chats'), library, undefined, undefined, worldbooks)
  const handlers = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } as never,
    library, chats, worldbooks,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const { itemization } = await handlers['prompt.itemize']({ chatId: created.view.chatId })

  // Matched on the item, not on its text: an itemization reports labels and
  // token counts, never content. The first version of this assertion searched
  // for the entry's words and failed against working code — the wiring was
  // right and the assertion's premise was wrong.
  const worldInfo = itemization.entries.filter(item => item.id.startsWith('worldInfo.'))
  assert.equal(worldInfo.length, 1, 'the named book never reached assembly')
  assert.ok((worldInfo[0]?.tokens ?? 0) > 0, 'the world info item is empty')

  // The contrast that gives the above its teeth: the same card and the same
  // chat with no book store behind them produce no world info item at all.
  // Without this, an assembly that emitted a world info item for some unrelated
  // reason would satisfy the check.
  const blindChats = new ChatStore(join(dir, 'chats-blind'), library)
  const blind = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } as never,
    library, chats: blindChats,
    settings: new SettingsStore(join(dir, 'settings-blind.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()
  const other = await blind['chat.create']({ characterId: 'aria' })
  const without = await blind['prompt.itemize']({ chatId: other.view.chatId })
  assert.deepEqual(
    without.itemization.entries.filter(item => item.id.startsWith('worldInfo.')),
    [],
    'a host with no book store still produced world info — the check above proves nothing',
  )
})
