/**
 * The world book panel's grouping: this card first, the disk folded away.
 *
 * Three layers, kept apart because they can each fail without the others:
 *
 * 1. **`bookOwner`** — the one rule in this feature that is a rule rather than
 *    a layout, so it is a pure function and is tested as one. Both of its
 *    matches, and the miss, because the miss is what a reader sees for the
 *    fourteen books nobody claims.
 * 2. **The store's wiring** — the panel asks for counts, holds them, and does
 *    **not** blank the card's own book when an extra binding is toggled. That
 *    last one is a real seam: `worldbook.setCharBooks` does not answer `card`,
 *    and taking its answer wholesale would empty the top section on every
 *    click.
 * 3. **The panel's source** — the three states of the top section and the
 *    global fold's default. Source assertions, for the reason
 *    `character-page.test.ts` states at length: the panel is a `.tsx` module,
 *    Node's type stripping does not transform JSX, and no `node --test` file
 *    can import and render it. So this is evidence a branch was not deleted,
 *    not evidence it renders — `tools/render-check.tsx` is where all three are
 *    actually rendered, against the fake's seeded books.
 *
 * @module iris-web/tests/worldbook-panel
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type {
  CardWorldbookView,
  CharacterSummary,
  ChatView,
  IrisClient,
  WorldbookSummary,
} from '@iris/protocol'

import { bookOwner, createIrisStore } from '../src/client/store.ts'
import { DICTIONARIES, en, type StringKey } from '../src/app/i18n/strings.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL = readFileSync(join(HERE, '..', 'src', 'app', 'WorldbookPanel.tsx'), 'utf8')

/** The library the ownership rule resolves ids against. */
const LIBRARY: CharacterSummary[] = [
  { characterId: 'luoluo', name: '络络', tags: [] },
  { characterId: 'aria-vance', name: 'Aria Vance', tags: [] },
]

// ------------------------------------------------------------- bookOwner

test('a materialised book is owned by the card it was written out of', () => {
  const books: WorldbookSummary[] = [
    { name: '络络的世界 2.1', entryCount: 34, fromCharacterId: 'luoluo' },
  ]
  // No binding at all: the card's own `extensions.world` names something else
  // entirely, which is exactly the case the report came from — the host minted
  // a name when the wanted one collided.
  const bindings = [{ characterId: 'luoluo', primary: '络络的世界' }]
  assert.equal(bookOwner('络络的世界 2.1', books, bindings, LIBRARY), '络络')
})

test('a book nothing materialised is owned by the card whose binding names it', () => {
  // The ordinary imported-from-SillyTavern shape: the user made the book, then
  // bound it by hand, so this host has no provenance record and the name is the
  // only link there is.
  const books: WorldbookSummary[] = [{ name: "Aria's northern survey", entryCount: 12 }]
  const bindings = [{ characterId: 'aria-vance', primary: "Aria's northern survey" }]
  assert.equal(bookOwner("Aria's northern survey", books, bindings, LIBRARY), 'Aria Vance')
})

test('a book neither rule claims has no owner, and is not guessed at', () => {
  const books: WorldbookSummary[] = [{ name: '共享设定：雨季', entryCount: 7 }]
  // A binding is present, for a *different* book. A rule that matched loosely
  // would attribute the user's own shared book to whichever card happened to be
  // open, which is worse than saying nothing.
  const bindings = [{ characterId: 'luoluo', primary: '络络的世界' }]
  assert.equal(bookOwner('共享设定：雨季', books, bindings, LIBRARY), undefined)
})

test('provenance ends the search even when the owning card has left the library', () => {
  // Otherwise the fall-through would reach rule 2 and name a *different* card
  // as the owner of a book this host wrote out of a card it no longer holds.
  const books: WorldbookSummary[] = [{ name: 'orphan', entryCount: 1, fromCharacterId: 'deleted-card' }]
  const bindings = [{ characterId: 'luoluo', primary: 'orphan' }]
  assert.equal(bookOwner('orphan', books, bindings, LIBRARY), undefined)
})

// ----------------------------------------------------------------- store

/** A client answering the three reads the panel opens with. */
function panelClient(over: {
  books?: WorldbookSummary[]
  card?: unknown
} = {}): { client: IrisClient, calls: { method: string, params: Record<string, unknown> }[] } {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const client: IrisClient = {
    connected: true,
    onConnectionChange: () => () => undefined,
    subscribe: () => () => undefined,
    async call(method, params) {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'chat.list') return { chats: [] } as never
      if (method === 'character.list') return { characters: LIBRARY } as never
      if (method === 'settings.get') return { settings: { provider: 'p', model: 'm' } } as never
      if (method === 'worldbook.names') {
        return {
          names: ['a', 'b'],
          ...over.books === undefined ? {} : { books: over.books },
        } as never
      }
      if (method === 'worldbook.globalSelect') return { names: ['b'] } as never
      if (method === 'worldbook.settings') {
        return {
          settings: {
            scanDepth: 2,
            budgetPercent: 25,
            budgetCap: 0,
            minActivations: 0,
            minActivationsDepthMax: 0,
            maxRecursionSteps: 0,
            insertionStrategy: 'character_first',
            recursive: false,
            caseSensitive: false,
            matchWholeWords: false,
            includeNames: true,
            useGroupScoring: false,
          },
        } as never
      }
      if (method === 'worldbook.charNames') {
        return {
          primary: '络络的世界',
          additional: [],
          ...over.card === undefined ? {} : { card: over.card },
        } as never
      }
      if (method === 'worldbook.setCharBooks') return { primary: '络络的世界', additional: ['b'] } as never
      return {} as never
    },
  }
  return { client, calls }
}

/** The open conversation the binding is fetched for. */
const VIEW = {
  chatId: 'c1',
  title: 't',
  characterId: 'luoluo',
  createdAt: 0,
  updatedAt: 0,
  messages: [],
} as unknown as ChatView

test('the panel asks for entry counts, and holds the books it is given', async () => {
  const books: WorldbookSummary[] = [
    { name: 'a', entryCount: 34, fromCharacterId: 'luoluo' },
    { name: 'b', entryCount: 7 },
  ]
  const { client, calls } = panelClient({ books })
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })

  await store.getState().loadWorldbooks()

  const names = calls.find(row => row.method === 'worldbook.names')
  assert.ok(names, 'the panel did not list the books')
  assert.equal(
    names.params.withCounts,
    true,
    'the panel asked for names only, so no book can report its size',
  )
  assert.deepEqual(store.getState().worldbooks?.books, books)
})

test('a host that answers names without counts leaves the panel with no counts, not with zeros', async () => {
  // The opt-in half of the contract: `books` absent is "not asked / cannot
  // say", and a zero here would read as eighteen emptied books.
  const { client } = panelClient({})
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })

  await store.getState().loadWorldbooks()
  assert.deepEqual(store.getState().worldbooks?.books, [])
})

test('the card’s own book is held from worldbook.charNames', async () => {
  const card: CardWorldbookView = { name: '络络的世界 2.1', source: 'named', entryCount: 34, materialised: true }
  const { client, calls } = panelClient({ card })
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })
  store.setState({ view: VIEW })

  await store.getState().loadCharBooks()
  // Asked for, or the host answers names only: the card's book costs a file
  // read the names-only member deliberately does not charge, so the panel has
  // to say it wants it.
  const asked = calls.find(row => row.method === 'worldbook.charNames')
  assert.ok(asked, 'the panel did not ask for the character’s binding')
  assert.equal(asked.params.withCard, true, 'the panel asked for names only, so no book can be reported')
  assert.deepEqual(store.getState().charBooks?.card, card)
  // And the card file's own binding is still reported beside it, because the
  // two disagreeing is the fact the panel has to be able to explain.
  assert.equal(store.getState().charBooks?.primary, '络络的世界')
})

test('toggling an extra binding does not blank the card’s own book', async () => {
  /*
   * The seam this test exists for. `worldbook.setCharBooks` answers the
   * binding, not the card's book — it did not change it — so a store that took
   * the answer wholesale would drop `card` and empty the panel's first section
   * on every click. Held across the write instead.
   */
  const card: CardWorldbookView = { name: '络络的世界 2.1', source: 'named', entryCount: 34, materialised: true }
  const { client } = panelClient({ card })
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })
  store.setState({ view: VIEW })

  await store.getState().loadCharBooks()
  await store.getState().setCharBooks(['b'])

  assert.deepEqual(store.getState().charBooks?.additional, ['b'], 'the write did not land')
  assert.deepEqual(
    store.getState().charBooks?.card,
    card,
    'the top section lost the card’s book when an extra binding was toggled',
  )
})

test('a binding held for another character is not carried onto this one', async () => {
  // The same staleness rule the panel already applied to `additional`, now
  // covering `card`: a book count from the previous conversation shown under
  // this one's name would be a specific, believable lie.
  const card: CardWorldbookView = { name: 'X', source: 'named', entryCount: 9, materialised: false }
  const { client } = panelClient({ card })
  const { store } = createIrisStore(client, { transport: 'rpc', origin: 'test' })
  store.setState({
    view: VIEW,
    charBooks: { characterId: 'someone-else', primary: null, additional: [], card },
  })

  await store.getState().setCharBooks(['b'])
  assert.equal(
    store.getState().charBooks?.card,
    undefined,
    'a held answer for a different character reached this character’s section',
  )
})

// ---------------------------------------------------------------- source

/** The keys the panel's new sections render. */
const KEYS: readonly StringKey[] = [
  'worldbookThisCard',
  'worldbookEntryCount',
  'worldbookCardSourceNamed',
  'worldbookCardSourceEmbedded',
  'worldbookCardEmbeddedUnnamed',
  'worldbookCardNone',
  'worldbookCardMinted',
  'worldbookCardRule',
  'worldbookCardNotLoaded',
  'worldbookNoChat',
  'worldbookGlobalHead',
  'worldbookGlobalCount',
  'worldbookGlobalNone',
  'worldbookGlobalExpand',
  'worldbookGlobalCollapse',
  'worldbookFromCard',
  'worldbookCharBindCount',
]

test('the panel names every key its new sections need, in both languages', () => {
  for (const key of KEYS) {
    assert.match(PANEL, new RegExp(`t\\('${key}'`), `the panel no longer renders ${key}`)
    assert.ok(key in en, `${key} is not in the dictionary`)
    assert.ok(DICTIONARIES.zh[key].length > 0, `${key} has no Chinese`)
  }
})

test('the top section still branches on all three of the host’s answers', () => {
  // `named` and `embedded` are told apart, rather than both rendering as "a
  // book": which one it is decides whether the entries are on disk, and that is
  // the difference between "edit it here" and "open the chat once".
  assert.match(
    PANEL,
    /card\.source === 'named'[\s\S]{0,160}worldbookCardSourceEmbedded/,
    'the named and embedded states no longer render differently',
  )
  assert.match(
    PANEL,
    /card\.source === 'none'[\s\S]{0,120}worldbookCardNone/,
    'a card with no world book no longer gets its own sentence',
  )
  // And the two states that are not the host's answer at all: no conversation
  // open, and a host that keeps no books. Reporting either as `none` would be a
  // claim about a card rather than an admission about the situation.
  assert.match(
    PANEL,
    /characterId === undefined[\s\S]{0,120}worldbookNoChat/,
    'the panel no longer distinguishes "no conversation open"',
  )
  assert.match(
    PANEL,
    /card === undefined[\s\S]{0,700}worldbookCardNotLoaded/,
    'a host with no book store no longer gets its own sentence',
  )
})

test('the mechanism sentence is rendered, because the report was that nothing said it', () => {
  assert.match(PANEL, /t\('worldbookCardRule'\)/, 'the panel stopped saying how books are chosen')
  for (const language of ['en', 'zh'] as const) {
    const rule = DICTIONARIES[language].worldbookCardRule
    // The sentence has to carry both halves of the rule — this card's own book,
    // *plus* the global list — or it describes a mechanism the host does not
    // have. Checked as a length floor and a keyword rather than verbatim, so
    // the copy can be reworded without this going red for the wrong reason.
    assert.ok(rule.length > 30, `${language}'s rule sentence is too short to state both halves`)
  }
  assert.match(
    DICTIONARIES.zh.worldbookCardRule,
    /全局/,
    'the Chinese rule sentence no longer mentions the global books it adds',
  )
})

test('the global list is folded by default', () => {
  /*
   * The answer to "as cards pile up the books pile up and this squeezes them".
   * `useState(false)` is the whole mechanism, and it is asserted here because
   * flipping it to `true` is a one-character change that no other check in this
   * repository would notice — the render check asserts `aria-expanded="false"`,
   * which is the same fact seen from the outside.
   */
  assert.match(
    PANEL,
    /GlobalBooks[\s\S]{0,2000}useState\(false\)/,
    'the global book list no longer starts folded',
  )
  assert.match(PANEL, /aria-expanded=\{open\}/, 'the fold does not report its state to a reader')
})

test('the folded list is sorted by name, and the selection is not', () => {
  // Two different orders on purpose: the selection is in the order the user
  // built it (the host's stored order), and the rest of the disk is
  // alphabetical, because eighteen unfamiliar names cannot be scanned in
  // arbitrary order.
  assert.match(
    PANEL,
    /\.sort\(\(left, right\) => left\.localeCompare\(right\)\)/,
    'the folded book list is no longer sorted by name',
  )
})
